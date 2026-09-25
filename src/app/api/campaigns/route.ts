import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { campaignSchema } from "@/lib/campaigns";
import { CampaignError, createCampaign, listCampaigns } from "@/server/services/campaign-service";

export const GET = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  const q = url.searchParams.get("q")?.slice(0, 100) ?? undefined;
  return Response.json({ campaigns: await listCampaigns(["whatsapp", "sms", "email"].includes(channel ?? "") ? (channel as "whatsapp" | "sms" | "email") : undefined, q) });
});
export const POST = organizationRequest(async function(request: Request) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = campaignSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "פרטי הקמפיין אינם תקינים" }, { status: 400 });
  try { return Response.json({ campaign: await createCampaign(parsed.data, actor.id) }, { status: 201 }); }
  catch (error) {
    if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
});

export const maxDuration = 60;
