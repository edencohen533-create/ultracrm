import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Reviewed sales moments (pending / approved / rejected) with the verbatim quote and the deal outcome. */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ status: z.enum(["pending", "approved", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const items = await prisma.coachExample.findMany({ where: { businessId: user.businessId, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: "desc" }, take: f.limit,
    select: { id: true, callId: true, dealId: true, leadId: true, userId: true, objection: true, agentResponse: true, editedResponse: true, stage: true, product: true, outcome: true, quote: true, questions: true, status: true, reviewedAt: true, createdAt: true } });
  const counts = await prisma.coachExample.groupBy({ by: ["status"], where: { businessId: user.businessId }, _count: { _all: true } });
  return ok({ items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) });
}, { minRole: "manager" });
