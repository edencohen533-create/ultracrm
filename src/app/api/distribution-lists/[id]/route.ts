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

/** Delete a list / segment that no campaign uses (campaign history keeps its audience snapshot). */
export const DELETE = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const { prisma } = await import("@/lib/db");
  const used = await prisma.campaign.count({ where: { OR: [{ listId: id }, { listIds: { array_contains: [id] } }] } });
  if (used) return Response.json({ error: `הסגמנט משמש ב-${used} קמפיינים ולא ניתן למחוק אותו` }, { status: 409 });
  const r = await prisma.distributionList.deleteMany({ where: { id } });
  if (!r.count) return Response.json({ error: "לא נמצא" }, { status: 404 });
  return Response.json({ ok: true });
});
