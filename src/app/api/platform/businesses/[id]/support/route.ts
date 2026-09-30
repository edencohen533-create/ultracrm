import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { cookieName, signSession } from "@/lib/auth";
import { startSupportSession, SUPPORT_MAX_MINUTES } from "@/lib/platform/support";

export const dynamic = "force-dynamic";
/** Start read-only support access (reason required, ≤60 min). The browser session becomes the support session. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ reason: z.string().trim().min(5).max(500), minutes: z.number().int().min(5).max(SUPPORT_MAX_MINUTES).default(30) }));
  const r = await startSupportSession(user, params.id, b);
  const res = NextResponse.json({ success: true, data: { businessName: r.businessName, expiresAt: r.session.expiresAt } });
  res.cookies.set(cookieName, await signSession(r.sessionUser), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: SUPPORT_MAX_MINUTES * 60, path: "/" });
  return res;
});
