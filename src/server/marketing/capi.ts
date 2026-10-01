/**
 * "המרות למטא" – CRM conversions to Meta Events Manager through the Conversions API (POST /{dataset_id}/events).
 *
 *  • Its own connection (dataset + a token allowed to send events) – the ads-reading connection (ads_read) is a
 *    different permission and is never assumed to cover sending.
 *  • Rules map a CRM trigger (+ conditions) to a Meta standard / custom event, with a value source.
 *  • Events are created server-side from saved business changes (domain events, confirmed payments) into a durable
 *    per-business queue: stable event_id per occurrence, a unique dedupe key (repeat saves / duplicate webhooks /
 *    parallel workers create nothing new), event_time = when it happened, value + currency + identifiers snapshotted
 *    at that moment so a retry sends exactly the same content.
 *  • Identifiers: only what Meta accepts, hashed (SHA-256 after normalisation) only where Meta requires it; lead_id,
 *    fbc, fbp are sent as is. No IP / user agent is invented, nothing from the agent's computer is used.
 *  • "התקבל ב-API" = Meta answered events_received. That is not "seen in Events Manager" and not "attributed".
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { sealSecret, openSecret } from "@/lib/crypto";
import { GRAPH_BASE } from "@/lib/meta/graph";
import { classifyAdsError } from "./meta-api";
import type { SessionUser } from "@/lib/auth";

// ─── Vocabulary (checked against Meta's docs: Pixel reference, CAPI server-event & CRM payload spec) ────────────

export const STANDARD_EVENTS = ["AddPaymentInfo", "AddToCart", "AddToWishlist", "CompleteRegistration", "Contact", "CustomizeProduct", "Donate", "FindLocation", "InitiateCheckout", "Lead", "Purchase", "Schedule", "Search", "StartTrial", "SubmitApplication", "Subscribe", "ViewContent"] as const;
export const TRIGGERS = {
  lead_created: "ליד חדש נוצר", lead_status: "ליד עבר לסטטוס", appointment_scheduled: "פגישה נקבעה", appointment_attended: "פגישה התקיימה",
  deal_won: "עסקה נסגרה", payment_received: "תשלום התקבל", field_changed: "שדה השתנה לערך",
} as const;
export type Trigger = keyof typeof TRIGGERS;
/** action_source values Meta documents; "website" / "app" need browser data (URL, user agent) the CRM does not have. */
export const ACTION_SOURCES = {
  system_generated: "CRM – Conversion Leads (שלבי ליד מטופס לידים של מטא)", phone_call: "שיחת טלפון", chat: "צ׳אט / WhatsApp / SMS",
  physical_store: "בנקודת מכירה פיזית", email: "אימייל", other: "אחר",
} as const;
export const VALUE_SOURCES = { none: "ללא ערך", deal_amount: "שווי העסקה", payment_amount: "הסכום ששולם בפועל", custom_field: "שדה כספי מותאם", fixed: "ערך קבוע" } as const;
/** Conservative custom-event name rule (letters, digits, underscore; starts with a letter; not a standard name). */
export const CUSTOM_EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;
export const TEMPLATES: Array<{ key: string; name: string; trigger: Trigger; eventKind: "standard" | "custom"; eventName: string; actionSource: keyof typeof ACTION_SOURCES; valueSource: keyof typeof VALUE_SOURCES; note: string }> = [
  { key: "lead", name: "ליד חדש", trigger: "lead_created", eventKind: "standard", eventName: "Lead", actionSource: "system_generated", valueSource: "none", note: "ליד שנכנס מטופס לידים של מטא נשלח עם lead_id (מסלול CRM)." },
  { key: "schedule", name: "פגישה נקבעה", trigger: "appointment_scheduled", eventKind: "standard", eventName: "Schedule", actionSource: "phone_call", valueSource: "none", note: "Schedule הוא אירוע סטנדרטי של מטא לקביעת פגישה. קביעה מחדש של אותה פגישה אינה נספרת שוב." },
  { key: "purchase", name: "רכישה (תשלום שאושר)", trigger: "payment_received", eventKind: "standard", eventName: "Purchase", actionSource: "phone_call", valueSource: "payment_amount", note: "value + currency מהתשלום שאושר; אותה רכישה לא תישלח גם מסגירת העסקה." },
  { key: "attended", name: "פגישה התקיימה", trigger: "appointment_attended", eventKind: "custom", eventName: "AppointmentAttended", actionSource: "phone_call", valueSource: "none", note: "אירוע מותאם – כדי למדוד אותו כהמרה צריך להגדיר Custom Conversion ב-Events Manager." },
  { key: "qualified", name: "ליד כשיר", trigger: "lead_status", eventKind: "custom", eventName: "CRMQualifiedLead", actionSource: "system_generated", valueSource: "none", note: "שלב בתהליך הליד (מסלול CRM). בחרו את הסטטוס של העסק שמשמעותו ׳כשיר׳." },
];

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  trigger: z.enum(Object.keys(TRIGGERS) as [Trigger, ...Trigger[]]),
  triggerConfig: z.object({ statusId: z.string().max(64).optional(), field: z.string().max(100).optional(), fieldValue: z.string().max(200).optional() }).default({}),
  conditions: z.object({ campaignId: z.string().max(64).optional(), product: z.string().max(160).optional(), source: z.string().max(100).optional() }).default({}),
  eventKind: z.enum(["standard", "custom"]),
  eventName: z.string().trim().min(2).max(40),
  actionSource: z.enum(Object.keys(ACTION_SOURCES) as [keyof typeof ACTION_SOURCES, ...Array<keyof typeof ACTION_SOURCES>]),
  valueSource: z.enum(Object.keys(VALUE_SOURCES) as [keyof typeof VALUE_SOURCES, ...Array<keyof typeof VALUE_SOURCES>]).default("none"),
  valueField: z.string().max(100).optional().nullable(),
  fixedValue: z.number().min(0).max(100_000_000).optional().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().nullable(),
  valueIncludes: z.object({ vat: z.boolean().optional(), shipping: z.boolean().optional(), discounts: z.boolean().optional() }).default({}),
  resend: z.enum(["once", "every"]).default("once"),
  enabled: z.boolean().default(false),
}).superRefine((r, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (r.eventKind === "standard" && !(STANDARD_EVENTS as readonly string[]).includes(r.eventName)) bad("eventName", "אירוע סטנדרטי לא מוכר");
  if (r.eventKind === "custom" && (!CUSTOM_EVENT_RE.test(r.eventName) || (STANDARD_EVENTS as readonly string[]).includes(r.eventName))) bad("eventName", "שם אירוע מותאם: אותיות באנגלית, ספרות וקו תחתון, מתחיל באות, עד 40 תווים, ולא שם של אירוע סטנדרטי");
  if (r.trigger === "lead_status" && !r.triggerConfig.statusId) bad("triggerConfig", "בחרו סטטוס");
  if (r.trigger === "field_changed" && (!r.triggerConfig.field || r.triggerConfig.fieldValue === undefined)) bad("triggerConfig", "בחרו שדה וערך");
  if (r.eventName === "Purchase" && r.valueSource === "none") bad("valueSource", "Purchase דורש ערך ומטבע");
  if (r.valueSource === "payment_amount" && r.trigger !== "payment_received") bad("valueSource", "\"הסכום ששולם\" זמין רק בטריגר \"תשלום התקבל\"");
  if (r.valueSource === "deal_amount" && !["deal_won", "payment_received"].includes(r.trigger)) bad("valueSource", "\"שווי העסקה\" זמין בעסקה שנסגרה או בתשלום על עסקה");
  if (r.valueSource === "custom_field" && (!r.valueField || !r.currency)) bad("valueField", "בחרו שדה ומטבע");
  if (r.valueSource === "fixed" && (r.fixedValue === null || r.fixedValue === undefined || !r.currency)) bad("fixedValue", "הזינו ערך ומטבע");
  if (r.actionSource === "system_generated" && !["lead_created", "lead_status", "appointment_scheduled", "appointment_attended", "deal_won", "payment_received", "field_changed"].includes(r.trigger)) bad("actionSource", "מסלול לא מתאים");
});
export type RuleInput = z.infer<typeof ruleSchema>;

