import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { cookieMaxAge, cookieName, membershipsForAccount, requireUser, sessionFromMembership, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Switch the active business of the current account (membership is re-checked server-side). */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { businessId } = await parseBody(req, z.object({ businessId: z.string().min(1) }));
    const live = await db.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
    if (live) return fail("יש שיחה פעילה – סיים אותה לפני מעבר בין עסקים", 409, undefined, "call_active");
    const memberships = await membershipsForAccount(user.accountId);
    const target = memberships.find((m) => m.businessId === businessId);
    if (!target) return fail("אין לך גישה לעסק זה", 403, undefined, "forbidden");
    const session = sessionFromMembership(target, user.accountId);
    const token = await signSession(session);
    const res = NextResponse.json({ success: true, data: session });
    res.cookies.set(cookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
