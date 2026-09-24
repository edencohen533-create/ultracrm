import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const visible = await visibleUserIds(user);
  const items = await prisma.user.findMany({
    where: { businessId: user.businessId, ...(visible ? { id: { in: visible } } : {}) },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, presence: true, teamId: true, team: { select: { id: true, name: true } }, createdAt: true },
    orderBy: { fullName: "asc" },
  });
  const teams = user.role === "agent" ? [] : await prisma.team.findMany({ where: { businessId: user.businessId }, select: { id: true, name: true, managerId: true } });
  return ok({ items, teams });
});

const schema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  role: z.enum(["admin", "manager", "agent"]).default("agent"),
  teamId: z.string().nullable().optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  await assertTenantReferences(user.businessId, { teamId: b.teamId });
  const email = b.email.toLowerCase().trim();
  const exists = await prisma.user.findUnique({ where: { businessId_email: { businessId: user.businessId, email } } });
  if (exists) throw new ApiError("אימייל זה כבר קיים", 409, "duplicate_email");
  const u = await prisma.user.create({
    data: { businessId: user.businessId, email, fullName: b.fullName.trim(), role: b.role, teamId: b.teamId ?? null, passwordHash: await bcrypt.hash(b.password, 12) },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true },
  });
  return ok(u, 201);
}, { minRole: "admin" });
