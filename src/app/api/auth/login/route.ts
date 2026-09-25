import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, membershipsForAccount, sessionFromMembership, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email(), password: z.string().min(1), businessId: z.string().optional() });

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
    const { email, password, businessId } = await parseBody(req, schema);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const normalized = email.toLowerCase().trim();
    const emailKey = `e:${normalized}`;
    if (hit(emailKey, 5) || hit(`ip:${ip}`, 30)) return fail("יותר מדי ניסיונות – נסה שוב בעוד כמה דקות", 429, undefined, "rate_limited");
    const account = await db.account.findUnique({ where: { email: normalized } });
    if (!account || !account.isActive || !(await bcrypt.compare(password, account.passwordHash))) {
      record(emailKey);
      record(`ip:${ip}`);
      return fail("אימייל או סיסמה שגויים", 401, undefined, "bad_credentials");
    }
    attempts.delete(emailKey);
    const memberships = await membershipsForAccount(account.id);
    if (memberships.length === 0) return fail("החשבון אינו משויך לאף עסק פעיל", 403, undefined, "no_business");
    const chosen = (businessId ? memberships.find((m) => m.businessId === businessId) : undefined) ?? memberships[0];
    const session = sessionFromMembership(chosen, account.id);
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
