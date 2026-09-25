import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db, prisma } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { visibleUserIds } from "@/lib/auth";
import { consumeQuota } from "@/lib/modules";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const visible = await visibleUserIds(user);
  const items = await prisma.user.findMany({
    where: { businessId: user.businessId, ...(visible ? { id: { in: visible } } : {}) },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, coachEnabled: true, presence: true, teamId: true, team: { select: { id: true, name: true } }, createdAt: true, lastSeenAt: true },
    orderBy: { fullName: "asc" },
  });
  const teams = user.role === "agent" ? [] : await prisma.team.findMany({ where: { businessId: user.businessId }, select: { id: true, name: true, managerId: true } });
  return ok({ items, teams });
});

const schema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  /** Required when the email has no account yet; ignored for an existing account (its password is not changed). */
  password: z.string().min(8).max(100).optional(),
  role: z.enum(["owner", "manager", "agent"]).default("agent"),
  teamId: z.string().nullable().optional(),
});

/**
 * Add a user to this business. Creates the global Account when the email is
 * new, otherwise attaches a membership to the existing account (one login for
 * every business the person works in).
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  await assertTenantReferences(user.businessId, { teamId: b.teamId });
  const email = b.email.toLowerCase().trim();
  const exists = await prisma.user.findUnique({ where: { businessId_email: { businessId: user.businessId, email } } });
  if (exists) throw new ApiError("אימייל זה כבר קיים בעסק", 409, "duplicate_email");
  await consumeQuota(user.businessId, "users");
  // Accounts are identity-level (may belong to other businesses) → outside the tenant scope.
  let account = await withoutBusiness(() => db.account.findUnique({ where: { email } }));
  let createdAccount = false;
  if (!account) {
    if (!b.password) throw new ApiError("נדרשת סיסמה למשתמש חדש", 400, "password_required");
    const passwordHash = await bcrypt.hash(b.password, 12);
    account = await withoutBusiness(() => db.account.create({ data: { email, fullName: b.fullName.trim(), passwordHash } }));
    createdAccount = true;
  }
  const u = await prisma.user.create({
    data: { businessId: user.businessId, accountId: account.id, email, fullName: b.fullName.trim(), role: b.role, teamId: b.teamId ?? null },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true },
  });
  await audit(user.businessId, user.id, "user", u.id, "user.created", { email, role: b.role, createdAccount });
  return ok({ ...u, createdAccount }, 201);
}, { minRole: "owner" });
