import { z } from "zod";
import { organizationRequest, auth } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { requireBusinessId } from "@/lib/tenant";
import { draftSegment, SegmentDraftError } from "@/server/ai/segment-builder";

/** Free text → a draft segment (validated, counted, NOT saved). Same permission as building a segment. */
export const POST = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const session = await auth();
  const input = z.object({ prompt: z.string().trim().min(4).max(1000) }).safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "יש לתאר את הקהל במילים (עד 1000 תווים)" }, { status: 400 });
  const { getBusinessSettings } = await import("@/lib/settings");
  const { timezone } = await getBusinessSettings(requireBusinessId());
  try { return Response.json(await draftSegment({ businessId: requireBusinessId(), userId: session!.user.id, prompt: input.data.prompt, timezone })); }
  catch (error) { if (error instanceof SegmentDraftError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
}, ["crm.edit", "sms.draft", "email.draft", "whatsapp.campaign_draft"]);
export const maxDuration = 90;
