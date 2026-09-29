import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { listQueueStats } from "@/lib/dialer/queue";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const list = await prisma.dialList.findFirst({
    where: { id: params.id, businessId: user.businessId },
    include: { agents: { include: { user: { select: { id: true, fullName: true } } } }, script: { select: { id: true, title: true } } },
  });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  // Agents: only campaigns open to them (all agents, or they were selected) – and never another agent's personal list.
  const owner = (list.filterJson as { leadOwnerUserId?: string } | null)?.leadOwnerUserId;
  if (user.role === "agent" && ((list.agents.length && !list.agents.some((a) => a.userId === user.id)) || (owner && owner !== user.id))) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  return ok({ ...list, stats: await listQueueStats(list.id) });
}, { perm: "telephony.use" });

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(20).nullable().optional(),
  unansweredLimit: z.number().int().min(0).max(50).nullable().optional(),
  retryIntervalMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  dialWindow: z.object({ start: z.string(), end: z.string(), days: z.array(z.number().int()), timezone: z.string().optional() }).nullable().optional(),
  scriptId: z.string().nullable().optional(),
  phoneNumberId: z.string().nullable().optional(),
  isDynamic: z.boolean().optional(),
  isPaused: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, patchSchema);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  await assertTenantReferences(user.businessId, { scriptId: b.scriptId, phoneNumberId: b.phoneNumberId });
  // Active / inactive goes through the list administration (releases reservations, stops future work, audited).
  if (b.isActive !== undefined && b.isActive !== list.isActive) {
    const { setListActive } = await import("@/lib/dialer/list-admin");
    await setListActive(user, list.id, b.isActive);
  }
  const updated = await prisma.dialList.update({
    where: { id: list.id },
    data: {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.maxAttempts !== undefined ? { maxAttempts: b.maxAttempts } : {}),
      ...(b.unansweredLimit !== undefined ? { unansweredLimit: b.unansweredLimit } : {}),
      ...(b.retryIntervalMinutes !== undefined ? { retryIntervalMinutes: b.retryIntervalMinutes } : {}),
      ...(b.dialWindow !== undefined ? { dialWindowJson: b.dialWindow === null ? undefined : (b.dialWindow as Prisma.InputJsonValue) } : {}),
      ...(b.scriptId !== undefined ? { scriptId: b.scriptId } : {}),
      ...(b.phoneNumberId !== undefined ? { phoneNumberId: b.phoneNumberId } : {}),
      ...(b.isDynamic !== undefined ? { isDynamic: b.isDynamic } : {}),
      ...(b.isPaused !== undefined ? { isPaused: b.isPaused } : {}),
      ...(b.archived !== undefined ? { archivedAt: b.archived ? new Date() : null, isActive: b.archived ? false : list.isActive } : {}),
    },
  });
  return ok(updated);
}, { minRole: "manager", perm: "telephony.team_settings" });

/** "מחק רשימה": the list and its queue rows are removed; contacts, leads and their history stay. Needs the list's name. */
export const DELETE = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ confirmName: z.string().max(200) }));
  const { deleteList } = await import("@/lib/dialer/list-admin");
  return ok(await deleteList(user, params.id, b.confirmName));
}, { minRole: "manager", perm: "telephony.team_settings" });
