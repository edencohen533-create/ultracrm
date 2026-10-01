import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, sessionFromMembership, signSession } from "@/lib/auth";
import { handleError, ok } from "@/lib/response";
import { parseBody } from "@/lib/api";
import { assertSameOriginMutation } from "@/lib/request-origin";
import { reserveAuthAttempt } from "@/lib/auth-rate-limit";
import { acceptInvite, inviteInfo } from "@/server/services/invite-service";

export const dynamic = "force-dynamic";

/** Public (the one-time token is the credential): what to show on the invite page. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try { return ok(await inviteInfo((await params).token)); } catch (err) { return handleError(err); }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    assertSameOriginMutation(req);
    const { token } = await params;
    const { password } = await parseBody(req, z.object({ password: z.string().min(1).max(100) }));
    // A random, invalid token must not create unlimited limiter rows.
    const info = await inviteInfo(token);
    await reserveAuthAttempt("invite-account", info.email.toLowerCase(), 5);
    const r = await acceptInvite(token, password);
    const m = await db.user.findUniqueOrThrow({ where: { id: r.userId }, select: { id: true, businessId: true, role: true, teamId: true, fullName: true, email: true } });
    const res = NextResponse.json({ success: true, data: { businessId: r.businessId } });
    res.cookies.set(cookieName, await signSession(sessionFromMembership(m, r.accountId, r.sessionVersion)), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
