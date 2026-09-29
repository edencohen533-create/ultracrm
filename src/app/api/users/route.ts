import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { inviteUser } from "@/server/services/invite-service";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const visible = await visibleUserIds(user);
  const items = await prisma.user.findMany({
    where: { businessId: user.businessId, ...(visible ? { id: { in: visible } } : {}) },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, invitedAt: true, inviteExpiresAt: true, coachEnabled: true, presence: true, teamId: true, personalPhone: true, team: { select: { id: true, name: true } }, createdAt: true, lastSeenAt: true },
    orderBy: { fullName: "asc" },
  });
  const teams = user.role === "agent" ? [] : await prisma.team.findMany({ where: { businessId: user.businessId }, select: { id: true, name: true, managerId: true } });
  return ok({ items, teams });
});

const schema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email(),
  role: z.enum(["owner", "manager", "agent"]).default("agent"),
  teamId: z.string().nullable().optional(),
});

/**
 * Invite a person to this business. The owner never sets (or learns) the person's password: the membership stays
 * inactive until the person opens the one-time link (returned once, to be handed over) and sets / confirms their
 * own password. Same response whether or not the email already has an account elsewhere.
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  return ok(await inviteUser(user.businessId, user.id, b), 201);
}, { minRole: "owner" });
