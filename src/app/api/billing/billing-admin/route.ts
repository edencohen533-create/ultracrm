import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
/** The owner names (or removes) billing admins – separate from any module permission. */
export const POST = withAuth(async ({ req, user }) => {
  if (user.role !== "owner") throw new ApiError("רק בעל העסק ממנה מנהלי חיוב", 403, "forbidden");
  const b = await parseBody(req, z.object({ userId: z.string().max(64), on: z.boolean() }));
  const u = await prisma.user.findFirst({ where: { id: b.userId, businessId: user.businessId, isActive: true, isSupport: false, role: { not: "owner" } }, select: { id: true, permissions: true } });
  if (!u) throw new ApiError("המשתמש לא נמצא", 404, "not_found");
  await prisma.user.update({ where: { id: u.id }, data: { permissions: { ...((u.permissions ?? {}) as object), billingAdmin: b.on } as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "user", u.id, b.on ? "billing.admin_granted" : "billing.admin_revoked", {});
  return ok({ userId: u.id, billingAdmin: b.on });
}, { minRole: "owner" });