// ─── Connection ────────────────────────────────────────────────────────────────

const PUBLIC_CONN = { id: true, datasetId: true, datasetName: true, tokenHint: true, enabled: true, testEventCode: true, status: true, lastError: true, lastCheckedAt: true, leadEventSource: true, siteSendsPurchase: true, updatedAt: true } as const;
export const connectionSchema = z.object({
  datasetId: z.string().trim().regex(/^\d{6,25}$/, "מזהה Dataset / Pixel הוא מספר"),
  datasetName: z.string().trim().max(200).optional(),
  token: z.string().trim().min(20).max(1000).optional(),
  testEventCode: z.string().trim().max(60).nullable().optional(),
  leadEventSource: z.string().trim().min(2).max(60).optional(),
  siteSendsPurchase: z.boolean().optional(),
});

export async function getConnection(businessId: string) { return prisma.metaCapiConnection.findUnique({ where: { businessId }, select: PUBLIC_CONN }); }

export async function saveConnection(user: SessionUser, input: z.infer<typeof connectionSchema>) {
  const cur = await prisma.metaCapiConnection.findUnique({ where: { businessId: user.businessId } });
  if (!cur && !input.token) throw new ApiError("נדרש טוקן של Conversions API", 400, "token_required");
  const changedTarget = !cur || cur.datasetId !== input.datasetId || Boolean(input.token);
  const data = {
    datasetId: input.datasetId, datasetName: input.datasetName ?? cur?.datasetName ?? null,
    ...(input.token ? { tokenSealed: sealSecret(input.token), tokenHint: `…${input.token.slice(-4)}` } : {}),
    ...(input.testEventCode !== undefined ? { testEventCode: input.testEventCode || null } : {}),
    ...(input.leadEventSource ? { leadEventSource: input.leadEventSource } : {}),
    ...(input.siteSendsPurchase !== undefined ? { siteSendsPurchase: input.siteSendsPurchase } : {}),
    // A new dataset / token must be checked again before anything is sent.
    ...(changedTarget ? { status: "unverified", enabled: false, lastError: null } : {}),
  };
  const row = cur
    ? await prisma.metaCapiConnection.update({ where: { businessId: user.businessId }, data, select: PUBLIC_CONN })
    : await prisma.metaCapiConnection.create({ data: { businessId: user.businessId, connectedById: user.id, tokenSealed: data.tokenSealed!, tokenHint: data.tokenHint, ...data }, select: PUBLIC_CONN });
  await audit(user.businessId, user.id, "marketing", row.id, "capi.connection_saved", { datasetId: input.datasetId, tokenChanged: Boolean(input.token) });
  return row;
}

