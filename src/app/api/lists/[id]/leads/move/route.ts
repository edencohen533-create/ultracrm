import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { moveListLeads } from "@/lib/dialer/list-admin";

export const dynamic = "force-dynamic";

/** "העבר לידים": selected rows (leadIds) or all rows (all: true) to another list of the same business. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ toListId: z.string().min(1).max(64), leadIds: z.array(z.string().min(1).max(64)).max(5000).optional(), all: z.boolean().optional() }));
  return ok(await moveListLeads(user, params.id, b));
}, { minRole: "manager", perm: "telephony.team_settings" });
