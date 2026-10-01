/**
 * Payments taken during a call (or any time) through the business's own card-payment provider.
 *
 *  • Only the provider's hosted page ever sees card details (embedded in the call screen, or a link sent to the
 *    customer). Nothing card-related is stored, logged, transcribed or sent to the AI.
 *  • One request per idempotency key (double click / network retry → the same request, the same page); an open
 *    request for the same customer + item + call is reused instead of creating a second page.
 *  • Status comes only from the provider: a verified notification (signature) is followed by a server-to-server
 *    status check; the call screen also polls the provider for a pending request (missed / late notifications).
 *    Closing the window changes nothing. A payment confirmed after a local cancel is shown as paid (late).
 *  • Amount = the price of the chosen product / quote / deal; a different amount needs "שינוי סכום בגבייה".
 *  • Everything is per business (tenant scope + RLS); a notification is routed by its connection id and verified
 *    with that connection's own secret.
 */
import crypto from "node:crypto";
import { prisma, db, type Db } from "@/lib/db";
import type { PaymentRequest, Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sealSecret } from "@/lib/crypto";
import { appBase } from "@/lib/store-urls";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { can, effectiveAccess } from "@/lib/access/engine";
import { canAccessContact } from "@/lib/crm/lead-ops";
import { configOf, payplusProvider, sandboxProvider, type PaymentProvider, type ProviderStatus } from "@/lib/payments/providers";

const MAX_AGOROT = 10_000_000; // ₪100,000 per request
const OPEN = ["created", "pending"];
type Conn = { id: string; businessId: string; provider: string; environment: string; config: unknown };

export function providerFor(conn: Conn): PaymentProvider {
  const cfg = configOf(conn.config);
  if (conn.provider === "payplus") return payplusProvider({ ...cfg, environment: conn.environment });
  return sandboxProvider(cfg, {
    appBase: appBase(),
    lookupResult: async (prid) => {
      const e = await prisma.paymentEvent.findFirst({ where: { businessId: conn.businessId, provider: "sandbox", kind: "sandbox_result", summary: { path: ["providerRequestId"], equals: prid } }, orderBy: { receivedAt: "desc" } });
      const r = (e?.summary as { result?: string } | undefined)?.result;
      return r === "approved" || r === "declined" ? r : null;
    },
  });
}

const view = (r: { id: string; status: string; amountAgorot: number; currency: string; description: string; paymentUrl: string | null; provider: string; approvalNumber: string | null; receiptUrl: string | null; failureReason: string | null; lateConfirmation: boolean; confirmedAt: Date | null; cancelledAt: Date | null; createdAt: Date; sourceType: string; sourceId: string | null; callId: string | null; sentVia: string | null; listAmountAgorot: number | null }) => ({
  id: r.id, status: r.status, amountAgorot: r.amountAgorot, currency: r.currency, description: r.description, provider: r.provider,
  paymentUrl: OPEN.includes(r.status) ? r.paymentUrl : null, approvalNumber: r.approvalNumber, receiptUrl: r.receiptUrl, failureReason: r.failureReason,
  lateConfirmation: r.lateConfirmation, confirmedAt: r.confirmedAt, cancelledAt: r.cancelledAt, createdAt: r.createdAt, sourceType: r.sourceType, sourceId: r.sourceId, callId: r.callId, sentVia: r.sentVia, listAmountAgorot: r.listAmountAgorot,
});

