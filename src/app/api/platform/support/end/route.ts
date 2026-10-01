import { NextRequest, NextResponse } from "next/server";
import { cookieMaxAge, cookieName, requireUser, membershipsForAccount, sessionFromMembership, signSession } from "@/lib/auth";
import { endSupportSession } from "@/lib/platform/support";
import { ApiError, handleError } from "@/lib/response";

export const dynamic = "force-dynamic";
/** End support access and return to the admin's own business session (or sign out when they have none). */
export async function POST(req: NextRequest) {
  try {
    const s = await requireUser(req);
    const res = NextResponse.json({ success: true });
    if (!s?.supportSessionId) return res;
    if (!await endSupportSession(s.supportSessionId, s.accountId)) throw new ApiError("גישת התמיכה הסתיימה", 401, "unauthorized");
    const [m] = await membershipsForAccount(s.accountId);
    // Preserve the authenticated version: a concurrent password change must not upgrade an old cookie.
    if (m) res.cookies.set(cookieName, await signSession(sessionFromMembership(m, s.accountId, s.sessionVersion ?? 0)), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    else res.cookies.delete(cookieName);
    return res;
  } catch (e) { return handleError(e); }
}
