import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { CampaignError } from "@/server/services/campaign-service";
import { createDraft, listDrafts } from "@/server/services/campaign-draft-service";

const channelSchema = z.enum(["whatsapp", "sms", "email"]);

export const GET = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const ch = channelSchema.safeParse(new URL(request.url).searchParams.get("channel"));
  return Response.json({ drafts: await listDrafts(ch.success ? ch.data : undefined) });
});
export const POST = organizationRequest(async function(request: Request) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = z.object({ channel: channelSchema, name: z.string().max(120).optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "ערוץ לא תקין" }, { status: 400 });
  try { return Response.json({ draft: await createDraft(parsed.data.channel, actor.id, parsed.data.name) }, { status: 201 }); }
  catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
});