async function tokenOf(businessId: string) {
  const c = await prisma.metaCapiConnection.findUnique({ where: { businessId } });
  if (!c) throw new ApiError("אין חיבור Conversions API", 404, "not_connected");
  const token = openSecret(c.tokenSealed);
  if (!token) throw new ApiError("לא ניתן לפתוח את הטוקן השמור – יש להזין אותו מחדש", 409, "token_unreadable");
  return { c, token };
}

/** Real check against Graph: the dataset is readable with this token. Sending permission is proven by a test event. */
export async function checkConnection(user: SessionUser) {
  const { c, token } = await tokenOf(user.businessId);
  const url = new URL(`${GRAPH_BASE}/${c.datasetId}`); url.searchParams.set("fields", "id,name");
  let status = "ok", lastError: string | null = null, name = c.datasetName;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error" });
    const body = await res.json().catch(() => ({})) as { name?: string; error?: { message?: string; code?: number; error_subcode?: number } };
    if (!res.ok || body.error) { const e = classifyAdsError(res.status, body.error, res.headers); status = e.kind === "auth" || e.kind === "permission" ? "revoked" : "error"; lastError = explain(e.kind, e.message); }
    else name = body.name ?? name;
  } catch (e) { status = "error"; lastError = `Meta לא זמינה: ${(e as Error).message}`.slice(0, 300); }
  const row = await prisma.metaCapiConnection.update({ where: { businessId: user.businessId }, data: { status, lastError, lastCheckedAt: new Date(), datasetName: name, ...(status !== "ok" ? { enabled: false } : {}) }, select: PUBLIC_CONN });
  await audit(user.businessId, user.id, "marketing", row.id, "capi.connection_checked", { status });
  return row;
}

/** A test event – ONLY with a Test Event Code, so it appears in Events Manager → Test events and not as production data. */
export async function sendTestEvent(user: SessionUser) {
  const { c, token } = await tokenOf(user.businessId);
  if (!c.testEventCode) throw new ApiError("הזינו Test Event Code מ-Events Manager (לשונית Test events) – בלי קוד לא נשלח אירוע בדיקה", 400, "test_code_required");
  const event = { event_name: "CRMTestEvent", event_time: Math.floor(Date.now() / 1000), action_source: "other", event_id: `test-${crypto.randomUUID()}`, user_data: { external_id: [sha256(`test-${user.businessId}`)] }, custom_data: { note: "UltraCRM connection test" } };
  const r = await postEvents(c.datasetId, token, [event], c.testEventCode);
  await prisma.metaCapiConnection.update({ where: { businessId: user.businessId }, data: { lastCheckedAt: new Date(), ...(r.ok ? { status: "ok", lastError: null } : { status: r.kind === "auth" || r.kind === "permission" ? "revoked" : c.status, lastError: r.error }) } });
  await audit(user.businessId, user.id, "marketing", c.id, "capi.test_event", { ok: r.ok });
  return r.ok ? { ok: true, eventsReceived: r.eventsReceived, fbtraceId: r.fbtraceId, testEventCode: c.testEventCode } : { ok: false, error: r.error };
}

export async function setSending(user: SessionUser, enabled: boolean) {
  const c = await prisma.metaCapiConnection.findUnique({ where: { businessId: user.businessId } });
  if (!c) throw new ApiError("אין חיבור", 404, "not_connected");
  if (enabled && c.status !== "ok") throw new ApiError("יש לבדוק את החיבור (ולשלוח אירוע בדיקה) לפני הפעלת השליחה", 409, "not_verified");
  const row = await prisma.metaCapiConnection.update({ where: { businessId: user.businessId }, data: { enabled }, select: PUBLIC_CONN });
  await audit(user.businessId, user.id, "marketing", c.id, enabled ? "capi.enabled" : "capi.paused", {});
  return row;
}

/** Datasets (pixels) visible through the ads-reading connection, to pick from – reading them does not grant sending. */
export async function datasetsFromAdsConnection(businessId: string) {
  const conn = await prisma.metaAdConnection.findUnique({ where: { businessId }, include: { accounts: { select: { accountId: true, name: true } } } });
  if (!conn) return { available: false as const, items: [] };
  const token = openSecret(conn.tokenSealed); if (!token) return { available: false as const, items: [] };
  const out: Array<{ id: string; name: string; account: string }> = [];
  for (const acc of conn.accounts.slice(0, 10)) {
    const url = new URL(`${GRAPH_BASE}/act_${String(acc.accountId).replace(/^act_/, "")}/adspixels`); url.searchParams.set("fields", "id,name");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) as { data?: Array<{ id: string; name: string }> } : {};
    for (const d of body.data ?? []) if (!out.some((x) => x.id === d.id)) out.push({ id: d.id, name: d.name, account: acc.name ?? acc.accountId });
  }
  return { available: true as const, items: out };
}

