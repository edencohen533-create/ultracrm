import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { CampaignError } from "@/server/services/campaign-service";
import { testDraft } from "@/server/services/campaign-draft-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Test send of the draft's content to an explicitly configured test recipient. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ to: z.string().trim().min(3).max(200) }));
  try { return ok(await testDraft(params.id, user, b.to)); }
  catch (error) { if (error instanceof CampaignError) throw new ApiError(error.message, 400, "campaign_error"); throw error; }
}, { minRole: "manager", module: "messaging" });
