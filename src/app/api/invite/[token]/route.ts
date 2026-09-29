import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, sessionFromMembership, signSession } from "@/lib/auth";
import { fail, handleError, ok } from "@/lib/response";
import { parseBody } from "@/lib/api";
import { assertSameOriginMutation } from "@/lib/request-origin";
import { acceptInvite, inviteInfo } from "@/server/services/invite-service";

export const dynamic = "force-dynamic";

/** Public (the one-time token is the credential): what to show on the invite page. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try { return ok(await inviteInfo((await params).token)); } catch (err) { return handleError(err); }
}

/** Best-effort guard against guessing an existing account's password through an invite link. */
const attempts = new Map<string, number[]>();

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    assertSameOriginMutation(req);
    const { token } = await params;
    const now = Date.now();
    const recent = (attempts.get(token) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 5) return fail("יותר מדי ניסיונות – נסה שוב בעוד כמה דקות", 429, undefined, "rate_limited");
    const { password } = await parseBody(req, z.object({ password: z.string().min(1).max(100) }));
    let r: Awaited<ReturnType<typeof acceptInvite>>;
    try { r = await acceptInvite(token, password); } catch (e) { attempts.set(token, [...recent, now]); throw e; }
    attempts.delete(token);
    const m = await db.user.findUniqueOrThrow({ where: { id: r.userId }, select: { id: true, businessId: true, role: true, teamId: true, fullName: true, email: true } });
    const res = NextResponse.json({ success: true, data: { businessId: r.businessId } });
    res.cookies.set(cookieName, await signSession(sessionFromMembership(m, r.accountId, r.sessionVersion)), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
