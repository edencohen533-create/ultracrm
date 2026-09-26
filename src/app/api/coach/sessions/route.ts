import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Calls in which the coach was active: who, when, how many recommendations, feedback, cost, latency, outcome. */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const sessions = await prisma.coachSession.findMany({ where: { businessId: user.businessId }, orderBy: { createdAt: "desc" }, take: f.limit,
    include: { call: { select: { id: true, createdAt: true, answeredAt: true, talkSeconds: true, outcome: true, toE164: true, user: { select: { id: true, fullName: true } }, contact: { select: { id: true, fullName: true } }, leadId: true } }, recommendations: { select: { id: true, feedback: true, basis: true, latencyMs: true } } } });
  const items = sessions.map((s) => ({
    id: s.id, callId: s.callId, status: s.status, createdAt: s.createdAt, stage: s.stage, lastObjection: s.lastObjection, segmentsCount: s.segmentsCount,
    call: { id: s.call.id, at: s.call.createdAt, answered: Boolean(s.call.answeredAt), talkSeconds: s.call.talkSeconds, outcome: s.call.outcome, agent: s.call.user, contact: s.call.contact, leadId: s.call.leadId },
    recommendations: s.recommendations.length, helpful: s.recommendations.filter((r) => r.feedback === "helpful").length, notHelpful: s.recommendations.filter((r) => r.feedback === "not_helpful").length,
    costUsd: Number(s.costUsd), sttSeconds: s.sttSeconds, avgLatencyMs: s.latencySamples ? Math.round(s.latencyMsTotal / s.latencySamples) : null,
  }));
  return ok({ items });
}, { minRole: "manager" });