// ─── Rules ─────────────────────────────────────────────────────────────────────

export async function saveRule(user: SessionUser, input: RuleInput, id?: string) {
  if (input.trigger === "lead_status") {
    const st = await prisma.leadStatusDef.findFirst({ where: { id: input.triggerConfig.statusId, deletedAt: null }, select: { id: true } });
    if (!st) throw new ApiError("הסטטוס שנבחר אינו קיים", 400, "status_invalid");
  }
  const data = { name: input.name, trigger: input.trigger, triggerConfig: input.triggerConfig as Prisma.InputJsonValue, conditions: input.conditions as Prisma.InputJsonValue, eventKind: input.eventKind, eventName: input.eventName, actionSource: input.actionSource, valueSource: input.valueSource, valueField: input.valueField ?? null, fixedValue: input.fixedValue ?? null, currency: input.currency ?? null, valueIncludes: input.valueIncludes as Prisma.InputJsonValue, resend: input.resend, enabled: input.enabled };
  const row = id
    ? await prisma.metaCapiRule.update({ where: { id: (await prisma.metaCapiRule.findFirstOrThrow({ where: { id }, select: { id: true } })).id }, data })
    : await prisma.metaCapiRule.create({ data: { ...data, businessId: user.businessId, createdById: user.id } });
  await audit(user.businessId, user.id, "marketing", row.id, id ? "capi.rule_updated" : "capi.rule_created", { trigger: input.trigger, eventName: input.eventName, enabled: input.enabled });
  return row;
}

// ─── Identifiers ───────────────────────────────────────────────────────────────

export const sha256 = (v: string) => crypto.createHash("sha256").update(v, "utf8").digest("hex");
/** Meta normalisation: email trimmed + lowercase; phone digits with country code (no +, no leading zeros); names lowercase, no punctuation. */
export const normalize = {
  em: (v: string) => v.trim().toLowerCase(),
  ph: (e164: string) => e164.replace(/\D/g, "").replace(/^0+/, ""),
  name: (v: string) => v.trim().toLowerCase().replace(/[\p{P}\p{S}]/gu, "").replace(/\s+/g, " "),
  ct: (v: string) => v.trim().toLowerCase().replace(/[\p{P}\p{S}\s]/gu, ""),
};

/** user_data for a contact: hashed em / ph / fn / ln / ct / external_id; lead_id, fbc, fbp as stored (not hashed). */
async function userData(contactId: string, forCrmRoute: boolean) {
  const c = await prisma.contact.findFirst({ where: { id: contactId }, select: { id: true, fullName: true, email: true, phoneE164: true, city: true } });
  if (!c) return { userData: null as null | Record<string, unknown>, leadId: null as string | null, keys: [] as string[] };
  const tp = await prisma.leadTouchpoint.findFirst({ where: { contactId }, orderBy: { occurredAt: "desc" }, select: { metaLeadId: true, clickIds: true } });
  const ud: Record<string, unknown> = { external_id: [sha256(c.id)] };
  if (c.email) ud.em = [sha256(normalize.em(c.email))];
  if (c.phoneE164 && !c.phoneE164.startsWith("deleted:")) ud.ph = [sha256(normalize.ph(c.phoneE164))];
  const parts = normalize.name(c.fullName ?? "").split(" ").filter(Boolean);
  if (parts.length >= 2) { ud.fn = [sha256(parts[0])]; ud.ln = [sha256(parts.slice(1).join(" "))]; }
  if (c.city) { const ct = normalize.ct(c.city); if (ct) ud.ct = [sha256(ct)]; }
  const ids = (tp?.clickIds ?? {}) as { fbc?: string; fbp?: string };
  if (typeof ids.fbc === "string" && /^fb\.\d\.\d+\./.test(ids.fbc)) ud.fbc = ids.fbc; // only a real stored fbc – never built from guesses
  if (typeof ids.fbp === "string" && /^fb\.\d\.\d+\./.test(ids.fbp)) ud.fbp = ids.fbp;
  const leadId = tp?.metaLeadId && /^\d{10,20}$/.test(tp.metaLeadId) ? tp.metaLeadId : null;
  if (leadId && forCrmRoute) ud.lead_id = Number(leadId) <= Number.MAX_SAFE_INTEGER ? Number(leadId) : leadId;
  return { userData: ud, leadId, keys: Object.keys(ud) };
}

// ─── From CRM events to the queue ──────────────────────────────────────────────

type Occurrence = { trigger: Trigger; contactId: string | null; entityType: string; entityId: string; occurredAt: Date; occurrenceKey: string; leadId?: string | null; dealId?: string | null; paymentId?: string | null; statusId?: string | null; statusKind?: string | null; changes?: Record<string, unknown> };

