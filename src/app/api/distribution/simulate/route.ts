import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { simulateDistribution } from "@/server/ops/distribution";

export const dynamic = "force-dynamic";

/** Preview: how the next N new leads would be distributed now (optionally with a draft rule) – nothing is assigned. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ count: z.number().int().min(1).max(200).default(20), rule: z.object({ config: z.record(z.string(), z.unknown()) }).nullable().optional(), assumeConditionMet: z.boolean().default(false) }));
  return ok(await simulateDistribution(user.businessId, b));
}, { minRole: "owner" });
