import { organizationRequest } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { campaignActor } from "@/lib/campaign-auth";
import { CampaignError, createCampaign } from "@/server/services/campaign-service";

export const POST = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const source = await prisma.campaign.findUnique({ where: { id }, include: { template: true } });
  if (!source) return Response.json({ error: "הקמפיין לא נמצא" }, { status: 404 });
  // A wizard-built campaign owns a hidden working template – the copy gets its own, so editing one never changes the other.
  let templateId = source.templateId;
  if (source.template.internal) {
    const { id: _i, createdAt: _c, updatedAt: _u, name, providerTemplateId: _p, ...rest } = source.template;
    const clone = await prisma.template.create({ data: { ...rest, name: `${name.slice(0, 80)} · העתק ${Date.now().toString(36)}`, components: rest.components ?? undefined, buttons: rest.buttons ?? undefined, design: rest.design ?? undefined } as never });
    templateId = clone.id;
  }
  try {
    // New snapshot of today's list/template/sender. Never inherit a schedule or delivery history.
    const campaign = await createCampaign({ channel: source.channel, senderId: source.senderId, name: `${source.name.slice(0, 110)} — העתק`, listId: source.listId, listIds: Array.isArray(source.listIds) ? (source.listIds as string[]) : undefined, excludedListIds: Array.isArray(source.excludedListIds) ? source.excludedListIds.filter((id): id is string => typeof id === "string") : [], providerCredentialId: source.providerCredentialId, templateId, variables: source.variables as Record<string, string> }, actor.id);
    return Response.json({ campaign }, { status: 201 });
  } catch (error) {
    if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
});

export const maxDuration = 60;
