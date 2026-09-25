import { MAX_AUDIENCE_SIZE } from "@/lib/audiences";
import { resolveAudience, AudienceError } from "./audience-service";
import { resolveSender, ProviderUnavailableError } from "@/server/providers/provider-registry";
import { activeSenderSnapshot, templateFingerprint } from "./campaign-snapshot";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { consumeQuota } from "@/lib/modules";
import { ApiError } from "@/lib/response";
import { campaignSchema, validateTemplateVariables, personalizeVariables, renderTemplate } from "@/lib/campaigns";
import type { z } from "zod";
import type { CampaignStatus } from "@/generated/prisma/client";

export class CampaignError extends Error {}

export async function createCampaign(input: z.infer<typeof campaignSchema>, actorUserId: string) {
  let sender;
  try { sender = await resolveSender(input.providerCredentialId); }
  catch (error) { if (error instanceof ProviderUnavailableError) throw new CampaignError(error.message); throw error; }
  const providerCredentialId = sender?.id ?? null;
  const senderSnapshot = await activeSenderSnapshot(providerCredentialId);
  return prisma.$transaction(async (tx) => {
    const template = await tx.template.findUnique({ where: { id: input.templateId } });
    if (!template || template.status !== "APPROVED") throw new CampaignError("יש לבחור תבנית מאושרת");
    if (sender?.provider === "meta_whatsapp_cloud_api" && template.providerAccountId !== (sender.config as Record<string, unknown>).businessAccountId) throw new CampaignError("התבנית אינה שייכת לחשבון WhatsApp של המספר השולח. יש לסנכרן תבניות");
    try { validateTemplateVariables(template.body, input.variables); }
    catch (error) { throw new CampaignError((error as Error).message); }
    const excludedListIds = input.excludedListIds ?? [];
    const audience = await resolveAudience(tx, input.listId, excludedListIds, new Date());
    const contacts = await tx.contact.findMany({ where: audience.base, select: { id: true }, orderBy: { id: "asc" }, take: MAX_AUDIENCE_SIZE + 1 });
    if (!contacts.length) throw new CampaignError("הקהל ריק כעת. יש לבדוק את תנאי הקהל");
    if (contacts.length > MAX_AUDIENCE_SIZE) throw new CampaignError("הקהל גדול מ־10,000 אנשי קשר. יש לצמצם את התנאים לפני יצירת קמפיין");
    const excluded = audience.exclusion ? await tx.contact.findMany({ where: { AND: [audience.base, audience.exclusion] }, select: { id: true } }) : [];
    const excludedIds = new Set(excluded.map((contact) => contact.id));
    // Both dynamic conditions and exclusions are frozen into recipient rows in this transaction.
    return tx.campaign.create({ data: {
      businessId: requireBusinessId(), ...input, excludedListIds, providerCredentialId, createdById: actorUserId, senderSnapshot, templateSnapshot: templateFingerprint(template),
      audienceExcludedCount: excludedIds.size,
      audienceSnapshot: { frozenAt: new Date().toISOString(), lists: audience.lists.map((list) => ({ id: list.id, name: list.name, segment: list.segment })) },
      recipients: { createMany: { data: contacts.map(({ id: contactId }) => ({ contactId, ...(excludedIds.has(contactId) ? { status: "SKIPPED" as const, error: "הוחרג מהקהל ביצירת הטיוטה", completedAt: new Date() } : {}) })) } },
    } });
  }, { isolationLevel: "RepeatableRead", timeout: 30000 }).catch((error) => { if (error instanceof AudienceError) throw new CampaignError(error.message); throw error; });
}

