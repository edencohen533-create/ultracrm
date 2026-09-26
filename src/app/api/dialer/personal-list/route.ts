import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { addLeadsToList } from "@/lib/lists";
import { listQueueStats } from "@/lib/dialer/queue";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * "הלידים שלי" – a personal, dynamic dial list built from the agent's own open leads, so the auto dialer can
 * start with one click even when no manager-made list exists. Idempotent: one list per user, refreshed on
 * every call (new open leads are added; existing queue rows, attempts and callbacks are kept).
 * Uses the regular dial-list machinery (same locks, DNC, windows, stats) – no parallel queue.
 */
export const POST = withAuth(async ({ user }) => {
  const filter = { leadOwnerUserId: user.id } as const;
  const name = `הלידים של ${user.fullName}`;
  let list = await prisma.dialList.findFirst({ where: { businessId: user.businessId, isDynamic: true, filterJson: { path: ["leadOwnerUserId"], equals: user.id } }, select: { id: true, name: true, isActive: true, isPaused: true, archivedAt: true } });
  if (!list) {
    list = await prisma.dialList.create({
      data: { businessId: user.businessId, name, description: "תור אישי – נבנה אוטומטית מהלידים הפתוחים של הנציג", isDynamic: true, filterJson: filter as unknown as Prisma.InputJsonValue, agents: { create: [{ userId: user.id }] } },
      select: { id: true, name: true, isActive: true, isPaused: true, archivedAt: true },
    });
  } else if (!list.isActive || list.archivedAt) {
    await prisma.dialList.update({ where: { id: list.id }, data: { isActive: true, archivedAt: null } });
  }
  const added = await addLeadsToList(user.businessId, list.id, filter);
  await prisma.dialList.update({ where: { id: list.id }, data: { lastRefreshedAt: new Date() } });
  const stats = await listQueueStats(list.id);
  return ok({ id: list.id, name: list.name, isPaused: list.isPaused, added, stats });
}, { module: "telephony" });
