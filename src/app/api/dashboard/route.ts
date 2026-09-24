import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { businessDayStart } from "@/lib/business-day";

export const dynamic = "force-dynamic";

/** Cross-module KPIs for the home screen (respects team visibility and enabled modules). */
export const GET = withAuth(async ({ user }) => {
  const businessId = user.businessId;
  const [ids, ent, biz] = await Promise.all([visibleUserIds(user), getEntitlements(businessId), prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } })]);
  const dayStart = businessDayStart(biz?.timezone ?? "Asia/Jerusalem");
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  const monthStart = new Date(dayStart); monthStart.setUTCDate(1);
  const userScope = ids ? { in: ids } : undefined;
  const [contacts, contactsWeek, leadsOpen, leadsWeek, dealsOpen, dealsWonMonth, tasksOverdue, tasksToday, suppressed] = await Promise.all([
    prisma.contact.count({ where: { businessId } }),
    prisma.contact.count({ where: { businessId, createdAt: { gte: weekAgo } } }),
    prisma.lead.count({ where: { businessId, status: { in: ["new", "contacted", "qualified"] }, ...(userScope ? { OR: [{ ownerUserId: userScope }, { ownerUserId: null }] } : {}) } }),
    prisma.lead.count({ where: { businessId, createdAt: { gte: weekAgo } } }),
    prisma.deal.aggregate({ where: { businessId, status: "open", ...(userScope ? { ownerUserId: userScope } : {}) }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.deal.aggregate({ where: { businessId, status: "won", closedAt: { gte: monthStart }, ...(userScope ? { ownerUserId: userScope } : {}) }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.task.count({ where: { businessId, status: "open", dueAt: { lt: new Date() }, ...(userScope ? { userId: userScope } : {}) } }),
    prisma.task.count({ where: { businessId, status: "open", dueAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86400_000) }, ...(userScope ? { userId: userScope } : {}) } }),
    prisma.suppression.count({ where: { businessId, revokedAt: null } }),
  ]);
  const messaging = ent.modules.messaging
    ? await (async () => {
        const [openConversations, unread, messagesToday, inboundToday, campaignsRunning] = await Promise.all([
          prisma.conversation.count({ where: { businessId, status: { in: ["OPEN", "PENDING"] }, ...(user.role === "agent" ? { OR: [{ assignedAgentId: user.id }, { assignedAgentId: null }] } : {}) } }),
          prisma.conversation.count({ where: { businessId, unreadCount: { gt: 0 }, ...(user.role === "agent" ? { OR: [{ assignedAgentId: user.id }, { assignedAgentId: null }] } : {}) } }),
          prisma.message.count({ where: { businessId, createdAt: { gte: dayStart } } }),
          prisma.message.count({ where: { businessId, direction: "INBOUND", createdAt: { gte: dayStart } } }),
          prisma.campaign.count({ where: { businessId, status: { in: ["RUNNING", "SCHEDULED"] } } }),
        ]);
        return { openConversations, unread, messagesToday, inboundToday, campaignsRunning };
      })()
    : null;
  const telephony = ent.modules.telephony
    ? await (async () => {
        const [callsToday, answeredToday, talk, liveCalls, agentsOnline, callbacksDue] = await Promise.all([
          prisma.call.count({ where: { businessId, createdAt: { gte: dayStart }, ...(userScope ? { userId: userScope } : {}) } }),
          prisma.call.count({ where: { businessId, createdAt: { gte: dayStart }, answeredAt: { not: null }, ...(userScope ? { userId: userScope } : {}) } }),
          prisma.call.aggregate({ where: { businessId, createdAt: { gte: dayStart }, ...(userScope ? { userId: userScope } : {}) }, _sum: { talkSeconds: true } }),
          prisma.call.count({ where: { businessId, endedAt: null, ...(userScope ? { userId: userScope } : {}) } }),
          prisma.user.count({ where: { businessId, isActive: true, presence: { not: "offline" }, lastSeenAt: { gte: new Date(Date.now() - 90_000) } } }),
          prisma.task.count({ where: { businessId, status: "open", type: "callback", dueAt: { lte: new Date() }, ...(userScope ? { userId: userScope } : {}) } }),
        ]);
        return { callsToday, answeredToday, talkSeconds: talk._sum.talkSeconds ?? 0, liveCalls, agentsOnline, callbacksDue };
      })()
    : null;
  const [recentLeads, myTasks, recentEvents] = await Promise.all([
    prisma.lead.findMany({ where: { businessId, ...(userScope ? { OR: [{ ownerUserId: userScope }, { ownerUserId: null }] } : {}) }, orderBy: { createdAt: "desc" }, take: 6, include: { contact: { select: { id: true, fullName: true, phoneE164: true } }, owner: { select: { fullName: true } } } }),
    prisma.task.findMany({ where: { businessId, status: "open", ...(userScope ? { userId: userScope } : {}) }, orderBy: { dueAt: "asc" }, take: 8, include: { contact: { select: { id: true, fullName: true, phoneE164: true } }, user: { select: { fullName: true } } } }),
    prisma.domainEvent.findMany({ where: { businessId }, orderBy: { occurredAt: "desc" }, take: 8, select: { id: true, type: true, occurredAt: true, status: true, source: true, contact: { select: { id: true, fullName: true } } } }),
  ]);
  return ok({
    modules: ent.modules,
    plan: ent.planName,
    crm: { contacts, contactsWeek, leadsOpen, leadsWeek, dealsOpen: { count: dealsOpen._count._all, amount: Number(dealsOpen._sum.amount ?? 0) }, dealsWonMonth: { count: dealsWonMonth._count._all, amount: Number(dealsWonMonth._sum.amount ?? 0) }, tasksOverdue, tasksToday, suppressed },
    messaging,
    telephony,
    recentLeads,
    myTasks,
    recentEvents,
    now: new Date().toISOString(),
  });
});
