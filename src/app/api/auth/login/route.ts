import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { cookieMaxAge, cookieName, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

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

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await parseBody(req, schema);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const emailKey = `e:${email.toLowerCase().trim()}`;
    if (hit(emailKey, 5) || hit(`ip:${ip}`, 30)) return fail("יותר מדי ניסיונות – נסה שוב בעוד כמה דקות", 429, undefined, "rate_limited");
    const user = await prisma.user.findFirst({ where: { email: email.toLowerCase().trim(), isActive: true } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      record(emailKey);
      record(`ip:${ip}`);
      return fail("אימייל או סיסמה שגויים", 401, undefined, "bad_credentials");
    }
    attempts.delete(emailKey);
    const session = { id: user.id, businessId: user.businessId, email: user.email, fullName: user.fullName, role: user.role, teamId: user.teamId };
    const token = await signSession(session);
    const res = NextResponse.json({ success: true, data: session });
    res.cookies.set(cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: cookieMaxAge,
      path: "/",
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