export async function changeCampaignStatus(id: string, action: "start" | "pause" | "resume" | "cancel", scheduledAt?: string) {
  if (action === "start") {
    try { await consumeQuota(requireBusinessId(), "campaigns_started"); }
    catch (error) { if (error instanceof ApiError) throw new CampaignError(error.message); throw error; }
  }
  if (action === "start" || action === "resume") {
    const review = await campaignPreflight(id);
    if (review.blockers.length) throw new CampaignError(review.blockers.join("; "));
    if (!review.eligible) throw new CampaignError("אין נמענים זכאים לשליחה כעת");
  }
  const from: Record<typeof action, CampaignStatus[]> = {
    start: ["DRAFT"], pause: ["SCHEDULED", "RUNNING"], resume: ["PAUSED"], cancel: ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED"],
  };
  const date = scheduledAt ? new Date(scheduledAt) : new Date();
  if (scheduledAt && (action !== "start" || date.getTime() < Date.now())) {
    throw new CampaignError("מועד התזמון חייב להיות עתידי ולהיקבע בתחילת הקמפיין");
  }
  const status: CampaignStatus = action === "cancel" ? "CANCELLED" : action === "pause" ? "PAUSED" : "SCHEDULED";
  await prisma.$transaction(async (tx) => {
    const result = await tx.campaign.updateMany({
      where: { id, status: { in: from[action] } },
      data: { status, ...((action === "start" || action === "resume") ? { scheduledAt: date } : {}) },
    });
    if (!result.count) throw new CampaignError("לא ניתן לבצע פעולה זו במצב הנוכחי של הקמפיין");
    if (action === "cancel") {
      await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: "QUEUED" }, data: { status: "SKIPPED", error: "הקמפיין בוטל", completedAt: new Date() } });
    }
  });
}

export async function listCampaigns() {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" }, take: 100,
    include: { list: { select: { name: true } }, template: { select: { name: true } }, _count: { select: { recipients: true } } },
  });
  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true,
  });
  return campaigns.map((campaign) => ({ ...campaign,
    counts: Object.fromEntries(counts.filter((c) => c.campaignId === campaign.id).map((c) => [c.status, c._count])),
  }));
}

/** A snapshot for review, never a promise of eligibility at dispatch time. */
export async function campaignPreflight(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { template: true, recipients: { where: { status: "QUEUED" }, include: { contact: true } } } });
  if (!campaign) throw new CampaignError("הקמפיין לא נמצא");
  const sender = await activeSenderSnapshot(campaign.providerCredentialId);
  const blockers: string[] = [];
  if (!campaign.senderSnapshot || sender !== campaign.senderSnapshot || sender.startsWith("blocked:")) blockers.push("החיבור השתנה או חסום. צור טיוטה חדשה לאחר אימות החיבור");
  if (campaign.template.status !== "APPROVED" || templateFingerprint(campaign.template) !== campaign.templateSnapshot) blockers.push("התבנית השתנתה או אינה מאושרת. סנכרן תבניות וצור טיוטה חדשה");
  const exclusions: Record<string, number> = {};
  const samples: { name: string; phone: string; body: string }[] = [];
  let eligible = 0;
  for (const { contact } of campaign.recipients) {
    const reason = contact.isBlocked ? "חסימה מלאה" : contact.consentStatus !== "OPTED_IN" ? "אין הסכמה פעילה" : contact.lastMarketingAt && Date.now() - contact.lastMarketingAt.getTime() < 86400000 ? "מגבלת תדירות ל־24 שעות" : null;
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    try {
      const variables = personalizeVariables(campaign.variables as Record<string, string>, contact.fullName);
      validateTemplateVariables(campaign.template.body, variables);
      eligible++;
      if (samples.length < 3) samples.push({ name: contact.fullName, phone: contact.phoneE164, body: renderTemplate(campaign.template.body, variables) });
    } catch { exclusions["משתנים חסרים"] = (exclusions["משתנים חסרים"] ?? 0) + 1; }
  }
  const active = campaign.providerCredentialId ? await prisma.providerCredential.findUnique({ where: { id: campaign.providerCredentialId }, select: { provider: true, config: true, label: true, displayPhoneNumber: true } }) : null;
  const phoneNumberId = (active?.config as Record<string, unknown> | undefined)?.phoneNumberId;
  return { eligible, audienceExcluded: campaign.audienceExcludedCount, totalQueued: campaign.recipients.length, exclusions, blockers, samples, sender: active ? `${active.label || active.provider} · ${active.displayPhoneNumber || String(phoneNumberId ?? "")}` : "הדגמה בלבד", audiencePolicy: "קהל מוקפא ביצירת הטיוטה; זכאות נבדקת מחדש בכל שליחה", cost: null };
}
