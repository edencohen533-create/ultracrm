import { organizationRequest } from "@/lib/auth-compat";
import { draftNeed } from "@/lib/access/campaigns";
import { campaignActor } from "@/lib/campaign-auth";
import { CampaignError } from "@/server/services/campaign-service";
import { draftProblems, draftRevertSchema, revertDraft } from "@/server/services/campaign-draft-service";

/** "צא בלי לשמור" for an existing draft: back to the state the editor opened with. */
export const POST = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = draftRevertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "נתונים לא תקינים" }, { status: 400 });
  try { const draft = await revertDraft((await params).id, parsed.data, actor.id); return Response.json({ draft, problems: await draftProblems(draft) }); }
  catch (e) { if (e instanceof CampaignError) return Response.json({ error: e.message }, { status: 400 }); throw e; }
}, (_r, p) => draftNeed(p.id, "draft"));
