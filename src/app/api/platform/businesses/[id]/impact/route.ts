import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { computeImpact, requirePlatformAdmin } from "@/lib/access/manage";
import { targetSchema, toTarget } from "../../_target";

export const dynamic = "force-dynamic";
/** Preview: who / what would be affected (users, seats, campaigns, automations, dialer) – nothing changes. */
export const POST = withAuth(async ({ req, user, params }) => { await requirePlatformAdmin(user); return ok(await computeImpact(params.id, toTarget(await parseBody(req, targetSchema)))); });
