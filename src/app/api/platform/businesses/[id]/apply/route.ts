import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { applyEntitlementChange } from "@/lib/access/manage";
import { targetSchema, toTarget } from "../../_target";

export const dynamic = "force-dynamic";
const schema = z.object({ target: targetSchema, keep: z.record(z.string(), z.array(z.string())).default({}) });
/** Apply after the preview (seat overflow needs an explicit list of users who keep each module). */
export const POST = withAuth(async ({ req, user, params }) => { const b = await parseBody(req, schema); return ok(await applyEntitlementChange(user, params.id, toTarget(b.target), b.keep)); });
