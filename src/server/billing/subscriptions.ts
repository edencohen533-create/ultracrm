/**
 * Subscription lifecycle (UltraCRM billing businesses):
 *  • quote → document → provider payment → VERIFIED webhook → applied. Nothing changes on a browser success page;
 *  • additions mid-period are prorated to the second (one rounding per line) and shown before confirming;
 *    reductions / removed modules take effect at the next renewal (date shown) – never mid-period;
 *  • renewal charges the saved method; a failure → past_due, retries (1, 3, 5 days), grace until period end + GRACE
 *    days with a clear notice, then the business is suspended (data kept). Cancellation ends at the period end,
 *    the business becomes "cancelled" – nothing is deleted;
 *  • webhooks: deduped by event id, verified with the provider, applied once; a late / out-of-order event never
 *    rolls a newer state back. One document per idempotency key → no double charge.
 * Amounts are integer minor units (agorot). Documents are frozen once issued (database trigger).
 */
import crypto from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { invalidateEntitlement, ownerLicenses } from "@/lib/access/engine";
import { parseItems, publishedVersion, versionById, type LicenseItem } from "./pricebook";
import { billingProvider, providerByKey } from "./provider";

export const GRACE_DAYS = 7;
const RETRY_DAYS = [1, 3, 5];
const DAY = 86400_000;

export async function assertBillingAdmin(user: SessionUser) {
  const u = await db.user.findFirst({ where: { id: user.id, businessId: user.businessId }, select: { role: true, permissions: true, isSupport: true } });
  // Billing is separate from module work: the owner, or a user the owner named billing admin. Support never.
  const perm = (u?.permissions ?? {}) as { billingAdmin?: boolean };
  if (!u || u.isSupport || !(u.role === "owner" || perm.billingAdmin === true)) throw new ApiError("ניהול חיוב מוגבל לבעל העסק או למי שהוגדר מנהל חיוב", 403, "billing_forbidden");
}

