import { NextRequest, NextResponse } from "next/server";
import { cookieMaxAge, cookieName, getSessionFromRequest, membershipsForAccount, sessionFromMembership, signSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { endSupportSession } from "@/lib/platform/support";
import { handleError } from "@/lib/response";

export const dynamic = "force-dynamic";
/** End support access and return to the admin's own business session (or sign out when they have none). */
export async function POST(req: NextRequest) {
  try {
    const s = await getSessionFromRequest(req);
    const res = NextResponse.json({ success: true });
    if (!s?.supportSessionId) return res;
    await endSupportSession(s.supportSessionId, s.accountId);
    const [m] = await membershipsForAccount(s.accountId);
    const acc = await withoutBusiness(() => db.account.findUnique({ where: { id: s.accountId }, select: { sessionVersion: true } }));
    if (m && acc) res.cookies.set(cookieName, await signSession(sessionFromMembership(m, s.accountId, acc.sessionVersion)), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    else res.cookies.delete(cookieName);
    return res;
  } catch (e) { return handleError(e); }
}
