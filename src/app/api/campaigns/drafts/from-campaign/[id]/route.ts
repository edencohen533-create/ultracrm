import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { CampaignError } from "@/server/services/campaign-service";
import { draftFromCampaign } from "@/server/services/campaign-draft-service";

/** "המשך עריכה" on a DRAFT campaign created before the builder existed. */
export const POST = organizationRequest(async function(_r: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  try { return Response.json({ draft: await draftFromCampaign((await params).id, actor.id) }); }
  catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
});
