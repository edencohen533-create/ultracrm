import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, membershipsForAccount, sessionFromMembership, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email().optional(), password: z.string().min(1).optional(), businessId: z.string().optional(), quick: z.boolean().optional() });
/**
 * TEMPORARY quick login without credentials (user request, 2026-09-25): when QUICK_LOGIN_EMAIL is set, `{ quick: true }`
 * signs in that account with no password. Remove by deleting QUICK_LOGIN_EMAIL + NEXT_PUBLIC_QUICK_LOGIN from the environment.
 */
const QUICK_LOGIN_EMAIL = process.env.QUICK_LOGIN_EMAIL?.toLowerCase().trim() || null;

/** Best-effort brute-force protection (per server instance): 5 failures per email or 30 per IP within 15 minutes. */
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, number[]>();
function hit(key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, arr);
  return arr.length >= limit;
}
function record(key: string) {
  attempts.set(key, [...(attempts.get(key) ?? []), Date.now()]);
}

/**
 * One login for every business: authenticate the Account, then open a session
 * on one of its active memberships (the requested business, or the only / first one).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, schema);
    const quick = body.quick === true && QUICK_LOGIN_EMAIL !== null;
    if (!quick && (!body.email || !body.password)) return fail("יש להזין אימייל וסיסמה", 400, undefined, "missing_credentials");
    const { businessId } = body;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const normalized = quick ? QUICK_LOGIN_EMAIL! : body.email!.toLowerCase().trim();
    const emailKey = `e:${normalized}`;
    if (hit(emailKey, 5) || hit(`ip:${ip}`, 30)) return fail("יותר מדי ניסיונות – נסה שוב בעוד כמה דקות", 429, undefined, "rate_limited");
    const account = await db.account.findUnique({ where: { email: normalized } });
    if (!account || !account.isActive || (!quick && !(await bcrypt.compare(body.password!, account.passwordHash)))) {
      record(emailKey);
      record(`ip:${ip}`);
      return fail("אימייל או סיסמה שגויים", 401, undefined, "bad_credentials");
    }
    attempts.delete(emailKey);
    const memberships = await membershipsForAccount(account.id);
    if (memberships.length === 0) return fail("החשבון אינו משויך לאף עסק פעיל", 403, undefined, "no_business");
    const chosen = (businessId ? memberships.find((m) => m.businessId === businessId) : undefined) ?? memberships[0];
    const session = sessionFromMembership(chosen, account.id, account.sessionVersion);
    const token = await signSession(session);
    const res = NextResponse.json({ success: true, data: { ...session, businesses: memberships.map((m) => ({ id: m.business.id, name: m.business.name, role: m.role })) } });
    res.cookies.set(cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: cookieMaxAge,
      path: "/",
    });
    await db.account.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
    await db.user.update({ where: { id: chosen.id }, data: { lastSeenAt: new Date() } });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
