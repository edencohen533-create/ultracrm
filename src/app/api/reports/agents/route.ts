import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { agentMetrics } from "@/lib/stats";
import { getBusinessSettings } from "@/lib/settings";
import { businessDayStart } from "@/lib/business-day";

export const dynamic = "force-dynamic";
const schema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.string().optional(),
}).refine(f => !f.from || !f.to || new Date(f.from) <= new Date(f.to), { message: "טווח תאריכים לא תקין" });

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, schema);
  const ids = await visibleUserIds(user);
  const userIds = f.userId ? ids && !ids.includes(f.userId) ? [] : [f.userId] : ids;
  const settings = await getBusinessSettings(user.businessId);
  const from = f.from ? new Date(f.from) : businessDayStart(settings.timezone);
  const to = f.to ? new Date(f.to) : new Date();
  const [agents, metrics, deals] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true, isActive: true, presence: true, presenceAt: true, lastSeenAt: true }, orderBy: { fullName: "asc" } }),
    agentMetrics({ businessId: user.businessId, userIds, from, to }),
    prisma.deal.groupBy({ by: ["ownerUserId"], where: { businessId: user.businessId, status: "won", closedAt: { gte: from, lte: to }, ...(userIds ? { ownerUserId: { in: userIds } } : {}) }, _count: { _all: true } }),
  ]);
  const now = Date.now();
  const rows = agents.filter(a => !f.userId || a.id === f.userId).map(a => {
    const m = metrics.perUser[a.id];
    return { id: a.id, fullName: a.fullName, presence: a.isActive && a.lastSeenAt && now - a.lastSeenAt.getTime() < 120_000 ? a.presence : "offline", presenceAt: a.presenceAt,
      outbound: m?.outboundAttempts ?? 0, answered: m?.outboundAnswered ?? 0, handled: m?.outboundHandled ?? 0, manual: m?.outboundManual ?? 0,
      closed: deals.find(d => d.ownerUserId === a.id)?._count._all ?? 0,
      dialSeconds: m?.dialSeconds ?? 0, talkSeconds: m?.outboundTalkSeconds ?? 0 };
  });
  const totals = rows.reduce((t, r) => ({ outbound: t.outbound + r.outbound, answered: t.answered + r.answered, handled: t.handled + r.handled, closed: t.closed + r.closed, talkSeconds: t.talkSeconds + r.talkSeconds }), { outbound: 0, answered: 0, handled: 0, closed: 0, talkSeconds: 0 });
  return ok({ rows, totals, agents: agents.map(a => ({ id: a.id, fullName: a.fullName })), from: from.toISOString(), to: to.toISOString(), timezone: settings.timezone });
}, { minRole: "manager", module: "telephony" });
