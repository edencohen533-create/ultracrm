import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { businessDayStart } from "@/lib/business-day";

export const dynamic = "force-dynamic";

/**
 * "What is waiting for me" – the strip at the top of the lead workspace.
 * Agents see their own work; managers see the work of the users visible to them (team scope).
 * Every number maps to a filtered list the agent can open with one click.
 */
export const GET = withAuth(async ({ user }) => {
  const businessId = user.businessId;
  const [ids, ent, biz] = await Promise.all([visibleUserIds(user), getEntitlements(businessId), prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } })]);
  const dayStart = businessDayStart(biz?.timezone ?? "Asia/Jerusalem");
  const dayEnd = new Date(dayStart.getTime() + 86400_000);
  const mine = user.role === "agent";
  const userScope = mine ? { equals: user.id } : ids ? { in: ids } : undefined;
  const [leadsNew, leadsOpen, callbacksDue, tasksDue, tasksOverdue] = await Promise.all([
    prisma.lead.count({ where: { businessId, status: "new", ...(userScope ? { OR: [{ ownerUserId: userScope }, { ownerUserId: null }] } : {}) } }),
    prisma.lead.count({ where: { businessId, status: { in: ["new", "contacted", "qualified"] }, ...(userScope ? { ownerUserId: userScope } : {}) } }),
    prisma.task.count({ where: { businessId, status: "open", type: "callback", dueAt: { lt: dayEnd }, ...(userScope ? { userId: userScope } : {}) } }),
    prisma.task.count({ where: { businessId, status: "open", type: { not: "callback" }, dueAt: { lt: dayEnd }, ...(userScope ? { userId: userScope } : {}) } }),
    prisma.task.count({ where: { businessId, status: "open", dueAt: { lt: dayStart }, ...(userScope ? { userId: userScope } : {}) } }),
  ]);
  const conversationsWaiting = ent.modules.messaging
    ? await prisma.conversation.count({ where: { businessId, status: { in: ["OPEN", "PENDING"] }, unreadCount: { gt: 0 }, isSpam: false, ...(mine ? { OR: [{ assignedAgentId: user.id }, { assignedAgentId: null }] } : ids ? { OR: [{ assignedAgentId: { in: ids } }, { assignedAgentId: null }] } : {}) } })
    : null;
  const missedCalls = ent.modules.telephony
    ? await prisma.call.count({ where: { businessId, direction: "inbound", answeredAt: null, createdAt: { gte: dayStart }, ...(mine ? { userId: user.id } : ids ? { userId: { in: ids } } : {}) } })
    : null;
  return ok({ leadsNew, leadsOpen, conversationsWaiting, missedCalls, callbacksDue, tasksDue, tasksOverdue, modules: ent.modules, scope: mine ? "mine" : "team" });
}, { module: "crm" });