/** A domain event of the CRM → the occurrence it represents (or null). */
export async function occurrenceFromEvent(ev: { id: string; type: string; contactId: string | null; occurredAt: Date; payload: unknown }): Promise<Occurrence | null> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  if (ev.type === "lead.created" && s("leadId")) return { trigger: "lead_created", contactId: ev.contactId, entityType: "lead", entityId: s("leadId")!, occurredAt: ev.occurredAt, occurrenceKey: ev.id, leadId: s("leadId") };
  if (ev.type === "lead.status_changed" && s("leadId")) return { trigger: "lead_status", contactId: ev.contactId, entityType: "lead", entityId: s("leadId")!, occurredAt: ev.occurredAt, occurrenceKey: ev.id, leadId: s("leadId"), statusId: s("toStatusId"), statusKind: s("to") };
  if (ev.type === "deal.won" && s("dealId")) return { trigger: "deal_won", contactId: ev.contactId, entityType: "deal", entityId: s("dealId")!, occurredAt: ev.occurredAt, occurrenceKey: ev.id, dealId: s("dealId") };
  if (ev.type === "appointment.scheduled" && s("appointmentId")) return { trigger: "appointment_scheduled", contactId: ev.contactId, entityType: "appointment", entityId: s("appointmentId")!, occurredAt: ev.occurredAt, occurrenceKey: s("appointmentId")!, leadId: s("leadId") };
  if (ev.type === "appointment.attended" && s("appointmentId")) return { trigger: "appointment_attended", contactId: ev.contactId, entityType: "appointment", entityId: s("appointmentId")!, occurredAt: ev.occurredAt, occurrenceKey: s("appointmentId")!, leadId: s("leadId") };
  if (ev.type === "contact.field_changed" && ev.contactId) return { trigger: "field_changed", contactId: ev.contactId, entityType: "contact", entityId: ev.contactId, occurredAt: ev.occurredAt, occurrenceKey: ev.id, changes: (p.changes ?? {}) as Record<string, unknown> };
  return null;
}

async function matches(rule: { trigger: string; triggerConfig: unknown; conditions: unknown }, o: Occurrence) {
  if (rule.trigger !== o.trigger) return false;
  const tc = (rule.triggerConfig ?? {}) as { statusId?: string; field?: string; fieldValue?: string };
  if (o.trigger === "lead_status") {
    // The business's own status by id; a system status may also arrive by meaning only (older events).
    const def = tc.statusId ? await prisma.leadStatusDef.findFirst({ where: { id: tc.statusId }, select: { id: true, kind: true, isSystem: true } }) : null;
    if (!def) return false;
    if (o.statusId ? o.statusId !== def.id : !(def.isSystem && o.statusKind === def.kind)) return false;
  }
  if (o.trigger === "field_changed") { if (!tc.field || !(tc.field in (o.changes ?? {})) || String((o.changes ?? {})[tc.field] ?? "") !== String(tc.fieldValue ?? "")) return false; }
  const cond = (rule.conditions ?? {}) as { campaignId?: string; product?: string; source?: string };
  if (cond.campaignId || cond.product || cond.source) {
    if (!o.contactId) return false;
    if (cond.campaignId && !(await prisma.leadTouchpoint.findFirst({ where: { contactId: o.contactId, campaignId: cond.campaignId }, select: { id: true } }))) return false;
    if (cond.product) { const c = await prisma.contact.findFirst({ where: { id: o.contactId }, select: { customFields: true } }); if (String(((c?.customFields ?? {}) as Record<string, unknown>).product ?? "") !== cond.product) return false; }
    if (cond.source) { const l = o.leadId ? await prisma.lead.findFirst({ where: { id: o.leadId }, select: { source: true } }) : await prisma.lead.findFirst({ where: { contactId: o.contactId }, orderBy: { createdAt: "desc" }, select: { source: true } }); if ((l?.source ?? "") !== cond.source) return false; }
  }
  return true;
}