// ─── connection (owner) ──────────────────────────────────────────────────────────────────────────────────────────
export async function connectPaymentProvider(user: SessionUser, input: { provider: "payplus" | "sandbox"; environment: "test" | "live"; apiKey?: string; secretKey?: string; paymentPageUid?: string; label?: string }) {
  if (user.role !== "owner") throw new ApiError("רק בעל העסק יכול לחבר ספק סליקה", 403, "forbidden");
  if (input.provider === "payplus" && (!input.apiKey || !input.secretKey || !input.paymentPageUid)) throw new ApiError("ל-PayPlus נדרשים API key, Secret key ו-Payment page UID", 400, "validation");
  if (input.provider === "sandbox" && input.environment === "live") throw new ApiError("ספק הבדיקה אינו מחייב – אפשר רק בסביבת בדיקה", 400, "validation");
  const config = input.provider === "sandbox" ? { secretKey: sealSecret(crypto.randomBytes(24).toString("hex")) } : { apiKey: sealSecret(input.apiKey!), secretKey: sealSecret(input.secretKey!), paymentPageUid: input.paymentPageUid };
  const conn = await prisma.$transaction(async (tx) => {
    await tx.paymentProviderConnection.updateMany({ where: { businessId: user.businessId, isActive: true }, data: { isActive: false } });
    return tx.paymentProviderConnection.create({ data: { businessId: user.businessId, provider: input.provider, environment: input.environment, label: input.label ?? null, config: config as Prisma.InputJsonValue, createdById: user.id } });
  });
  await audit(user.businessId, user.id, "payment_connection", conn.id, "payment.provider_connected", { provider: input.provider, environment: input.environment });
  return connectionSummary(user.businessId);
}
export async function disconnectPaymentProvider(user: SessionUser) {
  if (user.role !== "owner") throw new ApiError("רק בעל העסק יכול לנתק ספק סליקה", 403, "forbidden");
  const r = await prisma.paymentProviderConnection.updateMany({ where: { businessId: user.businessId, isActive: true }, data: { isActive: false } });
  await audit(user.businessId, user.id, "payment_connection", user.businessId, "payment.provider_disconnected", { count: r.count });
  return connectionSummary(user.businessId);
}
export async function connectionSummary(businessId: string) {
  const c = await prisma.paymentProviderConnection.findFirst({ where: { businessId, isActive: true }, orderBy: { createdAt: "desc" } });
  return c ? { connected: true, id: c.id, provider: c.provider, environment: c.environment, label: c.label, webhookUrl: `${appBase()}/api/webhooks/payments/${c.id}`, lastError: c.lastError } : { connected: false as const };
}

// ─── what can be paid for ────────────────────────────────────────────────────────────────────────────────────────
async function mayEditAmount(user: SessionUser) { const a = await effectiveAccess(user.businessId, user.id).catch(() => null); return Boolean(a && can(a, "crm.payment_amount")); }
async function contactFor(user: SessionUser, contactId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId }, select: { id: true, fullName: true, phoneE164: true, email: true, ownerUserId: true } });
  if (!c || !(await canAccessContact(user, c))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  return c;
}
const withTax = (unit: number, taxBps: number) => Math.round(unit * (1 + taxBps / 10_000));

