import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const schema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  role: z.enum(["admin", "manager", "agent"]).optional(),
  teamId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).max(100).optional(),
});

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const target = await prisma.user.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!target) throw new ApiError("משתמש לא נמצא", 404, "not_found");
  if (target.id === user.id && (b.isActive === false || (b.role && b.role !== "admin"))) throw new ApiError("לא ניתן להסיר את ההרשאות של עצמך", 400, "self_demote");
  await assertTenantReferences(user.businessId, { teamId: b.teamId });
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(b.fullName ? { fullName: b.fullName.trim() } : {}),
      ...(b.role ? { role: b.role } : {}),
      ...(b.teamId !== undefined ? { teamId: b.teamId } : {}),
      ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      ...(b.password ? { passwordHash: await bcrypt.hash(b.password, 12) } : {}),
    },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true },
  });
  return ok(updated);
}, { minRole: "admin" });
