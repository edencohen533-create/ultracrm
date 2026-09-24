import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { processBusinesses } from "@/jobs/business-runner";
import { processDueCampaigns } from "@/jobs/campaign-runner";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Campaign sender – every minute (Vercel Cron or any scheduler with the bearer secret). */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    return Response.json(await processBusinesses("campaign", (deadline) => processDueCampaigns(deadline)));
  } catch (err) {
    return handleError(err);
  }
}
