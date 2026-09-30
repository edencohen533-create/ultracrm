import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { runSalesCoachJob } from "@/server/coach/sales";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Every 2 minutes: transcribe + analyse queued sales recordings; re-check closed deals waiting for a payment. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const r = await runSalesCoachJob({ deadline: Date.now() + 240_000 });
    return Response.json({ processed: r.length });
  } catch (err) { return handleError(err); }
}
