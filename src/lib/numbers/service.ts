/**
 * Number management: provider connection check, inventory sync, quotes, purchases (explicit
 * confirmation, never double-charged, reconciled after ambiguous results), campaign policies,
 * and reputation (manual reports only – no authorised Truecaller API).
 */
import { db, prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/auth";
import { lockNumberPool, numberPolicySchema } from "./selection";
import { numberConfig, numberProviderFor, type NumberProvider, type NumberOffer } from "./providers";

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/** Server-side throttle for management actions (per business, per minute), recorded in the audit log. */
export async function numberOperationLimit(businessId: string, userId: string, action: string) {
  await prisma.$transaction(async (tx) => {
    await lockNumberPool(tx, businessId);
    const recent = await tx.auditLog.count({ where: { businessId, action: "numbers.api_request", createdAt: { gte: new Date(Date.now() - 60000) } } });
    if (recent >= 20) throw new ApiError("יותר מדי בקשות לניהול מספרים; נסה בעוד דקה", 429, "rate_limited");
    await audit(businessId, userId, "numbers", businessId, "numbers.api_request", { action }, tx);
  });
}

export async function checkNumberConnection(businessId: string, provider: NumberProvider = numberProviderFor(businessId)) {
  try {
    const result = await provider.test();
    await prisma.$transaction(async (tx) => {
      await lockNumberPool(tx, businessId);
      const b = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
      await tx.business.update({ where: { id: businessId }, data: { settings: { ...(b.settings as object), numberProviderChannelLimit: result.channelLimit } } });
      await tx.numberConnection.upsert({ where: { businessId }, create: { businessId, status: "verified", checkedAt: new Date(), fingerprint: numberConfig(businessId).fingerprint }, update: { status: "verified", checkedAt: new Date(), error: null, fingerprint: numberConfig(businessId).fingerprint } });
    });
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "בדיקת חיבור לספק נכשלה";
    await db.numberConnection.upsert({ where: { businessId }, create: { businessId, status: "failed", checkedAt: new Date(), error: message }, update: { status: "failed", checkedAt: new Date(), error: message } });
    throw new ApiError(`בדיקת חיבור לספק נכשלה; החיבור אינו מאומת (${message})`, 502, "connection_check_failed");
  }
  return db.numberConnection.findUniqueOrThrow({ where: { businessId } });
}

export async function syncNumbers(businessId: string, provider: NumberProvider = numberProviderFor(businessId)) {
  try {
    await checkNumberConnection(businessId, provider);
    const inventory = await provider.inventory();
    const seen: string[] = [];
    for (const item of inventory) {
      // Only this application's inventory is imported. Never claim an unrelated account number.
      if (item.connectionId !== provider.connectionId) continue;
      await prisma.$transaction(async (tx) => {
        await lockNumberPool(tx, businessId);
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"phone-number:" + item.e164}, 0))`);
        if (await db.phoneNumber.findFirst({ where: { e164: item.e164, businessId: { not: businessId } } })) throw new ApiError("מספר הספק משויך לעסק אחר", 409, "number_tenant_conflict");
        const data = { providerNumberId: item.id, verificationStatus: item.status === "active" ? "verified" : "inactive", verifiedAt: new Date(), providerData: json(item) };
        await tx.phoneNumber.upsert({ where: { businessId_e164: { businessId, e164: item.e164 } }, create: { businessId, e164: item.e164, provider: provider.name === "mock" ? "mock" : "telnyx", isActive: item.status === "active", ...data }, update: data });
      });
      seen.push(item.e164);
    }
    // A full, successful inventory response can revoke verification – never delete history.
    await prisma.phoneNumber.updateMany({ where: { businessId, e164: { notIn: seen } }, data: { verificationStatus: "unverified", verifiedAt: new Date() } });
    return { synced: seen.length };
  } catch (err) {
    await db.numberConnection.updateMany({ where: { businessId }, data: { status: "failed", error: "סנכרון מלאי לא הושלם; נדרש אימות מחדש" } });
    throw err;
  }
}

export async function createNumberQuote(user: SessionUser, offer: { e164: string; country: string; type: string }, provider: NumberProvider = numberProviderFor(user.businessId)) {
  requireRole(user, "owner");
  const fresh = (await provider.search(offer.country, offer.type, offer.e164)).find((n) => n.e164 === offer.e164);
  if (!fresh) throw new ApiError("המספר אינו זמין אצל הספק", 409, "number_unavailable");
  if (!fresh.currency || fresh.upfront === null || fresh.monthly === null) throw new ApiError("הספק לא החזיר מחיר מלא; יש לרכוש דרך פורטל הספק", 409, "price_unavailable");
  return prisma.$transaction(async (tx) => {
    await lockNumberPool(tx, user.businessId);
    const existing = await tx.numberOrder.findUnique({ where: { businessId_provider_e164: { businessId: user.businessId, provider: provider.name, e164: fresh.e164 } } });
    if (existing && existing.state !== "quoted") return existing; // never reset an uncertain/submitted purchase
    if (await db.phoneNumber.findFirst({ where: { e164: fresh.e164 } })) throw new ApiError("המספר כבר קיים במערכת", 409, "number_already_registered");
    const data = { quote: json(fresh), expiresAt: new Date(Date.now() + 300000) };
    return existing ? tx.numberOrder.update({ where: { id: existing.id }, data }) : tx.numberOrder.create({ data: { businessId: user.businessId, provider: provider.name, e164: fresh.e164, ...data } });
  });
}

export async function confirmNumberPurchase(user: SessionUser, id: string, confirmed: boolean, provider: NumberProvider = numberProviderFor(user.businessId)) {
  requireRole(user, "owner");
  if (!confirmed) throw new ApiError("נדרש אישור מפורש למחיר ולרכישה", 400, "confirmation_required");
  const cfg = numberConfig(user.businessId);
  if (!cfg.purchasesEnabled) throw new ApiError("רכישות אמיתיות לא הופעלו בשרת (NUMBER_PURCHASES_ENABLED); לא בוצע חיוב", 409, "purchases_disabled");
  await checkNumberConnection(user.businessId, provider);
  const order = await prisma.$transaction(async (tx) => {
    await lockNumberPool(tx, user.businessId);
    const o = await tx.numberOrder.findFirst({ where: { id, businessId: user.businessId, provider: provider.name } });
    if (!o) throw new ApiError("הזמנה לא נמצאה", 404, "not_found");
    if (o.state !== "quoted") return null; // a second click must reconcile, never place another order
    if (o.expiresAt.getTime() < Date.now()) throw new ApiError("הצעת המחיר פגה; יש לקבל הצעה חדשה", 409, "quote_expired");
    const claimed = await tx.numberOrder.update({ where: { id }, data: { state: "submitting", confirmedBy: user.id, confirmedAt: new Date(), error: null } });
    await audit(user.businessId, user.id, "number_order", id, "number.purchase_confirmed", { quote: o.quote, simulated: cfg.simulated }, tx);
    return claimed;
  });
  if (!order) return reconcileNumberOrder(user, id, provider);
  try {
    // Check the quote immediately before any charge. A price change requires a new explicit approval.
    const quote = order.quote as unknown as NumberOffer;
    const fresh = (await provider.search(quote.country, quote.type, order.e164)).find((n) => n.e164 === order.e164);
    if (!fresh || fresh.upfront !== quote.upfront || fresh.monthly !== quote.monthly || fresh.currency !== quote.currency) {
      await prisma.numberOrder.update({ where: { id }, data: { state: "quoted", expiresAt: new Date(0), error: "המחיר או זמינות המספר השתנו; נדרש אישור להצעה חדשה" } });
      throw new ApiError("המחיר או זמינות המספר השתנו; לא בוצעה רכישה", 409, "quote_changed");
    }
    const result = await provider.purchase(order.e164, order.id);
    if (!result.numbers.includes(order.e164) || result.reference !== order.id) throw new Error("ambiguous order response");
    await prisma.numberOrder.update({ where: { id }, data: { state: "pending", providerOrderId: result.id, providerStatus: result.status } });
  } catch (err) {
    if (err instanceof ApiError && err.code === "quote_changed") throw err;
    // Even errors can hide a successful charge. Never retry the POST automatically.
    await prisma.numberOrder.updateMany({ where: { id, state: "submitting" }, data: { state: "unknown", error: "תוצאת הרכישה אינה ודאית; יש לברר מצב אצל הספק לפני כל פעולה נוספת" } });
  }
  return reconcileNumberOrder(user, id, provider);
}

export async function reconcileNumberOrder(user: SessionUser, id: string, provider: NumberProvider = numberProviderFor(user.businessId)) {
  requireRole(user, "owner");
  const order = await prisma.numberOrder.findFirst({ where: { id, businessId: user.businessId, provider: provider.name } });
  if (!order) throw new ApiError("הזמנה לא נמצאה", 404, "not_found");
  if (order.state === "quoted" || order.state === "ready") return order;
  try {
    const found = await provider.findOrders(id);
    if (found.length !== 1 || !found[0].numbers.includes(order.e164)) return order; // no evidence is not permission to purchase again
    const remote = found[0];
    await prisma.numberOrder.update({ where: { id }, data: { providerOrderId: remote.id, providerStatus: remote.status, state: remote.status === "success" ? "configuring" : "pending" } });
    if (remote.status !== "success") return prisma.numberOrder.findUniqueOrThrow({ where: { id } });
    let owned = (await provider.inventory()).find((n) => n.e164 === order.e164);
    if (!owned) throw new Error("Purchased number missing from inventory");
    if (owned.connectionId !== provider.connectionId) await provider.configure(owned.id);
    owned = (await provider.inventory()).find((n) => n.e164 === order.e164);
    if (!owned || owned.status !== "active" || owned.connectionId !== provider.connectionId) throw new Error("Number not ready");
    await syncNumbers(user.businessId, provider);
    await prisma.phoneNumber.update({ where: { businessId_e164: { businessId: user.businessId, e164: order.e164 } }, data: { costs: json(order.quote) } });
    await prisma.numberOrder.update({ where: { id }, data: { state: "ready", error: null } });
    await audit(user.businessId, user.id, "number_order", id, "number.purchase_ready", { providerOrderId: remote.id });
  } catch {
    await prisma.numberOrder.update({ where: { id }, data: { error: "בירור או הגדרת המספר לא הושלמו. אין לבצע רכישה נוספת; נסה בירור מצב שוב." } });
  }
  return prisma.numberOrder.findUniqueOrThrow({ where: { id } });
}

export async function saveNumberPolicy(user: SessionUser, listId: string, raw: unknown) {
  requireRole(user, "manager"); const policy = numberPolicySchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    await lockNumberPool(tx, user.businessId);
    const list = await tx.dialList.findFirst({ where: { id: listId, businessId: user.businessId } });
    if (!list) throw new ApiError("קמפיין לא נמצא", 404, "not_found");
    const ids = [...new Set(policy.numberIds)];
    if (ids.length !== await tx.phoneNumber.count({ where: { id: { in: ids }, businessId: user.businessId } })) throw new ApiError("שיוך מספרים לא מורשה", 400, "invalid_number_pool");
    if (policy.mode === "fixed" && ids.length > 1) throw new ApiError("יש לבחור מספר קבוע אחד", 400, "invalid_number_pool");
    if (policy.mode !== "fixed" && !ids.length) throw new ApiError("יש לבחור מאגר מספרים לקמפיין", 400, "empty_number_pool");
    await audit(user.businessId, user.id, "list", listId, "number.policy_changed", policy, tx);
    return tx.dialList.update({ where: { id: listId }, data: { numberPolicy: policy, phoneNumberId: policy.mode === "fixed" ? ids[0] ?? null : null } });
  });
}

/** Overview for the management screen (no secrets). */
export async function numbersOverview(user: SessionUser, days: number) {
  const since = new Date(Date.now() - days * 86400000);
  const businessId = user.businessId;
  const [numbers, attempts, answered, connection, orders, lists, users] = await Promise.all([
    prisma.phoneNumber.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
    prisma.call.groupBy({ by: ["phoneNumberId"], where: { businessId, direction: "outbound", createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.call.groupBy({ by: ["phoneNumberId"], where: { businessId, direction: "outbound", createdAt: { gte: since }, answeredAt: { not: null } }, _count: { _all: true } }),
    db.numberConnection.findUnique({ where: { businessId } }),
    prisma.numberOrder.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.dialList.findMany({ where: { businessId, archivedAt: null }, select: { id: true, name: true, phoneNumberId: true, numberPolicy: true } }),
    prisma.user.findMany({ where: { businessId, isActive: true }, select: { id: true, fullName: true } }),
  ]);
  const cfg = numberConfig(businessId);
  const { connectionFresh } = await import("./selection");
  const verified = connectionFresh(connection, businessId);
  const telephonySimulation = (process.env.TELEPHONY_PROVIDER ?? "mock") !== "telnyx";
  return {
    days, since,
    numbers: numbers.map((n) => { const a = attempts.find((c) => c.phoneNumberId === n.id)?._count._all ?? 0, b = answered.find((c) => c.phoneNumberId === n.id)?._count._all ?? 0; return { ...n, attempts: a, answered: b, answerRate: a ? Math.round(b / a * 100) : null, verificationStale: !n.verifiedAt || Date.now() - n.verifiedAt.getTime() > 86400000, reputationStale: !!n.reputationCheckedAt && Date.now() - n.reputationCheckedAt.getTime() > 7 * 86400000 }; }),
    orders, lists, users, role: user.role,
    provider: { name: cfg.provider === "mock" ? "הדמיה" : "Telnyx", key: cfg.provider, configured: cfg.configured, status: verified ? "verified" : connection?.status === "failed" ? "failed" : cfg.configured ? "unverified" : "unconfigured", checkedAt: connection?.checkedAt ?? null, error: connection?.error ?? null, purchasesEnabled: cfg.purchasesEnabled, simulated: cfg.simulated, portal: "https://portal.telnyx.com/#/voice/my-numbers" },
    reputation: { status: "unsupported", source: "Truecaller", message: "לא קיימת בחיבור הנוכחי הרשאה מאומתת ל-API מוניטין של Truecaller. API לזיהוי משתמשים/מתקשר אינו בדיקת ספאם. בדיקות אוטומטיות ומתוזמנות אינן זמינות – ניתן לתעד בדיקה ידנית ולפתוח טיפול/ערעור מול הספק.", portal: "https://business.truecaller.com/" },
    simulation: telephonySimulation || cfg.simulated,
  };
}
