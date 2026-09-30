/**
 * Usage ledger – the source of truth for metered usage. Append only (DB trigger): a correction is an adjustment /
 * credit row pointing at the original. One CHARGE per idempotency key – a retried operation is never billed twice;
 * extra provider cost of a retry is a separate non-billable "cost_only" row. Provider cost and customer price are
 * separate columns; a service without a rate is "unrated" (price null) – never shown as free. Usage the customer
 * pays the provider for directly (e.g. Meta for the business's own WhatsApp account) is recorded as not billable.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { parseRates, publishedVersion, rateOf, versionById } from "./pricebook";
import { smsMetrics } from "@/lib/sms";

export interface UsageInput {
  businessId: string; userId?: string | null; module: string; service: string; provider?: string | null; providerRef?: string | null;
  idempotencyKey: string; occurredAt: Date; unit: string; quantity: number; billedQuantity?: number | null;
  providerCostMinor?: number | null; providerCurrency?: string | null; status?: "estimated" | "final" | "failed" | "not_billable";
  billedByProvider?: boolean; details?: Record<string, unknown>; kind?: "charge" | "cost_only";
}

const rateCache = new Map<string, { at: number; v: { version: number; currency: string; rates: ReturnType<typeof parseRates> } | null }>();
/** The rates that apply to a business: its subscription's price book version (or the published one for the unsubscribed). */
export async function ratesFor(businessId: string) {
  const hit = rateCache.get(businessId); if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const sub = await db.subscription.findUnique({ where: { businessId }, select: { priceBookVersionId: true } });
  const v = sub?.priceBookVersionId ? await versionById(sub.priceBookVersionId) : await publishedVersion();
  // Custom usage rates of this business (platform admin) replace the price-book rate for usage recorded from now on.
  const custom = await (await import("./pricing")).termsAt(businessId);
  const base = v ? parseRates(v.usageRates) : [];
  const { USAGE_SERVICES } = await import("./pricebook");
  const rates = [
    ...base.map((r) => (custom.terms.usageRates[r.service] !== undefined ? { ...r, unitPriceMinor: custom.terms.usageRates[r.service] } : r)),
    // A service the price book doesn't price yet, priced for this business only.
    ...Object.entries(custom.terms.usageRates).filter(([svc]) => !base.some((r) => r.service === svc)).map(([svc, p]) => ({ service: svc, unit: USAGE_SERVICES.find((x) => x.service === svc)?.unit ?? "unit", unitPriceMinor: p })),
  ];
  const val = v ? { version: v.version, currency: v.currency, rates, ...(custom.version ? { pricingVersion: custom.version } : {}) } : null;
  rateCache.set(businessId, { at: Date.now(), v: val });
  return val;
}
export function invalidateRates(businessId?: string) { if (businessId) rateCache.delete(businessId); else rateCache.clear(); }

/** Record usage once per key. Returns true when a row was written (false = already recorded – not charged again). */
export async function recordUsage(u: UsageInput) {
  const r = await ratesFor(u.businessId);
  const rate = r ? rateOf(r.rates, u.service) : null;
  const billedQty = u.billedQuantity ?? u.quantity;
  const billable = u.kind !== "cost_only" && !u.billedByProvider && u.status !== "not_billable" && u.status !== "failed";
  const priceMinor = billable && rate ? Math.round(rate.unitPriceMinor! * billedQty) : null;
  const status = u.kind === "cost_only" ? "not_billable" : !billable ? (u.status ?? "not_billable") : rate ? u.status ?? "estimated" : "unrated";
  const res = await db.usageEvent.createMany({ data: [{
    businessId: u.businessId, userId: u.userId ?? null, module: u.module, service: u.service, provider: u.provider ?? null, providerRef: u.providerRef ?? null,
    idempotencyKey: u.idempotencyKey.slice(0, 300), kind: u.kind ?? "charge", occurredAt: u.occurredAt, unit: u.unit,
    quantity: new Prisma.Decimal(u.quantity), billedQuantity: u.billedQuantity !== undefined && u.billedQuantity !== null ? new Prisma.Decimal(u.billedQuantity) : null,
    priceBookVersion: r?.version ?? null, currency: r?.currency ?? "ILS", providerCostMinor: u.providerCostMinor ?? null, providerCurrency: u.providerCurrency ?? null,
    priceMinor, status, billedByProvider: Boolean(u.billedByProvider), details: { ...(u.details ?? {}), ...(r && "pricingVersion" in r && r.pricingVersion ? { businessPricingVersion: r.pricingVersion } : {}) } as Prisma.InputJsonValue,
  }], skipDuplicates: true });
  if (res.count && priceMinor) await (await import("./budget")).checkBudgetAlerts(u.businessId).catch(() => undefined);
  return res.count > 0;
}

