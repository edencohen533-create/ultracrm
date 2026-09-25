import { organizationRequest } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { campaignActor } from "@/lib/campaign-auth";
import { campaignActionSchema } from "@/lib/campaigns";
import { CampaignError, changeCampaignStatus, campaignPreflight } from "@/server/services/campaign-service";

export const GET = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  if (new URL(request.url).searchParams.get("preflight") === "1") {
    try { return Response.json(await campaignPreflight(id)); }
    catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 404 }); throw error; }
  }
  const page = Math.max(1, Math.min(100000, Number(new URL(request.url).searchParams.get("page")) || 1));
  const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: "asc" }, take: 100, skip: (Math.floor(page) - 1) * 100, include: { contact: { select: { fullName: true, phoneE164: true } } } });
  const messages = await prisma.message.findMany({ where: { id: { in: recipients.flatMap((r) => r.messageId ? [r.messageId] : []) } }, select: { id: true, status: true } });
  return Response.json({ recipients: recipients.map((r) => ({ ...r, contact: { name: r.contact.fullName, phone: r.contact.phoneE164 }, deliveryStatus: messages.find((m) => m.id === r.messageId)?.status ?? null })) });
});
export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const parsed = campaignActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "פעולה לא תקינה" }, { status: 400 });
  try {
    const { auth } = await import("@/lib/auth-compat");
    await changeCampaignStatus(id, parsed.data.action, parsed.data.scheduledAt, (await auth())?.user?.id, parsed.data.scheduledTimezone);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
});
