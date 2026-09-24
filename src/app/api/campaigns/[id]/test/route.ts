import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { CampaignError, sendCampaignTest } from "@/server/services/campaign-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Test send of the campaign content to an explicitly configured test recipient (SMS / email). */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ to: z.string().trim().min(3).max(200) }));
  try { return ok(await sendCampaignTest(user, params.id, b.to)); }
  catch (error) { if (error instanceof CampaignError) throw new ApiError(error.message, 400, "campaign_error"); throw error; }
}, { minRole: "manager", module: "messaging" });
