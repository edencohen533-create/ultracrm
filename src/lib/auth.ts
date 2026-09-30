import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { UserRole } from "@/generated/prisma/enums";
import { assertSameOriginMutation } from "@/lib/request-origin";

const COOKIE_NAME = "ultracrm_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h shifts

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error("JWT_SECRET must be set (min 32 chars)");
  return new TextEncoder().encode(s);
}

/**
 * The authenticated principal. `id` is the business-user (membership) id – every
 * operational record references it. `accountId` is the global login identity.
 */
export interface SessionUser {
  id: string;
  accountId: string;
  businessId: string;
  email: string;
  fullName: string;
  role: UserRole;
  teamId: string | null;
  /** Account.sessionVersion at sign-in; a password change bumps it and invalidates older tokens. */
  sessionVersion?: number;
  /** Platform support access (read-only, time-boxed) – validated against SupportSession on every request. */
  supportSessionId?: string;
  support?: { id: string; expiresAt: string; businessName: string } | null;
}

export async function signSession(user: SessionUser) {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

async function verify(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub || !payload.businessId || !payload.accountId) return null;
    return {
      id: payload.sub,
      accountId: String(payload.accountId),
      businessId: String(payload.businessId),
      email: String(payload.email),
      fullName: String(payload.fullName),
      role: payload.role as UserRole,
      teamId: (payload.teamId as string | null) ?? null,
      sessionVersion: typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0,
      ...(typeof payload.supportSessionId === "string" ? { supportSessionId: payload.supportSessionId } : {}),
    };
  } catch {
    return null;
  }
}

export const cookieName = COOKIE_NAME;
export const cookieMaxAge = MAX_AGE_SECONDS;

export async function getSessionFromRequest(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verify(token);
}

export async function getSessionFromCookies(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verify(token);
}

/**
 * Resolve the session and re-check membership in the database on every request:
 * a deactivated user / business or a changed role takes effect immediately.
 */
export async function requireUser(req: NextRequest): Promise<SessionUser> {
  assertSameOriginMutation(req);
  const session = await getSessionFromRequest(req);
  if (!session) throw new ApiError("לא מחובר", 401, "unauthorized");
  const user = await revalidateSession(session);
  // Support access is read-only on the server: no change, send, dial, charge or secret – whatever the UI shows.
  if (user.support) {
    const { supportRequestRefusal } = await import("@/lib/platform/support");
    const refusal = supportRequestRefusal(req.method, new URL(req.url));
    if (refusal) throw new ApiError(refusal, 403, "support_read_only");
  }
  return user;
}

export async function revalidateSession(session: SessionUser): Promise<SessionUser> {
  if (session.supportSessionId) {
    // A support identity is never an active member: the SupportSession row is what grants (and ends) access.
    const { activeSupportSession } = await import("@/lib/platform/support");
    const s = await activeSupportSession(session.supportSessionId, session.accountId, session.id, session.businessId);
    const u = s ? await db.user.findUnique({ where: { id: session.id }, select: { isSupport: true, businessId: true, fullName: true, email: true, business: { select: { isActive: true } } } }) : null;
    if (!s || !u?.isSupport || u.businessId !== session.businessId) throw new ApiError("גישת התמיכה הסתיימה", 401, "unauthorized");
    return { ...session, role: "manager", teamId: null, fullName: u.fullName, email: u.email, support: { id: s.id, expiresAt: s.expiresAt.toISOString(), businessName: s.businessName } };
  }
  const user = await db.user.findUnique({
    where: { id: session.id },
    select: { id: true, isActive: true, role: true, teamId: true, businessId: true, accountId: true, fullName: true, email: true, business: { select: { isActive: true } }, account: { select: { sessionVersion: true, isActive: true } } },
  });
  if (!user || !user.isActive || !user.business.isActive || !user.account.isActive || user.businessId !== session.businessId || user.accountId !== session.accountId
    || user.account.sessionVersion !== (session.sessionVersion ?? 0)) {
    throw new ApiError("לא מחובר", 401, "unauthorized");
  }
  return { ...session, role: user.role, teamId: user.teamId, fullName: user.fullName, email: user.email };
}

