import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { stopFutureActions } from "@/server/offboarding/offboarding";

export const dynamic = "force-dynamic";
/** Stop scheduled campaigns, dial lists, automations, sequences and CRM sync – confirmed by the business name. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, z.object({ confirmName: z.string().max(120) })); return ok(await stopFutureActions(user, b.confirmName)); });