/** Value + currency for an occurrence – never invented: missing → null with the reason. */
async function valueOf(rule: { valueSource: string; valueField: string | null; fixedValue: unknown; currency: string | null }, o: Occurrence): Promise<{ value: number | null; currency: string | null; missing: string | null; dealId: string | null }> {
  let dealId = o.dealId ?? null;
  const fixedCur = rule.currency;
  if (rule.valueSource === "none") return { value: null, currency: null, missing: null, dealId };
  if (rule.valueSource === "fixed") return { value: rule.fixedValue === null ? null : Number(rule.fixedValue), currency: fixedCur, missing: rule.fixedValue === null || !fixedCur ? "חסר ערך קבוע או מטבע בכלל" : null, dealId };
  if (rule.valueSource === "payment_amount") {
    const pay = o.paymentId ? await prisma.paymentRequest.findFirst({ where: { id: o.paymentId }, select: { amountAgorot: true, currency: true, sourceType: true, sourceId: true } }) : null;
    if (pay?.sourceType === "deal" && pay.sourceId) dealId = pay.sourceId;
    if (!pay || !pay.amountAgorot || pay.amountAgorot <= 0) return { value: null, currency: pay?.currency ?? null, missing: "לתשלום אין סכום", dealId };
    if (!pay.currency) return { value: pay.amountAgorot / 100, currency: null, missing: "לתשלום אין מטבע", dealId };
    return { value: pay.amountAgorot / 100, currency: pay.currency.toUpperCase(), missing: null, dealId };
  }
  if (rule.valueSource === "deal_amount") {
    if (!dealId && o.paymentId) { const pay = await prisma.paymentRequest.findFirst({ where: { id: o.paymentId }, select: { sourceType: true, sourceId: true } }); if (pay?.sourceType === "deal") dealId = pay.sourceId; }
    const deal = dealId ? await prisma.deal.findFirst({ where: { id: dealId }, select: { amount: true, currency: true } }) : null;
    if (!deal) return { value: null, currency: null, missing: "לא נמצאה עסקה מקושרת", dealId };
    const v = Number(deal.amount);
    if (!(v > 0)) return { value: null, currency: deal.currency, missing: "שווי העסקה חסר או 0", dealId };
    if (!deal.currency) return { value: v, currency: null, missing: "לעסקה אין מטבע", dealId };
    return { value: v, currency: deal.currency.toUpperCase(), missing: null, dealId };
  }
  // custom_field on the contact
  const c = o.contactId ? await prisma.contact.findFirst({ where: { id: o.contactId }, select: { customFields: true } }) : null;
  const raw = ((c?.customFields ?? {}) as Record<string, unknown>)[rule.valueField ?? ""];
  const v = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : null;
  return { value: v, currency: fixedCur, missing: v === null ? `השדה "${rule.valueField}" ריק או אינו מספר` : !fixedCur ? "חסר מטבע בכלל" : null, dealId };
}

/** Builds and enqueues the events of all matching enabled rules. Idempotent per occurrence (unique dedupe key). */
export async function enqueueOccurrence(businessId: string, o: Occurrence) {
  const conn = await prisma.metaCapiConnection.findUnique({ where: { businessId }, select: { id: true, leadEventSource: true, siteSendsPurchase: true, testEventCode: true } });
  if (!conn) return { created: 0 };
  const rules = await prisma.metaCapiRule.findMany({ where: { businessId, enabled: true, trigger: o.trigger } });
  let created = 0;
  for (const rule of rules) {
    if (!(await matches(rule, o))) continue;
    const v = await valueOf(rule, o);
    // One purchase is one event: the same deal / payment never produces Purchase twice (close + payment, re-save, retry).
    const purchaseKey = rule.eventName === "Purchase" ? (v.dealId ? `deal:${v.dealId}` : o.paymentId ? `payment:${o.paymentId}` : `${o.entityType}:${o.entityId}`) : null;
    const scope = rule.resend === "once" ? `${o.entityType}:${o.entityId}` : `occ:${o.occurrenceKey}`;
    const dedupeKey = purchaseKey ? `Purchase:${purchaseKey}` : `${rule.id}:${scope}`;
    const eventId = purchaseKey ? `purchase-${purchaseKey.replace(":", "-")}` : `${rule.eventName}-${o.entityType}-${o.entityId}${rule.resend === "every" ? `-${o.occurrenceKey}` : ""}`;
    let status = "queued"; let reason: string | null = null;
    if (v.missing) { status = "pending_data"; reason = v.missing; }
    const ud = o.contactId ? await userData(o.contactId, rule.actionSource === "system_generated") : { userData: null, leadId: null, keys: [] };
    if (!ud.userData) { status = "skipped"; reason = "אין איש קשר מקושר"; }
    // Privacy: a contact who opted out of everything is not shared.
    if (o.contactId && status !== "skipped") {
      const c = await prisma.contact.findFirst({ where: { id: o.contactId }, select: { consentStatus: true, isBlocked: true } });
      if (!c || c.consentStatus === "OPTED_OUT" || c.isBlocked) { status = "skipped"; reason = "הלקוח ביקש הסרה / חסום – לא משותף עם מטא"; }
    }
    // One agreed source: the site already sends Purchase for store orders.
    if (rule.eventName === "Purchase" && conn.siteSendsPurchase && o.contactId && v.value !== null && status === "queued") {
      const order = await prisma.storeOrder.findFirst({ where: { contactId: o.contactId, total: v.value, placedAt: { gte: new Date(o.occurredAt.getTime() - 48 * 3600_000), lte: new Date(o.occurredAt.getTime() + 48 * 3600_000) } }, select: { orderNumber: true } });
      if (order) { status = "skipped"; reason = `רכישה זו (הזמנה ${order.orderNumber}) כבר נשלחת מהאתר – לא נשלחת שוב מה-CRM`; }
    }
    const event = {
      event_name: rule.eventName, event_time: Math.floor(o.occurredAt.getTime() / 1000), event_id: eventId, action_source: rule.actionSource,
      user_data: ud.userData ?? {},
      custom_data: {
        ...(v.value !== null && v.currency ? { value: v.value, currency: v.currency } : {}),
        ...(rule.eventName === "Purchase" ? { order_id: eventId } : {}),
        ...(rule.actionSource === "system_generated" ? { event_source: "crm", lead_event_source: conn.leadEventSource } : {}),
      },
    };
    const row = await prisma.metaCapiEvent.createManyAndReturn({ data: [{
      businessId, ruleId: rule.id, dedupeKey, eventName: rule.eventName, eventId, occurredAt: o.occurredAt, entityType: o.entityType, entityId: o.entityId, contactId: o.contactId,
      value: v.value, currency: v.currency, payload: event as unknown as Prisma.InputJsonValue, status, statusReason: reason, testCode: conn.testEventCode,
    }], skipDuplicates: true });
    created += row.length;
  }
  return { created };
}

