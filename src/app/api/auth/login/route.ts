import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, membershipsForAccount, sessionFromMembership, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";
import { reserveAuthAttempt } from "@/lib/auth-rate-limit";
import { assertSameOriginMutation } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024), businessId: z.string().max(128).optional() });

/**
 * One login for every business: authenticate the Account, then open a session
 * on one of its active memberships (the requested business, or the only / first one).
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOriginMutation(req);
    const body = await parseBody(req, schema);
    // The repository's public seed password must never authenticate a production account.
    if (process.env.NODE_ENV === "production" && body.password === "Demo1234!") {
      return fail("אימייל או סיסמה שגויים", 401, undefined, "bad_credentials");
    }
    const { businessId } = body;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const normalized = body.email.toLowerCase().trim();
    if (ip !== "local") await reserveAuthAttempt("login-ip", ip, 60);
    await reserveAuthAttempt("login-email", normalized, 10);
    const account = await db.account.findUnique({ where: { email: normalized } });
    if (!account || !account.isActive || !(await bcrypt.compare(body.password, account.passwordHash))) {
      return fail("אימייל או סיסמה שגויים", 401, undefined, "bad_credentials");
    }
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
