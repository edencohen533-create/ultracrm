import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { distributionListSchema } from "@/lib/campaigns";
import { AudienceError } from "@/server/services/audience-service";
import { saveDistributionList } from "@/server/services/distribution-list-service";
export const PUT = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = distributionListSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "תנאי קהל או רשימה אינם תקינים" }, { status: 400 });
  try { return Response.json({ list: await saveDistributionList(parsed.data, actor.id, (await params).id) }); }
  catch (error) { if (error instanceof AudienceError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
});

export const maxDuration = 60;
