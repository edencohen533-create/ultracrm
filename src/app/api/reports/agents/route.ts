import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { agentMetrics } from "@/lib/stats";
import { getBusinessSettings } from "@/lib/settings";
import { businessDayStart } from "@/lib/business-day";
import { leadQualityByAgent } from "@/lib/lead-quality";
import { reportChannels, whatsappByAgent } from "@/server/reports/comparison";
import { resolvePeriods } from "@/lib/reports/compare";

export const dynamic = "force-dynamic";
const schema = z.object({
  // A business-timezone day (YYYY-MM-DD, like the rest of the reports page) or an exact instant.
  from: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().datetime({ offset: true })]).optional(),
  to: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().datetime({ offset: true })]).optional(),
  userId: z.string().optional(),
  listId: z.string().max(64).optional(),
  product: z.string().max(160).optional(),
}).refine(f => !f.from || !f.to || f.from.length !== f.to.length || f.from <= f.to || new Date(f.from) <= new Date(f.to), { message: "טווח תאריכים לא תקין" });

const UNASSIGNED = "__unassigned";

/**
 * One row per agent for "ביצועי נציגים" – outcome columns (new leads, deals, close rate, revenue) + telephony and
 * WhatsApp activity, all with the page's filters (period, agent, campaign, product) and the user's visibility.
 * What has no agent row (deals without an owner, support / removed users' calls) is one explicit row, so totals
 * equal the page's summary. Each channel only when the business has it and the user may see it (else null).
 */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, schema);
  const ids = await visibleUserIds(user);
  if (f.userId && ids && !ids.includes(f.userId)) throw new ApiError("הנציג אינו בתחום שלך", 403, "forbidden");
  if (f.listId && !(await prisma.dialList.findFirst({ where: { id: f.listId, businessId: user.businessId }, select: { id: true } }))) throw new ApiError("הקמפיין לא נמצא", 404, "not_found");
  const channels = await reportChannels(user);
  const userIds = f.userId ? [f.userId] : ids;
  const settings = await getBusinessSettings(user.businessId);
  const isDay = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  let from: Date, to: Date;
  if (isDay(f.from) && isDay(f.to)) {
    // Same period resolution as the page's metrics (business timezone; an unfinished day ends now).
    let p; try { p = resolvePeriods({ tz: settings.timezone, from: f.from!, to: f.to!, compare: "none" }).current; } catch (e) { throw new ApiError((e as Error).message, 400, "bad_range"); }
    from = p.start; to = new Date(p.end.getTime() - 1);
  } else {
    from = f.from && !isDay(f.from) ? new Date(f.from) : businessDayStart(settings.timezone);
    to = f.to && !isDay(f.to) ? new Date(f.to) : new Date();
  }
  const cf = { listId: f.listId ?? null, product: f.product?.trim() || null };
  const [agents, metrics, quality, wa] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, isSupport: false, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true, isActive: true, presence: true, presenceAt: true, lastSeenAt: true }, orderBy: { fullName: "asc" } }),
    channels.telephony ? agentMetrics({ businessId: user.businessId, userIds, from, to, listId: cf.listId ?? undefined, product: cf.product ?? undefined }) : Promise.resolve(null),
    leadQualityByAgent(user.businessId, userIds, from, to, cf),
    channels.whatsapp ? whatsappByAgent(user.businessId, userIds, from, to, cf) : Promise.resolve(null),
  ]);
  const now = Date.now();
  const emptyQ = { responseMinutes: null, notCalled: 0, newLeads: 0, newWon: 0, transferred: 0, transferredWon: 0, allLeads: 0, allWon: 0, avgDealValue: null as number | null, wonDeals: 0, revenue: 0, ilsDeals: 0 };
  const row = (id: string, fullName: string, presence: string, presenceAt: Date | null) => {
    const m = metrics?.perUser[id]; const q = { ...emptyQ, ...quality[id] }; const w = wa?.[id];
    return { id, fullName, presence, presenceAt,
      // telephony (null = not available, not 0)
      outbound: metrics ? m?.outboundAttempts ?? 0 : null, answered: metrics ? m?.outboundAnswered ?? 0 : null, handled: metrics ? m?.outboundHandled ?? 0 : null, manual: metrics ? m?.outboundManual ?? 0 : null,
      dialSeconds: metrics ? m?.dialSeconds ?? 0 : null, talkSeconds: metrics ? m?.outboundTalkSeconds ?? 0 : null,
      avgTalkSeconds: metrics && m?.outboundAnswered ? Math.round((m.outboundTalkSeconds ?? 0) / m.outboundAnswered) : null,
      // outcomes
      closed: q.wonDeals, revenue: q.revenue ?? 0, newLeads: q.allLeads, newWon: q.allWon,
      // whatsapp
      wa: wa ? { outbound: w?.outbound ?? 0, conversations: w?.conversations ?? 0, handled: w?.handled ?? 0, firstResponse: w?.firstResponse ?? null, openNow: w?.openNow ?? 0 } : null,
      quality: q };
  };
  const rows = agents.filter(a => !f.userId || a.id === f.userId).map(a => row(a.id, a.fullName, a.isActive && a.lastSeenAt && now - a.lastSeenAt.getTime() < 120_000 ? a.presence : "offline", a.presenceAt));
  // Full-business view: activity / deals with no agent row (no owner, support or removed users) in one explicit row.
  if (!f.userId && !ids) {
    const listed = new Set(agents.map((a) => a.id));
    const orphanIds = new Set<string>([...Object.keys(metrics?.perUser ?? {}), ...Object.keys(quality), ...Object.keys(wa ?? {})].filter((id) => !listed.has(id)));
    if (orphanIds.size) {
      const u = row(UNASSIGNED, "ללא נציג משויך", "offline", null);
      const others = [...orphanIds].map((id) => row(id, "", "offline", null));
      const sum = (pick: (r: ReturnType<typeof row>) => number | null | undefined) => others.reduce((t, r) => t + (pick(r) ?? 0), 0);
      const q = { ...emptyQ, notCalled: sum((r) => r.quality.notCalled), newLeads: sum((r) => r.quality.newLeads), newWon: sum((r) => r.quality.newWon), transferred: sum((r) => r.quality.transferred), transferredWon: sum((r) => r.quality.transferredWon),
        allLeads: sum((r) => r.quality.allLeads), allWon: sum((r) => r.quality.allWon), wonDeals: sum((r) => r.quality.wonDeals), revenue: Math.round(sum((r) => r.quality.revenue) * 100) / 100, ilsDeals: sum((r) => r.quality.ilsDeals) };
      q.avgDealValue = q.ilsDeals ? Math.round(q.revenue / q.ilsDeals) : null;
      Object.assign(u, { outbound: metrics ? sum((r) => r.outbound) : null, answered: metrics ? sum((r) => r.answered) : null, handled: metrics ? sum((r) => r.handled) : null, manual: metrics ? sum((r) => r.manual) : null, dialSeconds: metrics ? sum((r) => r.dialSeconds) : null, talkSeconds: metrics ? sum((r) => r.talkSeconds) : null, closed: q.wonDeals, revenue: q.revenue, quality: q,
        wa: wa ? { outbound: sum((r) => r.wa?.outbound), conversations: sum((r) => r.wa?.conversations), handled: sum((r) => r.wa?.handled), firstResponse: null, openNow: sum((r) => r.wa?.openNow) } : null });
      u.avgTalkSeconds = u.answered ? Math.round((u.talkSeconds ?? 0) / u.answered) : null;
      rows.push(u);
    }
  }
  const tsum = (k: "outbound" | "answered" | "handled" | "talkSeconds") => (metrics ? rows.reduce((t, r) => t + (r[k] ?? 0), 0) : null);
  const totals = { outbound: tsum("outbound"), answered: tsum("answered"), handled: tsum("handled"), talkSeconds: tsum("talkSeconds"), closed: rows.reduce((t, r) => t + r.closed, 0), revenue: Math.round(rows.reduce((t, r) => t + r.revenue, 0) * 100) / 100 };
  return ok({ rows, totals, channels, agents: agents.map(a => ({ id: a.id, fullName: a.fullName })), from: from.toISOString(), to: to.toISOString(), timezone: settings.timezone });
}, { minRole: "manager" });
