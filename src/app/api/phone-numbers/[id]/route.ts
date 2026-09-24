import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const schema = z.object({ label: z.string().max(80).optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const n = await prisma.phoneNumber.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!n) throw new ApiError("מספר לא נמצא", 404, "not_found");
  const updated = await prisma.$transaction(async (tx) => {
    if (b.isDefault) await tx.phoneNumber.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    return tx.phoneNumber.update({ where: { id: n.id }, data: { ...(b.label !== undefined ? { label: b.label || null } : {}), ...(b.isDefault !== undefined ? { isDefault: b.isDefault } : {}), ...(b.isActive !== undefined ? { isActive: b.isActive } : {}) } });
  });
  return ok(updated);
}, { minRole: "admin" });

export const DELETE = withAuth(async ({ user, params }) => {
  const n = await prisma.phoneNumber.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!n) throw new ApiError("מספר לא נמצא", 404, "not_found");
  await prisma.phoneNumber.update({ where: { id: n.id }, data: { isActive: false, isDefault: false } });
  return ok({ deactivated: true });
}, { minRole: "admin" });
