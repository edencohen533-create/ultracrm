import { organizationRequest } from "@/lib/auth-compat";
import { campaignNeed, draftNeed, queryChannelNeed, bodyChannelNeed, campaignPatchNeed, CAMPAIGN_ANY } from "@/lib/access/campaigns";
import { campaignActor } from "@/lib/campaign-auth";
import { CampaignError, campaignReport } from "@/server/services/campaign-service";

export const GET = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  try { return Response.json(await campaignReport(id)); }
  catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 404 }); throw error; }
}, (_r, p) => campaignNeed(p.id, "view"));
