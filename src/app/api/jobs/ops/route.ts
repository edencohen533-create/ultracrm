import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { withoutBusiness } from "@/lib/tenant";
import { runOpsChecks } from "@/server/ops/monitor";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
/** Every 10 minutes: unified platform alerts (deduplicated, auto-resolved when the condition clears). */
export async function GET(request: Request) {
  try { requireCronSecret(request); return Response.json(await withoutBusiness(() => runOpsChecks())); }
  catch (err) { return handleError(err); }
}
