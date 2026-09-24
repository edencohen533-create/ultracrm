import { organizationRequest } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { campaignActor } from "@/lib/campaign-auth";
import { distributionListSchema } from "@/lib/campaigns";
import { AudienceError } from "@/server/services/audience-service";
import { saveDistributionList } from "@/server/services/distribution-list-service";
export const GET = organizationRequest(async function() {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const lists = await prisma.distributionList.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { members: true } } } });
  return Response.json({ lists });
});
export const POST = organizationRequest(async function(request: Request) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = distributionListSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "יש להזין שם ולבחור אנשי קשר או תנאי קהל תקינים" }, { status: 400 });
  try { return Response.json({ list: await saveDistributionList(parsed.data, actor.id) }, { status: 201 }); }
  catch (error) { if (error instanceof AudienceError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
});

export const maxDuration = 60;
