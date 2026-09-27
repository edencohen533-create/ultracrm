import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Manager in-app view of "agents without available leads" (open alerts first; only agents in the manager's scope). */
export const GET = withAuth(async ({ user }) => {
  const ids = await visibleUserIds(user);
  const rows = await prisma.dialerQueueAlert.findMany({ where: { businessId: user.businessId, ...(ids ? { userId: { in: ids } } : {}), openedAt: { gte: new Date(Date.now() - 3 * 86400_000) } }, orderBy: [{ closedAt: { sort: "asc", nulls: "first" } }, { openedAt: "desc" }], take: 50 });
  const [users, lists] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } }),
    prisma.dialList.findMany({ where: { businessId: user.businessId, id: { in: rows.map((r) => r.listId) } }, select: { id: true, name: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x.fullName])); const l = new Map(lists.map((x) => [x.id, x.name]));
  return ok({ items: rows.map((r) => ({ id: r.id, agentId: r.userId, agent: u.get(r.userId) ?? "", listId: r.listId, list: l.get(r.listId) ?? "", state: r.state, exhaustedCount: r.exhaustedCount, nextAt: r.nextAt, openedAt: r.openedAt, closedAt: r.closedAt, notified: Boolean(r.notifiedAt) })) });
}, { minRole: "manager", perm: "telephony.team_settings" });
