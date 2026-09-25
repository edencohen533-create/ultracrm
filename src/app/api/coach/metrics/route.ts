import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { providerStatus, PRICING } from "@/server/coach/providers";

export const dynamic = "force-dynamic";

/**
 * Measured usage only. No "close-rate uplift" – the deal outcomes are shown next to the coached calls without a
 * causal claim; a proper comparison needs a control group and more data than a single business has early on.
 */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  const since = new Date(Date.now() - f.days * 86400_000);
  const bid = user.businessId;
  const [sessions, recs, feedback, objections, cost, examples] = await Promise.all([
    prisma.coachSession.aggregate({ where: { businessId: bid, createdAt: { gte: since } }, _count: { _all: true }, _sum: { sttSeconds: true, tokensIn: true, tokensOut: true, latencyMsTotal: true, latencySamples: true } }),
    prisma.coachRecommendation.count({ where: { businessId: bid, createdAt: { gte: since }, shownAt: { not: null } } }),
    prisma.coachRecommendation.groupBy({ by: ["feedback"], where: { businessId: bid, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.coachRecommendation.groupBy({ by: ["objection"], where: { businessId: bid, createdAt: { gte: since }, objection: { not: null } }, _count: { _all: true }, orderBy: { _count: { objection: "desc" } }, take: 10 }),
    prisma.coachSession.aggregate({ where: { businessId: bid, createdAt: { gte: since } }, _sum: { costUsd: true } }),
    prisma.coachExample.groupBy({ by: ["status", "outcome"], where: { businessId: bid }, _count: { _all: true } }),
  ]);
  const coachedCalls = await prisma.coachSession.findMany({ where: { businessId: bid, createdAt: { gte: since } }, select: { callId: true, call: { select: { talkSeconds: true, leadId: true, contactId: true } } } });
  const talkSeconds = coachedCalls.reduce((a, s) => a + (s.call.talkSeconds ?? 0), 0);
  // Deal outcomes of the leads behind coached calls – descriptive only.
  const leadIds = [...new Set(coachedCalls.map((s) => s.call.leadId).filter((x): x is string => Boolean(x)))];
  const deals = leadIds.length ? await prisma.deal.groupBy({ by: ["status"], where: { leadId: { in: leadIds } }, _count: { _all: true } }) : [];
  const costUsd = Number(cost._sum.costUsd ?? 0);
  return ok({
    days: f.days, providers: providerStatus(), pricing: PRICING,
    sessions: sessions._count._all, recommendationsShown: recs,
    feedback: Object.fromEntries(feedback.map((f) => [f.feedback ?? "none", f._count._all])),
    topObjections: objections.map((o) => ({ objection: o.objection, count: o._count._all })),
    avgLatencyMs: sessions._sum.latencySamples ? Math.round((sessions._sum.latencyMsTotal ?? 0) / sessions._sum.latencySamples) : null,
    usage: { sttSeconds: sessions._sum.sttSeconds ?? 0, tokensIn: sessions._sum.tokensIn ?? 0, tokensOut: sessions._sum.tokensOut ?? 0, costUsd, coachedTalkSeconds: talkSeconds, costPerTalkHourUsd: talkSeconds ? Number((costUsd / (talkSeconds / 3600)).toFixed(4)) : null },
    examples: examples.map((e) => ({ status: e.status, outcome: e.outcome, count: e._count._all })),
    dealOutcomesOfCoachedLeads: Object.fromEntries(deals.map((d) => [d.status, d._count._all])),
    note: "מדדי שימוש נמדדים בלבד. תוצאות העסקאות מוצגות ללא טענה סיבתית – אין קבוצת ביקורת.",
  });
}, { minRole: "manager" });
