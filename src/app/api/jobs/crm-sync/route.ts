import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { runCrmSync } from "@/server/crm-sync/runner";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Every minute: external CRM pull steps (initial / poll / reconcile / gap fill) and write-back queues. */
export async function GET(request: Request) {
  try { requireCronSecret(request); return Response.json({ steps: (await runCrmSync(Date.now() + 45_000)).length }); }
  catch (err) { return handleError(err); }
}