/** Server-component variant: returns null instead of throwing. */
export async function getValidSession(): Promise<SessionUser | null> {
  const s = await getSessionFromCookies();
  if (!s) return null;
  try {
    return await revalidateSession(s);
  } catch {
    return null;
  }
}

const RANK: Record<UserRole, number> = { agent: 1, manager: 2, owner: 3 };

export function hasRole(user: { role: UserRole }, min: UserRole) {
  return RANK[user.role] >= RANK[min];
}

export function requireRole(user: SessionUser, min: UserRole) {
  if (!hasRole(user, min)) throw new ApiError("אין הרשאה לפעולה זו", 403, "forbidden");
}

export const ROLE_LABEL: Record<UserRole, string> = { owner: "בעלים", manager: "מנהל", agent: "נציג" };

/**
 * Which user ids may this user see?
 * - agent: only self
 * - manager: self + members of teams they manage (+ their own team)
 * - owner: everyone in the business (returns null = no filter)
 */
export type VisibleIds = string[] & { sharedPool?: boolean };
/** Raw permission settings (kept here – importing lib/settings would create an import cycle). */
async function permissionsOf(businessId: string) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { settings: true } });
  const p = ((b?.settings as { permissions?: Record<string, unknown> } | null)?.permissions ?? {}) as Record<string, unknown>;
  return { managerScope: p.managerScope === "team" ? "team" : "business", agentSeesUnassigned: p.agentSeesUnassigned === true };
}
const mark = (ids: string[], sharedPool: boolean): VisibleIds => Object.assign(ids, { sharedPool });

export async function visibleUserIds(user: SessionUser): Promise<VisibleIds | null> {
  if (user.role === "owner") return null;
  const perms = await permissionsOf(user.businessId);
  // Data scope assigned by the business manager (settings → משתמשים והרשאות) wins; otherwise the role decides, as before.
  const row = await db.user.findUnique({ where: { id: user.id }, select: { permissions: true } });
  const assigned = (row?.permissions as { scope?: string } | null)?.scope;
  const scope = assigned === "own" || assigned === "team" || assigned === "business" ? assigned
    : user.role === "agent" ? "own" : perms.managerScope === "business" ? "business" : "team";
  // Own data only; the unassigned pool only when the business allows it (settings → הרשאות).
  if (scope === "own") return mark([user.id], perms.agentSeesUnassigned);
  if (scope === "business") return null;
  const teams = await db.team.findMany({
    where: { businessId: user.businessId, OR: [{ managerId: user.id }, ...(user.teamId ? [{ id: user.teamId }] : [])] },
    select: { members: { select: { id: true } } },
  });
  const ids = new Set<string>([user.id]);
  for (const t of teams) for (const m of t.members) ids.add(m.id);
  return mark([...ids], true);
}

export async function assertCanSeeUser(user: SessionUser, targetUserId: string) {
  const ids = await visibleUserIds(user);
  if (ids && !ids.includes(targetUserId)) throw new ApiError("אין הרשאה לצפות בנתוני משתמש זה", 403, "forbidden");
}

/** All active memberships of an account (for the business switcher). */
export async function membershipsForAccount(accountId: string) {
  return db.user.findMany({
    where: { accountId, isActive: true, business: { isActive: true } },
    select: { id: true, businessId: true, role: true, teamId: true, fullName: true, email: true, business: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export function sessionFromMembership(m: { id: string; accountId?: string; businessId: string; role: UserRole; teamId: string | null; fullName: string; email: string }, accountId: string, sessionVersion = 0): SessionUser {
  return { id: m.id, accountId, businessId: m.businessId, email: m.email, fullName: m.fullName, role: m.role, teamId: m.teamId, sessionVersion };
}
