import { NextRequest, NextResponse } from "next/server";
import { cookieName, getSessionFromRequest, revalidateSession } from "@/lib/auth";
import { endSupportSession } from "@/lib/platform/support";
import { prisma } from "@/lib/db";
import { assertSameOriginMutation } from "@/lib/request-origin";
import { ApiError, handleError } from "@/lib/response";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { assertSameOriginMutation(req); } catch (err) { return handleError(err); }
  try {
    const session = await getSessionFromRequest(req);
    let user = null;
    if (session) {
      try { user = await revalidateSession(session); }
      catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
    }
    if (user?.supportSessionId) await endSupportSession(user.supportSessionId, user.accountId, "logout");
    // Clearing an expired/revoked cookie is allowed, but it must not change current dialer state.
    if (user && !user.support) {
      const live = await prisma.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
      if (!live) {
        await prisma.dialerSession.updateMany({ where: { businessId: user.businessId, userId: user.id, status: { in: ["active", "paused"] } }, data: { status: "ended", endedAt: new Date() } });
        await prisma.user.updateMany({ where: { id: user.id, businessId: user.businessId }, data: { presence: "offline", presenceAt: new Date() } });
      }
    }
  } catch (error) { return handleError(error); }
  const res = NextResponse.json({ success: true, data: null });
  res.cookies.set(cookieName, "", { httpOnly: true, maxAge: 0, path: "/" });
  return res;
}
