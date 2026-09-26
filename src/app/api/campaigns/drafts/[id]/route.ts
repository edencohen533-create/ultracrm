import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { ApiError } from "@/lib/response";
import { CampaignError } from "@/server/services/campaign-service";
import { deleteDraft, draftChecks, draftPatchSchema, getDraft, updateDraft } from "@/server/services/campaign-draft-service";

const fail = (error: unknown) => {
  if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof ApiError) return Response.json({ error: error.message, details: error.details }, { status: error.status });
  throw error;
};
export const GET = organizationRequest(async function(_r: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  try { const draft = await getDraft((await params).id); return Response.json({ draft, problems: draftChecks(draft) }); } catch (e) { return fail(e); }
});
export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = draftPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "נתונים לא תקינים" }, { status: 400 });
  try { const draft = await updateDraft((await params).id, parsed.data); return Response.json({ draft, problems: draftChecks(draft) }); } catch (e) { return fail(e); }
});
export const DELETE = organizationRequest(async function(_r: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  try { await deleteDraft((await params).id, actor.id); return Response.json({ ok: true }); } catch (e) { return fail(e); }
});