export async function paymentOptions(user: SessionUser, contactId: string, callId?: string | null) {
  const c = await contactFor(user, contactId);
  const [conn, products, quotes, deals, recent] = await Promise.all([
    connectionSummary(user.businessId),
    prisma.salesOffer.findMany({ where: { businessId: user.businessId, active: true }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true, unitAmount: true, taxBps: true, currency: true } }),
    prisma.salesQuote.findMany({ where: { businessId: user.businessId, lead: { contactId: c.id }, status: { in: ["approved", "accepted"] } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, total: true, currency: true, status: true, revision: true } }),
    prisma.deal.findMany({ where: { businessId: user.businessId, contactId: c.id, status: "open" }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, amount: true, currency: true } }),
    prisma.paymentRequest.findMany({ where: { businessId: user.businessId, contactId: c.id, ...(callId ? { OR: [{ callId }, { status: { in: OPEN } }] } : {}) }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return {
    connection: conn, canEditAmount: await mayEditAmount(user),
    customer: { id: c.id, name: c.fullName, phone: c.phoneE164, email: c.email },
    products: products.map((p) => ({ id: p.id, name: p.name, amountAgorot: withTax(p.unitAmount, p.taxBps), currency: p.currency })),
    quotes: quotes.map((q) => ({ id: q.id, name: `${q.title} (גרסה ${q.revision})`, amountAgorot: q.total, currency: q.currency })),
    deals: deals.map((d) => ({ id: d.id, name: d.title, amountAgorot: Math.round(Number(d.amount) * 100), currency: d.currency })),
    requests: recent.map(view),
  };
}

async function listPrice(user: SessionUser, contactId: string, source: { type: "product" | "quote" | "deal" | "custom"; id?: string | null }) {
  if (source.type === "product") {
    const p = await prisma.salesOffer.findFirst({ where: { id: source.id ?? "", businessId: user.businessId, active: true } });
    if (!p) throw new ApiError("המוצר לא נמצא", 404, "not_found");
    return { amount: withTax(p.unitAmount, p.taxBps), currency: p.currency, description: p.name };
  }
  if (source.type === "quote") {
    const q = await prisma.salesQuote.findFirst({ where: { id: source.id ?? "", businessId: user.businessId, lead: { contactId }, status: { in: ["approved", "accepted"] } } });
    if (!q) throw new ApiError("ההצעה לא נמצאה ללקוח הזה", 404, "not_found");
    return { amount: q.total, currency: q.currency, description: q.title };
  }
  if (source.type === "deal") {
    const d = await prisma.deal.findFirst({ where: { id: source.id ?? "", businessId: user.businessId, contactId, status: "open" } });
    if (!d) throw new ApiError("העסקה לא נמצאה ללקוח הזה", 404, "not_found");
    return { amount: Math.round(Number(d.amount) * 100), currency: d.currency, description: d.title };
  }
  return { amount: null, currency: "ILS", description: "תשלום" };
}

// ─── create / read / cancel ──────────────────────────────────────────────────────────────────────────────────────
type CreatePaymentInput = { contactId: string; callId?: string | null; source: { type: "product" | "quote" | "deal" | "custom"; id?: string | null }; amountAgorot?: number | null; description?: string | null; idempotencyKey: string };

function validateReplay(existing: PaymentRequest, user: SessionUser, input: CreatePaymentInput) {
  if (existing.agentId !== user.id || existing.contactId !== input.contactId || existing.callId !== (input.callId ?? null)
    || existing.sourceType !== input.source.type || existing.sourceId !== (input.source.id ?? null)
    || (input.amountAgorot != null && existing.amountAgorot !== input.amountAgorot)
    || (input.description?.trim() && existing.description !== input.description.trim().slice(0, 200))) {
    throw new ApiError("מפתח הבקשה כבר משויך לתשלום אחר. יש ליצור בקשה חדשה", 400, "bad_idempotency_key");
  }
  return existing;
}

export async function createPaymentRequest(user: SessionUser, input: CreatePaymentInput) {
  const key = { businessId_idempotencyKey: { businessId: user.businessId, idempotencyKey: input.idempotencyKey } };
  const existing = await prisma.paymentRequest.findUnique({ where: key });
  if (existing) return view(validateReplay(existing, user, input));
  const c = await contactFor(user, input.contactId);
  const connRow = await prisma.paymentProviderConnection.findFirst({ where: { businessId: user.businessId, isActive: true }, orderBy: { createdAt: "desc" } });
  if (!connRow) throw new ApiError("לא חובר ספק סליקה לעסק. בעל העסק יכול לחבר אותו בהגדרות → תשלומים", 409, "no_provider");
  if (input.callId && !(await prisma.call.findFirst({ where: { id: input.callId, businessId: user.businessId, contactId: c.id }, select: { id: true } }))) throw new ApiError("השיחה אינה של הלקוח הזה", 400, "bad_call");
  const price = await listPrice(user, c.id, input.source);
  let amount = price.amount;
  if (input.amountAgorot != null && input.amountAgorot !== price.amount) {
    if (!(await mayEditAmount(user))) throw new ApiError("אין לך הרשאה לשנות את הסכום", 403, "amount_forbidden");
    amount = input.amountAgorot;
  }
  if (amount == null || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AGOROT) throw new ApiError("סכום לא תקין", 400, "bad_amount");
  // Reserve atomically, including retries with different keys. Keep the provider request outside the transaction.
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-key:${user.businessId}:${input.idempotencyKey}`}, 0))`;
    const replay = await tx.paymentRequest.findUnique({ where: key });
    if (replay) return { request: validateReplay(replay, user, input), created: false };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-contact:${user.businessId}:${c.id}`}, 0))`;
    const open = await tx.paymentRequest.findFirst({ where: { businessId: user.businessId, contactId: c.id, callId: input.callId ?? null, sourceType: input.source.type, sourceId: input.source.id ?? null, amountAgorot: amount, currency: price.currency, status: { in: OPEN } }, orderBy: { createdAt: "desc" } });
    if (open) return { request: open, created: false };
    const request = await tx.paymentRequest.create({ data: {
      businessId: user.businessId, connectionId: connRow.id, provider: connRow.provider, contactId: c.id, callId: input.callId ?? null, agentId: user.id,
      sourceType: input.source.type, sourceId: input.source.id ?? null, description: (input.description?.trim() || price.description).slice(0, 200),
      amountAgorot: amount, currency: price.currency, listAmountAgorot: price.amount, amountEditedById: price.amount !== null && amount !== price.amount ? user.id : null, idempotencyKey: input.idempotencyKey,
    } });
    return { request, created: true };
  });
  let req = reservation.request;
  if (!reservation.created) return view(req);
  try {
    const page = await providerFor(connRow).createPage({ amountAgorot: amount, currency: price.currency, description: req.description, reference: req.id, callbackUrl: `${appBase()}/api/webhooks/payments/${connRow.id}`, customer: { name: c.fullName, email: c.email, phone: c.phoneE164 } });
    req = await prisma.$transaction(async (tx) => {
      // Keep provider identifiers for reconciliation, but never undo a cancellation made while awaiting the page.
      await tx.paymentRequest.update({ where: { id: req.id }, data: { providerRequestId: page.providerRequestId, paymentUrl: page.paymentUrl } });
      await tx.paymentRequest.updateMany({ where: { id: req.id, status: "created" }, data: { status: "pending" } });
      return tx.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    });
  } catch (e) {
    await prisma.paymentRequest.updateMany({ where: { id: req.id, status: "created" }, data: { status: "failed", failureReason: `לא נוצר עמוד תשלום אצל הספק (לא בוצע חיוב): ${(e as Error).message.slice(0, 160)}` } });
    req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
  }
  await audit(user.businessId, user.id, "payment", req.id, "payment.requested", { contactId: c.id, callId: req.callId, amountAgorot: amount, edited: Boolean(req.amountEditedById), source: input.source.type, status: req.status });
  return view(req);
}

