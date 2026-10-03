import { z } from "zod";
import { withAuth, parseQuery, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { createTextInsight } from "@/server/coach/sales";
import { textInsightSchema } from "@/lib/validation/coach-text";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Review queue / approved knowledge (current versions only), with the source recording and its timestamp. */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ status: z.enum(["candidate", "approved", "rejected", "removed"]).default("candidate"), needsReview: z.enum(["1"]).optional(), kind: z.string().max(20).optional() }));
  const where = { businessId: user.businessId, status: f.status, ...(f.needsReview ? { needsReview: true } : {}), ...(f.kind ? { kind: f.kind } : {}) };
  const [items, counts, flagged] = await Promise.all([
    prisma.salesInsight.findMany({ where, orderBy: [{ needsReview: "desc" }, { createdAt: "desc" }], take: 200, include: { recording: { select: { id: true, title: true, source: true, status: true, dealId: true } } } }),
    prisma.salesInsight.groupBy({ by: ["status"], where: { businessId: user.businessId, status: { not: "superseded" } }, _count: { _all: true } }),
    prisma.salesInsight.count({ where: { businessId: user.businessId, needsReview: true, status: { in: ["candidate", "approved"] } } }),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the embedding vector is never sent to the browser
  return ok({ items: items.map(({ embedding: _e, ...x }) => x), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), needsReview: flagged });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });

/** Manual coaching text joins the existing review/version/retrieval pipeline. */
export const POST = withAuth(async ({ req, user }) => {
  const input = await parseBody(req, textInsightSchema);
  const row = await createTextInsight(user, input);
  return ok({ id: row.id, status: row.status });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
