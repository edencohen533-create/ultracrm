import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { UserRole } from "@/generated/prisma/enums";

const COOKIE_NAME = "dialer_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h shifts

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error("JWT_SECRET must be set (min 32 chars)");
  return new TextEncoder().encode(s);
}

export interface SessionUser {
  id: string;
  businessId: string;
  email: string;
  fullName: string;
  role: UserRole;
  teamId: string | null;
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
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || !payload.businessId) return null;
    return {
      id: payload.sub,
      businessId: String(payload.businessId),
      email: String(payload.email),
      fullName: String(payload.fullName),
      role: payload.role as UserRole,
      teamId: (payload.teamId as string | null) ?? null,
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

/** Resolve the session and make sure the user still exists and is active. */
export async function requireUser(req: NextRequest): Promise<SessionUser> {
  const session = await getSessionFromRequest(req);
  if (!session) throw new ApiError("לא מחובר", 401, "unauthorized");
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, isActive: true, role: true, teamId: true, businessId: true },
  });
  if (!user || !user.isActive || user.businessId !== session.businessId) {
    throw new ApiError("לא מחובר", 401, "unauthorized");
  }
  return { ...session, role: user.role, teamId: user.teamId };
}

const RANK: Record<UserRole, number> = { agent: 1, manager: 2, admin: 3 };

export function requireRole(user: SessionUser, min: UserRole) {
  if (RANK[user.role] < RANK[min]) throw new ApiError("אין הרשאה לפעולה זו", 403, "forbidden");
}

/**
 * Which user ids may this user see?
 * - agent: only self
 * - manager: self + members of teams they manage (+ their own team)
 * - admin: everyone in the business (returns null = no filter)
 */
export async function visibleUserIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === "admin") return null;
  if (user.role === "agent") return [user.id];
  const teams = await prisma.team.findMany({
    where: { businessId: user.businessId, OR: [{ managerId: user.id }, ...(user.teamId ? [{ id: user.teamId }] : [])] },
    select: { members: { select: { id: true } } },
  });
  const ids = new Set<string>([user.id]);
  for (const t of teams) for (const m of t.members) ids.add(m.id);
  return [...ids];
}

export async function assertCanSeeUser(user: SessionUser, targetUserId: string) {
  const ids = await visibleUserIds(user);
  if (ids && !ids.includes(targetUserId)) throw new ApiError("אין הרשאה לצפות בנתוני משתמש זה", 403, "forbidden");
}
