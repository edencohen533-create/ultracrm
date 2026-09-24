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
  return ok({ ...list, stats: await listQueueStats(list.id) });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(20).nullable().optional(),
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
  const updated = await prisma.dialList.update({
    where: { id: list.id },
    data: {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.maxAttempts !== undefined ? { maxAttempts: b.maxAttempts } : {}),
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
}, { minRole: "manager" });

export const DELETE = withAuth(async ({ user, params }) => {
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const inCall = await prisma.listLead.count({ where: { listId: list.id, status: "in_call" } });
  if (inCall > 0) throw new ApiError("יש שיחות פעילות ברשימה – לא ניתן למחוק כעת", 409, "list_busy");
  await prisma.dialList.update({ where: { id: list.id }, data: { isActive: false } });
  return ok({ deactivated: true });
}, { minRole: "manager" });
