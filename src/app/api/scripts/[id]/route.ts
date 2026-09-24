import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const schema = z.object({ title: z.string().min(1).max(120).optional(), body: z.string().max(20000).optional(), isDefault: z.boolean().optional() });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const s = await prisma.script.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!s) throw new ApiError("תסריט לא נמצא", 404, "not_found");
  const updated = await prisma.$transaction(async (tx) => {
    if (b.isDefault) await tx.script.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    return tx.script.update({ where: { id: s.id }, data: { ...(b.title ? { title: b.title.trim() } : {}), ...(b.body !== undefined ? { body: b.body } : {}), ...(b.isDefault !== undefined ? { isDefault: b.isDefault } : {}) } });
  });
  return ok(updated);
}, { minRole: "manager" });

export const DELETE = withAuth(async ({ user, params }) => {
  const s = await prisma.script.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!s) throw new ApiError("תסריט לא נמצא", 404, "not_found");
  await prisma.dialList.updateMany({ where: { scriptId: s.id }, data: { scriptId: null } });
  await prisma.script.delete({ where: { id: s.id } });
  return ok({ deleted: true });
}, { minRole: "manager" });