/** A correction: a new row with the quantity / price difference (the original is never edited). */
export async function adjustUsage(originalId: string, input: { quantityDelta: number; priceDeltaMinor: number | null; reason: string; key: string; kind?: "adjustment" | "credit" }) {
  const o = await db.usageEvent.findUniqueOrThrow({ where: { id: originalId } });
  return db.usageEvent.createMany({ data: [{ businessId: o.businessId, userId: o.userId, module: o.module, service: o.service, provider: o.provider, providerRef: o.providerRef, idempotencyKey: input.key, kind: input.kind ?? "adjustment", occurredAt: new Date(), unit: o.unit, quantity: new Prisma.Decimal(input.quantityDelta), priceBookVersion: o.priceBookVersion, currency: o.currency, priceMinor: input.priceDeltaMinor, status: input.kind === "credit" ? "credited" : "final", correctsEventId: o.id, details: { reason: input.reason } }], skipDuplicates: true });
}

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const period = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Metering sweep (cron, idempotent): records what happened – calls (billed minutes with the rate's billing increment),
 * recordings, transcription, AI summaries (including ones that arrive after the call), messages by channel,
 * AI assistant actions and monthly phone numbers. Keys make re-runs and late data safe.
 */
export async function meterBusiness(businessId: string, since = new Date(Date.now() - 3 * 86400_000)) {
  const r = await ratesFor(businessId);
  const inc = (svc: string) => (r ? rateOf(r.rates, svc)?.billingIncrementSec ?? 60 : 60);
  let n = 0;
  const calls = await db.call.findMany({ where: { businessId, endedAt: { gte: since } }, select: { id: true, idempotencyKey: true, userId: true, provider: true, agentLegId: true, leadLegId: true, answeredAt: true, endedAt: true, talkSeconds: true, direction: true, toE164: true, recordingStatus: true, recordingDurationMs: true, coachSession: { select: { sttSeconds: true, documentationStatus: true, documentedAt: true } } } });
  const { settleReservation } = await import("./budget");
  for (const c of calls) {
    // The call ended: its budget hold stops counting – the ledger now has what it really cost.
    await settleReservation(businessId, `call:${c.idempotencyKey}`, "committed");
    if (c.answeredAt && (c.talkSeconds ?? 0) > 0) {
      const i = inc("call_minute"); const billedSec = Math.ceil((c.talkSeconds ?? 0) / i) * i;
      if (await recordUsage({ businessId, userId: c.userId, module: "telephony", service: "call_minute", provider: c.provider, providerRef: c.leadLegId ?? c.agentLegId, idempotencyKey: `call:${c.id}:minutes`, occurredAt: c.endedAt!, unit: "minute", quantity: (c.talkSeconds ?? 0) / 60, billedQuantity: billedSec / 60, status: "estimated", details: { direction: c.direction, destination: c.toE164.slice(0, 5), increment: i, legs: [c.agentLegId ? "agent" : null, c.leadLegId ? "customer" : null].filter(Boolean) } })) n++;
    }
    if (c.recordingStatus === "saved" && c.recordingDurationMs) if (await recordUsage({ businessId, userId: c.userId, module: "telephony", service: "recording_minute", provider: c.provider, providerRef: c.leadLegId ?? c.agentLegId, idempotencyKey: `call:${c.id}:recording`, occurredAt: c.endedAt!, unit: "minute", quantity: c.recordingDurationMs / 60000, status: "estimated" })) n++;
    if (c.coachSession?.sttSeconds) if (await recordUsage({ businessId, userId: c.userId, module: "telephony", service: "transcription_minute", idempotencyKey: `call:${c.id}:transcription`, occurredAt: c.endedAt!, unit: "minute", quantity: c.coachSession.sttSeconds / 60, status: "estimated" })) n++;
    if (c.coachSession?.documentationStatus === "done") if (await recordUsage({ businessId, userId: c.userId, module: "telephony", service: "ai_summary", idempotencyKey: `call:${c.id}:summary`, occurredAt: c.coachSession.documentedAt ?? c.endedAt!, unit: "summary", quantity: 1, status: "final" })) n++;
  }
  const msgs = await db.message.findMany({ where: { businessId, direction: "OUTBOUND", createdAt: { gte: since }, status: { notIn: ["FAILED", "QUEUED", "CANCELLED"] } }, select: { id: true, requestKey: true, channel: true, category: true, body: true, sentByUserId: true, createdAt: true, providerMessageId: true } });
  for (const m of msgs) {
    await settleReservation(businessId, `msg:${m.requestKey ?? m.id}`, "committed");
    if (m.channel === "whatsapp") { if (await recordUsage({ businessId, userId: m.sentByUserId, module: "whatsapp", service: "whatsapp_message", provider: "meta", providerRef: m.providerMessageId, idempotencyKey: `msg:${m.id}`, occurredAt: m.createdAt, unit: "message", quantity: 1, billedByProvider: true, status: "not_billable", details: { category: m.category, note: "Meta גובה ישירות מחשבון ה-WhatsApp של העסק" } })) n++; }
    else if (m.channel === "sms") { const seg = smsMetrics(m.body ?? ""); if (await recordUsage({ businessId, userId: m.sentByUserId, module: "sms", service: "sms_segment", providerRef: m.providerMessageId, idempotencyKey: `msg:${m.id}`, occurredAt: m.createdAt, unit: "segment", quantity: seg.segments, status: "estimated", details: { encoding: seg.encoding, length: seg.length } })) n++; }
    else if (m.channel === "email") { if (await recordUsage({ businessId, userId: m.sentByUserId, module: "email", service: "email_send", providerRef: m.providerMessageId, idempotencyKey: `msg:${m.id}`, occurredAt: m.createdAt, unit: "email", quantity: 1, status: "estimated" })) n++; }
  }
  const ai = await db.aiAction.findMany({ where: { businessId, createdAt: { gte: since } }, select: { id: true, createdAt: true } });
  for (const a of ai) if (await recordUsage({ businessId, module: "crm", service: "ai_action", idempotencyKey: `ai:${a.id}`, occurredAt: a.createdAt, unit: "action", quantity: 1, status: "final" })) n++;
  const numbers = await db.phoneNumber.findMany({ where: { businessId, isActive: true }, select: { id: true, e164: true, provider: true } });
  for (const p of numbers) if (await recordUsage({ businessId, module: "telephony", service: "phone_number_month", provider: p.provider, idempotencyKey: `number:${p.id}:${period()}`, occurredAt: monthStart(), unit: "number_month", quantity: 1, status: "estimated", details: { number: p.e164 } })) n++;
  return n;
}

/** Usage of a month for the billing page: by module / service, final vs estimated vs unrated, and a labelled forecast. */
export async function usageSummary(businessId: string, month = period()) {
  const start = new Date(`${month}-01T00:00:00Z`); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const rows = await db.usageEvent.groupBy({ by: ["module", "service", "status", "unit", "currency", "billedByProvider"], where: { businessId, occurredAt: { gte: start, lt: end }, kind: { in: ["charge", "adjustment", "credit"] } }, _sum: { quantity: true, billedQuantity: true, priceMinor: true }, _count: { _all: true } });
  const lines = rows.map((r) => ({ module: r.module, service: r.service, status: r.status, unit: r.unit, currency: r.currency, billedByProvider: r.billedByProvider, events: r._count._all, quantity: Number(r._sum.quantity ?? 0), billedQuantity: r._sum.billedQuantity === null ? null : Number(r._sum.billedQuantity), priceMinor: r._sum.priceMinor }));
  const sum = (f: (l: (typeof lines)[number]) => boolean) => lines.filter(f).reduce((s, l) => s + (l.priceMinor ?? 0), 0);
  const final = sum((l) => l.status === "final" || l.status === "credited"); const estimated = sum((l) => l.status === "estimated");
  const now = new Date(); const elapsed = Math.min(1, Math.max(0.03, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  return { month, lines, finalMinor: final, estimatedMinor: estimated, unratedEvents: lines.filter((l) => l.status === "unrated").reduce((s, l) => s + l.events, 0), forecastMinor: month === period() ? Math.round((final + estimated) / elapsed) : final + estimated, forecastNote: "תחזית לפי קצב השימוש עד כה – הערכה בלבד" };
}
