import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { cancelRecommendation, managerDecision } from "@/server/ops/engine";

const schema = z.object({
  action: z.enum(["approve", "reject", "cancel"]),
  edits: z.object({ mode: z.enum(["extra", "priority", "share"]).optional(), count: z.number().int().min(1).max(100).optional(), sharePct: z.number().int().min(10).max(100).optional(), source: z.string().max(120).nullable().optional(), listId: z.string().max(60).nullable().optional(), fromUnassigned: z.boolean().optional() }).optional(),
});

/** Manager: approve (sets the ceiling; the agent is asked next) / reject / cancel an allocation. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  if (b.action === "cancel") { await cancelRecommendation(user, params.id); return ok({ status: "cancelled" }); }
  return ok(await managerDecision(user, params.id, { action: b.action, edits: b.edits, via: "app" }));
}, { minRole: "manager", module: "crm" });
