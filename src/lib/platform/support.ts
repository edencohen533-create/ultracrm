/**
 * Platform support access to a customer business – explicit, time-boxed, READ-ONLY, audited:
 *  • only a platform admin, with a written reason, for at most 60 minutes;
 *  • acts as a dedicated support identity of that business (User.isSupport – never a member: not in the business
 *    switcher, user lists, pickers, lead distribution or seats) holding view-only actions;
 *  • every request is re-validated against the session row (ended / expired / admin revoked → out at once) and every
 *    mutating request is refused server-side, as are secrets (reveal) and the telephony token (no dialing);
 *  • start / end are written to the business audit and the platform audit log.
 * An admin who is already a member of the business uses the regular business switcher – support is a separate path.
 */
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { requirePlatformAdmin, accessAudit } from "@/lib/access/manage";

export const SUPPORT_MAX_MINUTES = 60;

export async function startSupportSession(actor: SessionUser, businessId: string, input: { reason: string; minutes: number }) {
  await requirePlatformAdmin(actor);
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ApiError("יש לכתוב סיבה לכניסת התמיכה", 400, "reason_required");
  const minutes = Math.min(Math.max(5, Math.round(input.minutes)), SUPPORT_MAX_MINUTES);
  return withoutBusiness(async () => {
    const [biz, account] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } }),
      db.account.findUniqueOrThrow({ where: { id: actor.accountId }, select: { id: true, email: true, fullName: true } }),
    ]);
    if (!biz) throw new ApiError("עסק לא נמצא", 404, "not_found");
    const member = await db.user.findFirst({ where: { businessId, accountId: account.id, isSupport: false } });
    if (member) throw new ApiError("אתה חבר בעסק הזה – השתמש בבורר העסקים הרגיל", 409, "already_member");
    // The support identity: one per admin per business, inactive (never a membership), view-only permissions.
    const supportUser = await db.user.upsert({
      where: { businessId_accountId: { businessId, accountId: account.id } },
      create: { businessId, accountId: account.id, email: account.email, fullName: `תמיכת פלטפורמה – ${account.fullName}`, role: "manager", isActive: false, isSupport: true },
      update: { isSupport: true, isActive: false },
    });
    await db.supportSession.updateMany({ where: { accountId: account.id, endedAt: null }, data: { endedAt: new Date(), endedReason: "replaced" } });
    const session = await db.supportSession.create({ data: { businessId, accountId: account.id, userId: supportUser.id, reason, expiresAt: new Date(Date.now() + minutes * 60_000) } });
    await db.auditLog.create({ data: { businessId, actorId: null, entityType: "business", entityId: businessId, action: "platform.support_started", payload: { sessionId: session.id, adminAccountId: account.id, adminName: account.fullName, reason, minutes, mode: "read_only" } } });
    await accessAudit({ businessId, actorAccountId: account.id, action: "support.started", after: { sessionId: session.id, reason, minutes, mode: "read_only" } });
    const sessionUser: SessionUser = { id: supportUser.id, accountId: account.id, businessId, email: account.email, fullName: supportUser.fullName, role: "manager", teamId: null, sessionVersion: actor.sessionVersion ?? 0, supportSessionId: session.id };
    return { session, sessionUser, businessName: biz.name };
  });
}

/** Validates a support session for every request (called from revalidateSession). */
export async function activeSupportSession(sessionId: string, accountId: string, userId: string, businessId: string, sessionVersion: number) {
  return withoutBusiness(async () => {
    const s = await db.supportSession.findUnique({ where: { id: sessionId } });
    if (!s || s.endedAt || s.expiresAt <= new Date() || s.accountId !== accountId || s.userId !== userId || s.businessId !== businessId) return null;
    const a = await db.account.findUnique({ where: { id: accountId }, select: { isPlatformAdmin: true, isActive: true, sessionVersion: true } });
    if (!a?.isActive || !a.isPlatformAdmin || a.sessionVersion !== sessionVersion) return null;
    const b = await db.business.findUnique({ where: { id: businessId }, select: { name: true, isActive: true } });
    if (!b?.isActive) return null;
    return { id: s.id, expiresAt: s.expiresAt, businessName: b?.name ?? "" };
  });
}

export async function endSupportSession(sessionId: string, accountId: string, why = "ended_by_admin") {
  return withoutBusiness(async () => {
    const s = await db.supportSession.findUnique({ where: { id: sessionId } });
    if (!s || s.accountId !== accountId || s.endedAt || s.expiresAt <= new Date()) return null;
    const ended = await db.supportSession.updateMany({ where: { id: s.id, accountId, endedAt: null, expiresAt: { gt: new Date() } }, data: { endedAt: new Date(), endedReason: why } });
    if (!ended.count) return null;
    await db.auditLog.create({ data: { businessId: s.businessId, actorId: null, entityType: "business", entityId: s.businessId, action: "platform.support_ended", payload: { sessionId: s.id, reason: why } } });
    await accessAudit({ businessId: s.businessId, actorAccountId: accountId, action: "support.ended", after: { sessionId: s.id, reason: why } });
    return s;
  });
}

/** What a support (read-only) session may call. Everything else that is not GET is refused; some GETs too. */
const SUPPORT_MUTATION_ALLOW = [/^\/api\/platform\/support\/end$/, /^\/api\/auth\/logout$/];
const SUPPORT_GET_DENY = [/^\/api\/telephony\/token/, /^\/api\/recordings\/.+\/(download|audio)/];
export function supportRequestRefusal(method: string, url: URL): string | null {
  const path = url.pathname;
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return SUPPORT_MUTATION_ALLOW.some((r) => r.test(path)) ? null : "מצב תמיכה – קריאה בלבד: אין אפשרות לשנות, לשלוח, לחייג או לחייב";
  if (url.searchParams.get("reveal") === "1") return "מצב תמיכה – סודות אינם נחשפים";
  if (SUPPORT_GET_DENY.some((r) => r.test(path))) return "מצב תמיכה – הפעולה אינה זמינה";
  return null;
}
