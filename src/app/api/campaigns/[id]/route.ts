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
  const sp = new URL(request.url).searchParams;
  const page = Math.max(1, Math.min(100000, Number(sp.get("page")) || 1));
  const status = sp.get("status"); const q = sp.get("q")?.trim().slice(0, 100);
  const where = { campaignId: id, ...(status && ["QUEUED", "PROCESSING", "SENT", "FAILED", "SKIPPED", "UNKNOWN"].includes(status) ? { status: status as "QUEUED" } : {}), ...(q ? { contact: { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { phoneE164: { contains: q } }, { email: { contains: q, mode: "insensitive" as const } }] } } : {}) };
  const total = await prisma.campaignRecipient.count({ where });
  const recipients = await prisma.campaignRecipient.findMany({ where, orderBy: { id: "asc" }, take: 100, skip: (Math.floor(page) - 1) * 100, include: { contact: { select: { fullName: true, phoneE164: true } } } });
  const messages = await prisma.message.findMany({ where: { id: { in: recipients.flatMap((r) => r.messageId ? [r.messageId] : []) } }, select: { id: true, status: true, errorReason: true, errorCode: true, retryable: true, acceptedAt: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true } });
  return Response.json({ total, page, recipients: recipients.map((r) => { const m = messages.find((x) => x.id === r.messageId); return { ...r, contact: { name: r.contact.fullName, phone: r.contact.phoneE164 }, deliveryStatus: m?.status ?? null, deliveryError: m?.errorReason ?? null, errorCode: m?.errorCode ?? null, retryable: m?.retryable ?? false, timeline: m ? { acceptedAt: m.acceptedAt, sentAt: m.sentAt, deliveredAt: m.deliveredAt, readAt: m.readAt, failedAt: m.failedAt } : null }; }) });
});
export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const { auth } = await import("@/lib/auth-compat");
  const actorId = (await auth())?.user?.id;
  if (body && typeof body.name === "string" && !body.action) {
    const { renameCampaign } = await import("@/server/services/campaign-service");
    try { await renameCampaign(id, body.name.trim().slice(0, 120), actorId ?? null); return Response.json({ ok: true }); }
    catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 409 }); throw error; }
  }
  const parsed = campaignActionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "פעולה לא תקינה" }, { status: 400 });
  try {
    if (parsed.data.action === "retry_recipient") {
      if (!parsed.data.recipientId) return Response.json({ error: "חסר מזהה נמען" }, { status: 400 });
      const { retryRecipient } = await import("@/server/services/campaign-service");
      return Response.json(await retryRecipient(id, parsed.data.recipientId, Boolean(parsed.data.confirmNotSent), actorId ?? null));
    }
    await changeCampaignStatus(id, parsed.data.action, parsed.data.scheduledAt, actorId, parsed.data.scheduledTimezone);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
});

export const DELETE = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const { deleteDraftCampaign } = await import("@/server/services/campaign-service");
  try { await deleteDraftCampaign(id, actor.id, { withBuilderDraft: true }); return Response.json({ ok: true }); }
  catch (error) { if (error instanceof CampaignError) return Response.json({ error: error.message }, { status: 409 }); throw error; }
});