/** Confirmed payments (read only – the payment flow itself is untouched) → payment_received occurrences. */
export async function scanPayments(businessId: string) {
  const rules = await prisma.metaCapiRule.count({ where: { businessId, enabled: true, trigger: "payment_received" } });
  if (!rules) return { payments: 0 };
  const since = new Date(Date.now() - 7 * 86400_000);
  const pays = await prisma.paymentRequest.findMany({ where: { businessId, status: "succeeded", confirmedAt: { gte: since } }, select: { id: true, contactId: true, confirmedAt: true, sourceType: true, sourceId: true }, take: 200, orderBy: { confirmedAt: "asc" } });
  let created = 0;
  for (const p of pays) created += (await enqueueOccurrence(businessId, { trigger: "payment_received", contactId: p.contactId, entityType: "payment", entityId: p.id, occurredAt: p.confirmedAt!, occurrenceKey: p.id, paymentId: p.id, dealId: p.sourceType === "deal" ? p.sourceId : null })).created;
  return { payments: pays.length, created };
}

// ─── Sending ───────────────────────────────────────────────────────────────────

function explain(kind: string, message: string) {
  if (kind === "auth") return "הטוקן אינו תקף או בוטל – יש ליצור טוקן חדש ב-Events Manager ולהזין אותו";
  if (kind === "permission") return "לטוקן אין הרשאה לשלוח אירועים ל-Dataset הזה";
  if (kind === "throttle") return "מטא הגבילה זמנית את קצב הבקשות – ננסה שוב";
  if (kind === "transient") return "תקלה זמנית במטא – ננסה שוב";
  return `מטא דחתה את האירוע: ${message}`.slice(0, 300);
}

async function postEvents(datasetId: string, token: string, data: unknown[], testEventCode: string | null) {
  try {
    const res = await fetch(`${GRAPH_BASE}/${datasetId}/events`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ data, ...(testEventCode ? { test_event_code: testEventCode } : {}) }), signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store" });
    const body = await res.json().catch(() => ({})) as { events_received?: number; fbtrace_id?: string; error?: { message?: string; code?: number; error_subcode?: number } };
    if (res.ok && !body.error) return { ok: true as const, eventsReceived: body.events_received ?? 0, fbtraceId: body.fbtrace_id ?? null };
    const e = classifyAdsError(res.status, body.error, res.headers);
    return { ok: false as const, kind: e.kind, error: explain(e.kind, e.message) };
  } catch (e) { return { ok: false as const, kind: "transient", error: explain("transient", (e as Error).message) }; }
}

const BACKOFF_MIN = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = 6;

/** One business: claim due events, send each (one event per request isolates a bad one), record Meta's answer. */
export async function sendDue(businessId: string, deadline: number) {
  const conn = await prisma.metaCapiConnection.findUnique({ where: { businessId } });
  if (!conn) return { sent: 0 };
  // Events older than Meta's 7-day window can't be accepted any more – shown as expired, never silently dropped.
  await prisma.metaCapiEvent.updateMany({ where: { businessId, status: { in: ["queued", "pending_data"] }, occurredAt: { lt: new Date(Date.now() - 7 * 86400_000 + 3600_000) } }, data: { status: "expired", statusReason: "עברו 7 ימים מהאירוע – מטא לא מקבלת אירועים ישנים יותר" } });
  if (!conn.enabled || conn.status !== "ok") return { sent: 0, paused: true };
  const token = openSecret(conn.tokenSealed); if (!token) return { sent: 0 };
  await prisma.metaCapiEvent.updateMany({ where: { businessId, status: "sending", lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: "queued" } });
  let sent = 0;
  while (Date.now() < deadline) {
    const next = await prisma.metaCapiEvent.findFirst({ where: { businessId, status: "queued", nextAttemptAt: { lte: new Date() } }, orderBy: { occurredAt: "asc" } });
    if (!next) break;
    const claimed = await prisma.metaCapiEvent.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "sending", lockedAt: new Date(), attempts: { increment: 1 } } });
    if (!claimed.count) continue; // another worker took it
    const r = await postEvents(conn.datasetId, token, [next.payload], next.testCode);
    if (r.ok) {
      await prisma.metaCapiEvent.update({ where: { id: next.id }, data: { status: "received", receivedAt: new Date(), fbtraceId: r.fbtraceId, lastError: null, lockedAt: null, statusReason: next.testCode ? "התקבל ב-API במצב בדיקה (Test events)" : "התקבל ב-API" } });
      sent++; continue;
    }
    const attempts = next.attempts + 1;
    if (r.kind === "auth" || r.kind === "permission") {
      // Authorization is gone: stop sending, keep the events queued (not burned) until the connection is fixed.
      await prisma.metaCapiConnection.update({ where: { businessId }, data: { status: "revoked", enabled: false, lastError: r.error } });
      await prisma.metaCapiEvent.update({ where: { id: next.id }, data: { status: "queued", attempts: next.attempts, lockedAt: null, lastError: r.error } });
      break;
    }
    const retry = (r.kind === "transient" || r.kind === "throttle") && attempts < MAX_ATTEMPTS;
    await prisma.metaCapiEvent.update({ where: { id: next.id }, data: retry
      ? { status: "queued", lockedAt: null, lastError: r.error, nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000) }
      : { status: "failed", lockedAt: null, lastError: r.error } });
    if (r.kind === "throttle") break;
  }
  return { sent };
}

