import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { ApiError } from "@/lib/response";
import { CampaignError, campaignPreflight } from "@/server/services/campaign-service";
import { buildDraft } from "@/server/services/campaign-draft-service";

/** Review step: freeze the audience into a DRAFT campaign and return its preflight (the real checks). */
export const POST = organizationRequest(async function(_r: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  try {
    const { campaignId } = await buildDraft((await params).id, actor.id);
    return Response.json({ campaignId, preflight: await campaignPreflight(campaignId) });
  } catch (error) {
    if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof ApiError) return Response.json({ error: error.message, details: error.details }, { status: error.status });
    throw error;
  }
});
export const maxDuration = 60;
