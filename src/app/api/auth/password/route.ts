import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { cookieMaxAge, cookieName, requireUser, signSession } from "@/lib/auth";
import { fail, handleError } from "@/lib/response";
import { parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(100),
});

/**
 * Self-service password change for the signed-in account (any role, any number of businesses).
 * Requires the current password, bumps Account.sessionVersion so every other session of the account is
 * invalidated, and re-issues the cookie for this session only.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { currentPassword, newPassword } = await parseBody(req, schema);
    if (currentPassword === newPassword) return fail("הסיסמה החדשה זהה לנוכחית", 400, undefined, "same_password");
    const account = await withoutBusiness(() => db.account.findUniqueOrThrow({ where: { id: user.accountId }, select: { id: true, passwordHash: true } }));
    if (!(await bcrypt.compare(currentPassword, account.passwordHash))) {
      await audit(user.businessId, user.id, "account", account.id, "account.password_change_rejected", { reason: "wrong_current_password" });
      return fail("הסיסמה הנוכחית שגויה", 403, undefined, "bad_current_password");
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await withoutBusiness(() => db.account.update({
      where: { id: account.id },
      data: { passwordHash, sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    }));
    await audit(user.businessId, user.id, "account", account.id, "account.password_changed", { sessionsInvalidated: true });
    const token = await signSession({ ...user, sessionVersion: updated.sessionVersion });
    const res = NextResponse.json({ success: true, data: { ok: true } });
    res.cookies.set(cookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: cookieMaxAge, path: "/" });
    return res;
  } catch (err) {
    return handleError(err);
  }
}