/** Apply the provider's authoritative answer (idempotent; never downgrades a confirmed payment). */
async function applyStatus(requestId: string, s: ProviderStatus, tx: Db = prisma) {
  const r = await tx.paymentRequest.findUnique({ where: { id: requestId } });
  if (!r) return null;
  if (s.status === "succeeded" && r.status !== "succeeded") {
    const late = r.status === "cancelled";
    const mismatch = s.amountAgorot != null && s.amountAgorot !== r.amountAgorot ? `הספק אישר סכום שונה: ${(s.amountAgorot / 100).toFixed(2)}` : null;
    const u = await tx.paymentRequest.updateMany({ where: { id: r.id, status: { not: "succeeded" } }, data: { status: "succeeded", confirmedAt: new Date(), providerTransactionId: s.transactionId ?? null, approvalNumber: s.approvalNumber ?? null, receiptUrl: s.receiptUrl ?? null, lateConfirmation: late, failureReason: mismatch } });
    if (u.count) await audit(r.businessId, null, "payment", r.id, "payment.succeeded", { amountAgorot: s.amountAgorot ?? r.amountAgorot, late, agentId: r.agentId, contactId: r.contactId, source: r.sourceType, sourceId: r.sourceId }, tx);
  } else if (s.status === "failed" && OPEN.includes(r.status)) {
    const u = await tx.paymentRequest.updateMany({ where: { id: r.id, status: { in: OPEN } }, data: { status: "failed", failureReason: s.reason ?? "התשלום נדחה אצל הספק" } });
    if (u.count) await audit(r.businessId, null, "payment", r.id, "payment.failed", { reason: s.reason ?? null }, tx);
  }
  await tx.paymentRequest.update({ where: { id: r.id }, data: { lastCheckedAt: new Date() } });
  return tx.paymentRequest.findUnique({ where: { id: r.id } });
}