const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const docNumber = () => `UCB-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

async function subOf(businessId: string) {
  return db.subscription.findUnique({ where: { businessId }, include: { items: true } });
}
async function priceItems(sub: { priceBookVersionId: string | null } | null) {
  const v = sub?.priceBookVersionId ? await versionById(sub.priceBookVersionId) : await publishedVersion();
  if (!v) throw new ApiError("אין מחירון מפורסם – לא ניתן לרכוש", 409, "no_price_book");
  return { version: v, items: parseItems(v.licenseItems) };
}

export const desiredSchema = z.record(z.string().regex(/^[a-z_]{2,40}$/), z.number().int().min(0).max(1000));

/**
 * Price of moving from the current licenses to `desired` ({ code: quantity }). Additions: prorated now; reductions:
 * at the next renewal. Returns every line so the owner sees exactly what is charged and when.
 */
export async function quote(businessId: string, desired: Record<string, number>, now = new Date()) {
  const sub = await subOf(businessId);
  const { version, items } = await priceItems(sub);
  // A custom unit price set by the platform for this business wins over the price book (src/server/billing/pricing.ts).
  const custom = await (await import("./pricing")).termsAt(businessId, now);
  const active = sub && ["active", "past_due", "grace"].includes(sub.status) && sub.currentPeriodStart && sub.currentPeriodEnd;
  const periodStart = active ? sub!.currentPeriodStart! : now; const periodEnd = active ? sub!.currentPeriodEnd! : addMonths(now, 1);
  const ratio = active ? Math.max(0, (periodEnd.getTime() - now.getTime()) / (periodEnd.getTime() - periodStart.getTime())) : 1;
  const lines: Array<{ code: string; name: string; kind: string; unitPriceMinor: number; current: number; next: number; chargeNowQty: number; chargeNowMinor: number; changeAtRenewal: number | null }> = [];
  for (const [code, qty] of Object.entries(desired)) {
    const it = items.find((x) => x.code === code);
    if (!it) throw new ApiError(`פריט לא קיים במחירון: ${code}`, 400, "unknown_item");
    if (it.kind === "per_business" && qty > 1) throw new ApiError(`${it.name} נרכש פעם אחת לעסק`, 400, "per_business");
    const cur = sub?.items.find((x) => x.code === code);
    const current = cur?.quantity ?? 0;
    // Existing lines keep the price they were bought at; new lines take the subscription's price book version.
    const unit = custom.terms.licensePrices[code] ?? cur?.unitPriceMinor ?? it.unitPriceMinor;
    const add = Math.max(0, qty - current);
    lines.push({ code, name: it.name, kind: it.kind, unitPriceMinor: unit, current, next: qty, chargeNowQty: add, chargeNowMinor: Math.round(unit * add * ratio), changeAtRenewal: qty < current ? qty : null });
  }
  const subtotal = lines.reduce((s, l) => s + l.chargeNowMinor, 0);
  const tax = Math.round((subtotal * version.taxRateBps) / 10000);
  const allCodes = new Set([...(sub?.items ?? []).map((x) => x.code), ...Object.keys(desired)]);
  const monthly = [...allCodes].reduce((s, code) => { const l = lines.find((x) => x.code === code); const cur = sub?.items.find((x) => x.code === code); const qty = l ? l.next : cur?.pendingQuantity ?? cur?.quantity ?? 0; const unit = l?.unitPriceMinor ?? cur?.unitPriceMinor ?? 0; return s + unit * qty; }, 0);
  return {
    priceBookVersion: version.version, currency: version.currency, taxRateBps: version.taxRateBps, prorated: Boolean(active), prorationRatio: ratio,
    periodStart, periodEnd, lines, subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax,
    monthlyAfterChangeMinor: monthly, monthlyTaxMinor: Math.round((monthly * version.taxRateBps) / 10000),
    reductionsEffectiveAt: lines.some((l) => l.changeAtRenewal !== null) ? periodEnd : null,
    note: "הסכומים לפני שימוש משתנה. אישור תשלום מהספק אינו קבלה / חשבונית מס.",
  };
}

/**
 * Confirm a change. Additions create one document (idempotent per key) paid through the provider – applied only after
 * the provider verifies payment. Reductions are only scheduled. Returns the checkout URL when a payment page is needed.
 */
export async function checkout(user: SessionUser, input: { desired: Record<string, number>; idempotencyKey: string; expectedTotalMinor: number }) {
  await assertBillingAdmin(user);
  const provider = billingProvider();
  if (!provider) throw new ApiError("ספק חיוב הפלטפורמה עדיין לא מחובר – לא ניתן לבצע רכישה", 409, "billing_provider_missing");
  const desired = desiredSchema.parse(input.desired);
  const existing = await db.billingDocument.findUnique({ where: { businessId_idempotencyKey: { businessId: user.businessId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return { document: existing, checkoutUrl: existing.status === "open" ? existing.checkoutUrl : null };
  const q = await quote(user.businessId, desired);
  // The owner confirmed a specific total – if prices / proration moved since, ask again (no surprise charge).
  if (q.totalMinor !== input.expectedTotalMinor) throw new ApiError("הסכום השתנה מאז שהוצג – יש לאשר שוב את הסכום המעודכן", 409, "quote_changed", { quote: q });
  const { version, items } = await priceItems(await subOf(user.businessId));
  let sub = await subOf(user.businessId);
  if (!sub) sub = await db.subscription.create({ data: { businessId: user.businessId, status: "pending_payment", priceBookVersionId: version.id, provider: provider.key }, include: { items: true } });
  // Reductions: scheduled for the renewal, only if the licenses in use fit the new number.
  for (const l of q.lines.filter((x) => x.changeAtRenewal !== null)) {
    const it = items.find((x) => x.code === l.code)!;
    const inUse = await licensesInUse(user.businessId, it);
    if (inUse > l.next) throw new ApiError(`${it.name}: ${inUse} רישיונות מוקצים – שחררו ${inUse - l.next} לפני ההפחתה`, 409, "licenses_in_use", { code: l.code, inUse });
    await db.subscriptionItem.update({ where: { subscriptionId_code: { subscriptionId: sub.id, code: l.code } }, data: { pendingQuantity: l.next } });
  }
  // A line kept at its current quantity cancels a pending reduction.
  for (const l of q.lines.filter((x) => x.next === x.current)) await db.subscriptionItem.updateMany({ where: { subscriptionId: sub.id, code: l.code }, data: { pendingQuantity: null } });
  await audit(user.businessId, user.id, "business", user.businessId, "billing.change_confirmed", { lines: q.lines.map((l) => ({ code: l.code, from: l.current, to: l.next })), totalMinor: q.totalMinor });
  if (q.totalMinor === 0 && q.lines.every((l) => l.chargeNowQty === 0)) return { document: null, checkoutUrl: null, scheduled: q.reductionsEffectiveAt };
  const initial = sub.status === "pending_payment" || sub.status === "none" || sub.status === "canceled";
  const doc = await db.billingDocument.create({ data: {
    businessId: user.businessId, subscriptionId: sub.id, number: docNumber(), kind: initial ? "initial" : "proration", periodStart: q.periodStart, periodEnd: q.periodEnd,
    lines: q.lines.filter((l) => l.chargeNowQty > 0).map((l) => ({ code: l.code, name: l.name, quantity: l.chargeNowQty, unitPriceMinor: l.unitPriceMinor, ratio: q.prorationRatio, amountMinor: l.chargeNowMinor })) as unknown as Prisma.InputJsonValue,
    currency: q.currency, subtotalMinor: q.subtotalMinor, taxMinor: q.taxMinor, totalMinor: q.totalMinor, idempotencyKey: input.idempotencyKey,
    effect: { set: Object.fromEntries(q.lines.filter((l) => l.chargeNowQty > 0).map((l) => [l.code, l.next])), priceBookVersionId: version.id, initial } as Prisma.InputJsonValue,
  } });
  if (!initial && sub.paymentMethodRef) {
    const r = await chargeDocument(doc.id);
    return { document: await db.billingDocument.findUniqueOrThrow({ where: { id: doc.id } }), checkoutUrl: null, charge: r };
  }
  const url = provider.checkoutUrl(doc.id);
  await db.billingDocument.update({ where: { id: doc.id }, data: { checkoutUrl: url } });
  return { document: { ...doc, checkoutUrl: url }, checkoutUrl: url };
}

async function licensesInUse(businessId: string, it: LicenseItem) {
  if (it.kind === "per_business") return 0;
  const users = await db.user.findMany({ where: { businessId, isActive: true, isSupport: false }, select: { role: true, permissions: true } });
  return users.filter((u) => it.modules.some((m) => u.role === "owner" ? ownerLicenses(u.permissions).includes(m) : Boolean(((u.permissions ?? {}) as { modules?: Record<string, { enabled?: boolean }> }).modules?.[m]?.enabled))).length;
}

/** Charge a document with the saved method – once: a compare-and-set on attempts stops two workers charging it. */
export async function chargeDocument(documentId: string) {
  const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: documentId }, include: { subscription: true } });
  if (doc.status !== "open" && doc.status !== "failed") return { skipped: doc.status };
  const provider = providerByKey(doc.subscription.provider);
  if (!provider || !doc.subscription.paymentMethodRef) return { skipped: "no_payment_method" };
  const claimed = await db.billingDocument.updateMany({ where: { id: doc.id, attempts: doc.attempts, status: { in: ["open", "failed"] } }, data: { attempts: { increment: 1 } } });
  if (!claimed.count) return { skipped: "in_flight" };
  const r = await provider.chargeSaved({ documentId: doc.id, businessId: doc.businessId, amountMinor: doc.totalMinor, paymentMethodRef: doc.subscription.paymentMethodRef });
  return { providerPaymentRef: r.providerPaymentRef };
}

/** Webhook entry: verify signature → dedupe → order check → verify with provider → apply once. */
export async function handleBillingWebhook(providerKey: string, headers: Headers, raw: string) {
  const provider = providerByKey(providerKey);
  if (!provider) return { status: 404, result: "unknown_provider" };
  if (!provider.verifyWebhook(headers, raw)) return { status: 401, result: "invalid_signature" };
  const ev = provider.parseWebhook(raw);
  const doc = ev.documentId ? await db.billingDocument.findUnique({ where: { id: ev.documentId }, include: { subscription: true } }) : null;
  const businessId = doc?.businessId ?? ev.businessId ?? null;
  try {
    await db.billingEvent.create({ data: { provider: providerKey, eventId: ev.eventId, type: ev.type, businessId, occurredAt: ev.occurredAt, payload: JSON.parse(raw) as Prisma.InputJsonValue } });
  } catch (e) { if ((e as { code?: string }).code === "P2002") return { status: 200, result: "duplicate" }; throw e; }
  const done = async (result: string) => { await db.billingEvent.update({ where: { provider_eventId: { provider: providerKey, eventId: ev.eventId } }, data: { result, processedAt: new Date() } }); return { status: 200, result }; };

  if (ev.type === "payment_method.updated") {
    if (!businessId) return done("ignored");
    const sub = await subOf(businessId);
    if (!sub) return done("ignored");
    if (sub.lastEventAt && ev.occurredAt < sub.lastEventAt) return done("stale");
    await db.subscription.update({ where: { id: sub.id }, data: { paymentMethodRef: ev.paymentMethodRef ?? sub.paymentMethodRef, paymentMethodLabel: ev.paymentMethodLabel ?? sub.paymentMethodLabel, lastEventAt: ev.occurredAt } });
    await audit(businessId, null, "business", businessId, "billing.payment_method_updated", { label: ev.paymentMethodLabel });
    // A past-due business with a new method is retried at once.
    if (sub.status === "past_due" || sub.status === "grace") await db.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: new Date() } });
    return done("applied");
  }
  if (!doc) return done("ignored");
  if (ev.type === "payment.succeeded") {
    if (doc.status === "paid") return done("duplicate"); // a second success for the same document changes nothing
    const verified = ev.providerPaymentRef ? await provider.verifyPayment(ev.providerPaymentRef) : "pending";
    if (verified !== "succeeded") return done("unverified");
    await applyPaid(doc.id, ev.providerPaymentRef, ev.occurredAt, ev.paymentMethodRef ?? null, ev.paymentMethodLabel ?? null);
    return done("applied");
  }
  // payment.failed – a failure older than the payment that already succeeded is stale.
  if (doc.status === "paid" && doc.paidAt && ev.occurredAt <= doc.paidAt) return done("stale");
  if (doc.status === "paid") return done("stale");
  await db.billingDocument.update({ where: { id: doc.id }, data: { status: "failed", failedAt: ev.occurredAt } });
  if (doc.kind === "renewal") await markPastDue(doc.subscriptionId, ev.reason ?? "התשלום נדחה");
  await audit(doc.businessId, null, "business", doc.businessId, "billing.payment_failed", { document: doc.number, reason: ev.reason });
  return done("applied");
}

async function applyPaid(documentId: string, ref: string | null, at: Date, methodRef: string | null, methodLabel: string | null) {
  await db.$transaction(async (tx) => {
    const doc = await tx.billingDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (doc.status === "paid") return;
    await tx.billingDocument.update({ where: { id: doc.id }, data: { status: "paid", paidAt: at, providerPaymentRef: ref } });
    const effect = (doc.effect ?? {}) as { set?: Record<string, number>; priceBookVersionId?: string; initial?: boolean; renewal?: { start: string; end: string } };
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: doc.subscriptionId }, include: { items: true } });
    const v = await tx.priceBookVersion.findUnique({ where: { id: effect.priceBookVersionId ?? sub.priceBookVersionId ?? "" } });
    const items = v ? parseItems(v.licenseItems) : [];
    for (const [code, qty] of Object.entries(effect.set ?? {})) {
      const it = items.find((x) => x.code === code);
      const cur = sub.items.find((x) => x.code === code);
      if (cur) await tx.subscriptionItem.update({ where: { id: cur.id }, data: { quantity: qty, pendingQuantity: null } });
      else if (it) await tx.subscriptionItem.create({ data: { businessId: doc.businessId, subscriptionId: sub.id, code, module: it.modules.join(","), kind: it.kind, quantity: qty, unitPriceMinor: it.unitPriceMinor } });
    }
    const period = effect.initial ? { currentPeriodStart: doc.periodStart ?? at, currentPeriodEnd: doc.periodEnd ?? addMonths(at, 1) } : effect.renewal ? { currentPeriodStart: new Date(effect.renewal.start), currentPeriodEnd: new Date(effect.renewal.end) } : {};
    await tx.subscription.update({ where: { id: sub.id }, data: { status: "active", ...period, failedAttempts: 0, nextRetryAt: null, graceUntil: null, lastEventAt: at, cancelAtPeriodEnd: effect.initial ? false : sub.cancelAtPeriodEnd, canceledAt: effect.initial ? null : sub.canceledAt, ...(methodRef ? { paymentMethodRef: methodRef, paymentMethodLabel: methodLabel } : {}), ...(effect.priceBookVersionId && effect.initial ? { priceBookVersionId: effect.priceBookVersionId } : {}) } });
    // A business waiting for its first payment / suspended for non-payment becomes active again (never touches a
    // suspension the platform set for another reason).
    const b = await tx.business.findUniqueOrThrow({ where: { id: doc.businessId }, select: { accessStatus: true, statusReason: true } });
    if (b.accessStatus === "setup" || (b.accessStatus === "suspended" && b.statusReason === "payment_failed") || (b.accessStatus === "cancelled" && effect.initial)) await tx.business.update({ where: { id: doc.businessId }, data: { accessStatus: "active", statusReason: null, cancelledAt: null, billingStatus: "subscription" } });
    else await tx.business.update({ where: { id: doc.businessId }, data: { billingStatus: "subscription" } });
  });
  const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: documentId } });
  invalidateEntitlement(doc.businessId);
  await audit(doc.businessId, null, "business", doc.businessId, "billing.payment_applied", { document: doc.number, totalMinor: doc.totalMinor, kind: doc.kind });
}

async function markPastDue(subscriptionId: string, reason: string) {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const attempts = sub.failedAttempts + 1;
  const graceUntil = sub.graceUntil ?? new Date((sub.currentPeriodEnd ?? new Date()).getTime() + GRACE_DAYS * DAY);
  const nextRetry = attempts <= RETRY_DAYS.length ? new Date(Date.now() + RETRY_DAYS[attempts - 1] * DAY) : null;
  await db.subscription.update({ where: { id: sub.id }, data: { status: "past_due", failedAttempts: attempts, nextRetryAt: nextRetry, graceUntil } });
  await (await import("@/server/ops/alerts")).raiseAlert({ fingerprint: `billing:past_due:${sub.businessId}`, severity: "warning", category: "billing", businessId: sub.businessId, title: "תשלום מנוי נכשל", details: { reason, attempts, graceUntil } });
}

/** Schedule cancellation at the period end (data kept); resume before that date undoes it. */
export async function cancel(user: SessionUser, resume = false) {
  await assertBillingAdmin(user);
  const sub = await subOf(user.businessId);
  if (!sub || sub.status === "none" || sub.status === "canceled") throw new ApiError("אין מנוי פעיל", 409, "no_subscription");
  await db.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: !resume, canceledAt: resume ? null : new Date() } });
  await audit(user.businessId, user.id, "business", user.businessId, resume ? "billing.cancel_undone" : "billing.cancel_scheduled", { endsAt: sub.currentPeriodEnd });
  return { cancelAtPeriodEnd: !resume, endsAt: sub.currentPeriodEnd, note: "בסיום התקופה העסק יעבור למצב \"מבוטל\": אין גישה לפעולות, והנתונים נשמרים עד למחיקה מפורשת." };
}

/** Cron: renewals, retries, grace expiry, cancellations at period end. Idempotent per period. */
export async function runBillingCycle(now = new Date()) {
  const out = { renewed: 0, charged: 0, canceled: 0, suspended: 0, retried: 0 };
  const due = await db.subscription.findMany({ where: { status: { in: ["active", "past_due", "grace"] }, currentPeriodEnd: { lte: now } }, include: { items: true } });
  for (const sub of due) {
    if (sub.cancelAtPeriodEnd) {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "canceled" } });
      await db.business.update({ where: { id: sub.businessId }, data: { accessStatus: "cancelled", statusReason: "subscription_canceled", cancelledAt: now } });
      invalidateEntitlement(sub.businessId); out.canceled++;
      await audit(sub.businessId, null, "business", sub.businessId, "billing.subscription_ended", { at: now });
      continue;
    }
    if (sub.status !== "active") continue; // past due: handled by retries / grace below
    const start = sub.currentPeriodEnd!; const end = addMonths(start, 1);
    const key = `renewal:${start.toISOString()}`;
    const existing = await db.billingDocument.findUnique({ where: { businessId_idempotencyKey: { businessId: sub.businessId, idempotencyKey: key } } });
    if (existing) continue;
    // Scheduled reductions take effect now – only if the licenses in use still fit (else kept, owner notified).
    const v = await versionById(sub.priceBookVersionId ?? "");
    const catalog = v ? parseItems(v.licenseItems) : [];
    const lines = [];
    for (const it of sub.items) {
      let qty = it.quantity;
      if (it.pendingQuantity !== null && it.pendingQuantity !== undefined) {
        const cat = catalog.find((c) => c.code === it.code);
        const inUse = cat ? await licensesInUse(sub.businessId, cat) : 0;
        if (inUse <= it.pendingQuantity) qty = it.pendingQuantity;
        else await (await import("@/server/ops/alerts")).raiseAlert({ fingerprint: `billing:reduction_blocked:${sub.businessId}:${it.code}`, severity: "info", category: "billing", businessId: sub.businessId, title: "הפחתת רישיונות לא בוצעה – רישיונות עדיין מוקצים", details: { code: it.code, inUse, requested: it.pendingQuantity } });
        await db.subscriptionItem.update({ where: { id: it.id }, data: { quantity: qty, pendingQuantity: null } });
      }
      if (qty > 0) lines.push({ code: it.code, name: catalog.find((c) => c.code === it.code)?.name ?? it.code, quantity: qty, unitPriceMinor: it.unitPriceMinor });
    }
    // Custom pricing of this business (platform admin) in the fixed order: custom unit prices → recurring discount →
    // one-time credits → VAT (src/server/billing/pricing.ts). Credits are consumed with the document, atomically.
    const { price, documentLines, termsAt, openCredits, consumeCredits } = await import("./pricing");
    const terms = await termsAt(sub.businessId, start);
    const priced = price(lines, terms.terms, await openCredits(sub.businessId), v?.taxRateBps ?? 0, start);
    const doc = await db.$transaction(async (tx) => {
      const d = await tx.billingDocument.create({ data: { businessId: sub.businessId, subscriptionId: sub.id, number: docNumber(), kind: "renewal", periodStart: start, periodEnd: end, lines: documentLines(priced) as unknown as Prisma.InputJsonValue, currency: v?.currency ?? "ILS", subtotalMinor: priced.netMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, idempotencyKey: key, effect: { renewal: { start: start.toISOString(), end: end.toISOString() }, ...(terms.version ? { pricingVersion: terms.version } : {}) } } });
      await consumeCredits(tx, d.id, priced.creditUse);
      return d;
    });
    out.renewed++;
    // Nothing to collect (discount / credit covered it) → paid without contacting the provider.
    if (priced.totalMinor === 0) { await applyPaid(doc.id, null, now, sub.paymentMethodRef, null); continue; }
    if (sub.paymentMethodRef) { await chargeDocument(doc.id); out.charged++; } else await markPastDue(sub.id, "אין אמצעי תשלום שמור");
  }
  // Retries of failed renewals.
  for (const sub of await db.subscription.findMany({ where: { status: { in: ["past_due", "grace"] }, nextRetryAt: { lte: now } } })) {
    const doc = await db.billingDocument.findFirst({ where: { subscriptionId: sub.id, kind: "renewal", status: { in: ["failed", "open"] } }, orderBy: { issuedAt: "desc" } });
    await db.subscription.update({ where: { id: sub.id }, data: { nextRetryAt: null } });
    if (doc) { await chargeDocument(doc.id); out.retried++; }
  }
  // Grace ended without payment → suspended (data kept), with the reason shown.
  for (const sub of await db.subscription.findMany({ where: { status: { in: ["past_due", "grace"] }, graceUntil: { lte: now } } })) {
    await db.subscription.update({ where: { id: sub.id }, data: { status: "grace" } });
    const b = await db.business.findUniqueOrThrow({ where: { id: sub.businessId }, select: { accessStatus: true } });
    if (b.accessStatus !== "suspended") { await db.business.update({ where: { id: sub.businessId }, data: { accessStatus: "suspended", statusReason: "payment_failed" } }); invalidateEntitlement(sub.businessId); out.suspended++; await audit(sub.businessId, null, "business", sub.businessId, "billing.suspended_for_payment", { graceUntil: sub.graceUntil }); }
  }
  return out;
}

/** What the owner sees: subscription, licenses, documents, notice before any restriction. */
export async function billingOverview(user: SessionUser) {
  await assertBillingAdmin(user);
  const sub = await subOf(user.businessId);
  const { version, items } = await priceItems(sub).catch(() => ({ version: null, items: [] as LicenseItem[] }));
  const docs = await db.billingDocument.findMany({ where: { businessId: user.businessId }, orderBy: { issuedAt: "desc" }, take: 50, select: { id: true, number: true, kind: true, periodStart: true, periodEnd: true, lines: true, currency: true, subtotalMinor: true, taxMinor: true, totalMinor: true, status: true, issuedAt: true, paidAt: true, failedAt: true, checkoutUrl: true } });
  const inUse: Record<string, number> = {};
  for (const it of items) inUse[it.code] = await licensesInUse(user.businessId, it);
  const notice = sub && (sub.status === "past_due" || sub.status === "grace") ? { level: "warning", text: `התשלום האחרון נכשל. אם לא יתעדכן אמצעי תשלום עד ${sub.graceUntil?.toLocaleDateString("he-IL")} – השירות יוגבל (הנתונים נשמרים).`, restrictAt: sub.graceUntil } : sub?.cancelAtPeriodEnd ? { level: "info", text: `המנוי יסתיים ב-${sub.currentPeriodEnd?.toLocaleDateString("he-IL")}. אפשר לבטל את הביטול עד אז.`, restrictAt: sub.currentPeriodEnd } : null;
  return {
    provider: billingProvider() ? { key: billingProvider()!.key, name: billingProvider()!.name, live: billingProvider()!.live } : null,
    priceBook: version ? { version: version.version, currency: version.currency, taxRateBps: version.taxRateBps, items } : null,
    subscription: sub ? { status: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, graceUntil: sub.graceUntil, paymentMethodLabel: sub.paymentMethodLabel, failedAttempts: sub.failedAttempts, items: sub.items.map((i) => ({ code: i.code, quantity: i.quantity, pendingQuantity: i.pendingQuantity, unitPriceMinor: i.unitPriceMinor, kind: i.kind, inUse: inUse[i.code] ?? 0 })) } : null,
    documents: docs, notice, paymentMethodUpdateUrl: sub && billingProvider() ? billingProvider()!.paymentMethodUpdateUrl(user.businessId) : null,
  };
}