/** Safe manual retry: the same snapshot (same event_id) – Meta deduplicates if the first one did arrive. */
export async function retryEvent(user: SessionUser, id: string) {
  const e = await prisma.metaCapiEvent.findFirst({ where: { id } });
  if (!e) throw new ApiError("האירוע לא נמצא", 404, "not_found");
  if (!["failed", "pending_data"].includes(e.status)) throw new ApiError("אפשר לנסות שוב רק אירוע שנכשל או שהושלמו נתוניו", 409, "not_retryable");
  if (e.status === "pending_data") {
    // Data may have been completed since: re-evaluate the value (same event_id / dedupe key).
    const rule = e.ruleId ? await prisma.metaCapiRule.findFirst({ where: { id: e.ruleId } }) : null;
    if (!rule) throw new ApiError("הכלל נמחק", 409, "rule_gone");
    const v = await valueOf(rule, { trigger: rule.trigger as Trigger, contactId: e.contactId, entityType: e.entityType, entityId: e.entityId, occurredAt: e.occurredAt, occurrenceKey: e.id, dealId: e.entityType === "deal" ? e.entityId : null, paymentId: e.entityType === "payment" ? e.entityId : null });
    if (v.missing) throw new ApiError(`עדיין חסרים נתונים: ${v.missing}`, 409, "still_missing");
    const payload = e.payload as { custom_data?: Record<string, unknown> };
    await prisma.metaCapiEvent.update({ where: { id: e.id }, data: { value: v.value, currency: v.currency, payload: { ...payload, custom_data: { ...(payload.custom_data ?? {}), value: v.value, currency: v.currency } } as Prisma.InputJsonValue, status: "queued", statusReason: null, nextAttemptAt: new Date() } });
  } else await prisma.metaCapiEvent.update({ where: { id: e.id }, data: { status: "queued", nextAttemptAt: new Date(), lastError: null } });
  await audit(user.businessId, user.id, "marketing", e.id, "capi.event_retry", { eventId: e.eventId });
  return { queued: true };
}

/** Cron: every business with a connection – payments scan + sending, each inside its own tenant context. */
export async function runCapiJob(opts: { deadline: number; businessId?: string }) {
  const { withBusiness } = await import("@/lib/tenant");
  const { db } = await import("@/lib/db");
  const conns = await db.metaCapiConnection.findMany({ where: opts.businessId ? { businessId: opts.businessId } : {}, select: { businessId: true } });
  const out: Array<{ businessId: string; sent: number }> = [];
  for (const { businessId } of conns) {
    if (Date.now() >= opts.deadline) break;
    const r = await withBusiness(businessId, async () => { await scanPayments(businessId); return sendDue(businessId, opts.deadline); }).catch(() => ({ sent: 0 }));
    out.push({ businessId, sent: r.sent });
  }
  return out;
}

/** What a rule would send for a sample occurrence – identifiers shown only as field names (no personal data). */
export function previewPayload(rule: RuleInput, connection: { leadEventSource: string } | null) {
  const fields = ["external_id (SHA-256)", "em (SHA-256, אם יש אימייל)", "ph (SHA-256, אם יש טלפון)", "fn / ln (SHA-256, אם יש שם פרטי ומשפחה)", "ct (SHA-256, אם יש עיר)", "fbc / fbp (כפי שנשמרו בקליטה, אם יש)", ...(rule.actionSource === "system_generated" ? ["lead_id (מזהה הליד של מטא, ללא hashing, אם הליד הגיע מטופס לידים)"] : [])];
  const value = rule.valueSource === "none" ? null : rule.valueSource === "fixed" ? `${rule.fixedValue} ${rule.currency}` : `${VALUE_SOURCES[rule.valueSource]}${rule.currency ? ` (${rule.currency})` : " + המטבע שלו"}`;
  return {
    event_name: rule.eventName, action_source: rule.actionSource, event_time: "מועד האירוע ב-CRM", event_id: rule.eventName === "Purchase" ? "purchase-deal-<מזהה עסקה> / purchase-payment-<מזהה תשלום>" : `${rule.eventName}-<סוג>-<מזהה>`,
    user_data: fields, custom_data: { ...(value ? { value_and_currency: value } : {}), ...(rule.actionSource === "system_generated" ? { event_source: "crm", lead_event_source: connection?.leadEventSource ?? "UltraCRM" } : {}) },
    never_sent: ["כתובת IP / User Agent", "תוכן שיחות והודעות", "הערות חופשיות", "מידע רפואי / רגיש"],
  };
}
