import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { processBusinesses } from "@/jobs/business-runner";
import { processDueAutomationRuns } from "@/jobs/automation-runner";
import { processDueSequenceRuns } from "@/server/services/sequence-service";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Delayed messaging automations (NO_REPLY_TIMEOUT) – every 2 minutes. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    return Response.json(await processBusinesses("automation", async (deadline, businessId) => {
      const a = await processDueAutomationRuns(deadline);
      const b = await processDueSequenceRuns(deadline, businessId);
      return { processed: a.processed + b.processed };
    }));
  } catch (err) {
    return handleError(err);
  }
}