async function ownRequest(user: SessionUser, id: string) {
  const r = await prisma.paymentRequest.findFirst({ where: { id, businessId: user.businessId } });
  if (!r) throw new ApiError("בקשת התשלום לא נמצאה", 404, "not_found");
  const contact = await prisma.contact.findFirst({ where: { id: r.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (r.agentId !== user.id && (!contact || !(await canAccessContact(user, contact)))) throw new ApiError("בקשת התשלום לא נמצאה", 404, "not_found");
  return r;
}

/** Status for the call screen; a pending request is re-checked with the provider (at most every 10 seconds). */
export async function getPaymentRequest(user: SessionUser, id: string) {
  let r = await ownRequest(user, id);
  if (["pending", "cancelled"].includes(r.status) && r.providerRequestId && (!r.lastCheckedAt || Date.now() - r.lastCheckedAt.getTime() > 10_000) && Date.now() - r.createdAt.getTime() < 7 * 86400_000) {
    const conn = await prisma.paymentProviderConnection.findUnique({ where: { id: r.connectionId } });
    if (conn) {
      try { r = (await applyStatus(r.id, await providerFor(conn).fetchStatus(r.providerRequestId))) ?? r; }
      catch (e) { await prisma.paymentRequest.update({ where: { id: r.id }, data: { lastCheckedAt: new Date() } }); console.warn("[payments] status check failed", (e as Error).message.slice(0, 160)); }
    }
  }
  return view(r);
}

export async function cancelPaymentRequest(user: SessionUser, id: string) {
  const r = await ownRequest(user, id);
  const u = await prisma.paymentRequest.updateMany({ where: { id: r.id, status: { in: OPEN } }, data: { status: "cancelled", cancelledAt: new Date() } });
  if (u.count) await audit(user.businessId, user.id, "payment", r.id, "payment.cancelled", {});
  return getPaymentRequest(user, id);
}

/** Send the payment link to the customer on WhatsApp (inside the 24h service window, like any manual reply). */
export async function sendPaymentLink(user: SessionUser, id: string) {
  const r = await ownRequest(user, id);
  if (!OPEN.includes(r.status) || !r.paymentUrl) throw new ApiError("אין קישור תשלום פעיל לשליחה", 409, "not_open");
  const { startConversationForAutomation } = await import("@/server/services/conversation-service");
  const { createOutboundMessage } = await import("@/server/services/message-service");
  const conv = await startConversationForAutomation(r.contactId, null, user.id);
  const body = `קישור לתשלום מאובטח: ${r.description} – ₪${(r.amountAgorot / 100).toFixed(2)}\n${r.paymentUrl}`;
  await createOutboundMessage({ conversationId: conv.id, body, sentByUserId: user.id, requestKey: `payment-link:${r.id}` });
  await prisma.paymentRequest.update({ where: { id: r.id }, data: { sentVia: "whatsapp" } });
  await audit(user.businessId, user.id, "payment", r.id, "payment.link_sent", { via: "whatsapp" });
  return view({ ...r, sentVia: "whatsapp" });
}

// ─── provider notifications ─────────────────────────────────────────────────────────────────────────────────────
export async function handlePaymentWebhook(connectionId: string, raw: string, headers: Headers) {
  const conn = await withoutBusiness(() => db.paymentProviderConnection.findUnique({ where: { id: connectionId } }));
  if (!conn) return { status: 404 as const };
  return withBusiness(conn.businessId, async () => {
    const provider = providerFor(conn);
    if (!provider.verifyCallback(raw, headers)) return { status: 401 as const };
    let body: unknown; try { body = JSON.parse(raw); } catch { return { status: 400 as const }; }
    const parsed = provider.parseCallback(body);
    const eventKey = parsed.eventKey ?? crypto.createHash("sha256").update(raw).digest("hex");
    const eventWhere = { provider: conn.provider, eventKey };
    if (await prisma.paymentEvent.findFirst({ where: eventWhere })) return { status: 200 as const, duplicate: true };
    if (!parsed.providerRequestId) return { status: 200 as const, ignored: "no request id" };
    const r = await prisma.paymentRequest.findFirst({ where: { businessId: conn.businessId, connectionId: conn.id, provider: conn.provider, providerRequestId: parsed.providerRequestId } });
    if (!r) return { status: 200 as const, ignored: "unknown request" };
    // Fetch before recording completion: a provider outage must leave this notification retryable.
    const s = await provider.fetchStatus(parsed.providerRequestId);
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-event:${conn.provider}:${eventKey}`}, 0))`;
      if (await tx.paymentEvent.findFirst({ where: eventWhere })) return { status: 200 as const, duplicate: true };
      await tx.paymentEvent.create({ data: { businessId: conn.businessId, provider: conn.provider, eventKey, paymentRequestId: r.id, kind: "notification", summary: { ...parsed.summary, providerRequestId: parsed.providerRequestId } as Prisma.InputJsonValue } });
      await applyStatus(r.id, s, tx);
      return { status: 200 as const, applied: s.status };
    });
  });
}

/** Sandbox test page: the tester's choice becomes the "provider state", then a signed notification is delivered. */
export async function sandboxDecision(providerRequestId: string, result: "approved" | "declined") {
  const r = await withoutBusiness(() => db.paymentRequest.findFirst({ where: { provider: "sandbox", providerRequestId } }));
  if (!r) throw new ApiError("עמוד התשלום לא נמצא", 404, "not_found");
  const conn = await withoutBusiness(() => db.paymentProviderConnection.findUnique({ where: { id: r.connectionId } }));
  if (!conn || conn.provider !== "sandbox") throw new ApiError("עמוד התשלום לא נמצא", 404, "not_found");
  await withBusiness(r.businessId, () => prisma.paymentEvent.create({ data: { businessId: r.businessId, provider: "sandbox", eventKey: `result:${providerRequestId}:${crypto.randomUUID()}`, kind: "sandbox_result", summary: { providerRequestId, result } } }));
  const raw = JSON.stringify({ page_request_uid: providerRequestId, event_id: `evt_${crypto.randomUUID()}`, result });
  const { signSandbox } = await import("@/lib/payments/providers");
  const headers = new Headers({ "user-agent": "UltraCRM-Sandbox", hash: signSandbox(configOf(conn.config).secretKey, raw) });
  return handlePaymentWebhook(conn.id, raw, headers);
}

export async function sandboxPage(providerRequestId: string) {
  const r = await withoutBusiness(() => db.paymentRequest.findFirst({ where: { provider: "sandbox", providerRequestId }, select: { description: true, amountAgorot: true, currency: true, status: true } }));
  return r;
}
