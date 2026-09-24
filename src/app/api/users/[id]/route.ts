import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db, prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  role: z.enum(["owner", "manager", "agent"]).optional(),
  teamId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(100).optional(),
});

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const target = await prisma.user.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!target) throw new ApiError("משתמש לא נמצא", 404, "not_found");
  if (target.id === user.id && (b.isActive === false || (b.role && b.role !== "owner"))) throw new ApiError("לא ניתן להסיר את ההרשאות של עצמך", 400, "self_demote");
  await assertTenantReferences(user.businessId, { teamId: b.teamId });
  if (b.password) {
    // A password belongs to the global account. An owner may only reset it when the
    // account is not also a member of another business (otherwise the person resets it themselves).
    const otherMemberships = await db.user.count({ where: { accountId: target.accountId, NOT: { businessId: user.businessId } } });
    if (otherMemberships > 0) throw new ApiError("החשבון משויך לעסקים נוספים – איפוס סיסמה אפשרי רק על ידי המשתמש עצמו", 409, "shared_account");
    await db.account.update({ where: { id: target.accountId }, data: { passwordHash: await bcrypt.hash(b.password, 12) } });
  }
  if (b.isActive === false && target.role === "owner") {
    const owners = await prisma.user.count({ where: { businessId: user.businessId, role: "owner", isActive: true } });
    if (owners <= 1) throw new ApiError("חייב להישאר לפחות בעלים פעיל אחד", 400, "last_owner");
  }
  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(b.fullName ? { fullName: b.fullName.trim() } : {}),
      ...(b.role ? { role: b.role } : {}),
      ...(b.teamId !== undefined ? { teamId: b.teamId } : {}),
      ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
    },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true },
  });
  if (b.isActive === false) {
    // Revoke live work: end sessions and unassign open conversations.
    await prisma.dialerSession.updateMany({ where: { userId: target.id, status: { in: ["active", "paused"] } }, data: { status: "ended", endedAt: new Date() } });
    await prisma.conversation.updateMany({ where: { assignedAgentId: target.id, status: { in: ["OPEN", "PENDING"] } }, data: { assignedAgentId: null } });
  }
  await audit(user.businessId, user.id, "user", target.id, "user.updated", { fields: Object.keys(b).filter((k) => k !== "password"), passwordReset: Boolean(b.password) });
  return ok(updated);
}, { minRole: "owner" });
