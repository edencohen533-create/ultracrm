import { activeSenderSnapshot, templateFingerprint } from "@/server/services/campaign-snapshot";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { sendBlockReason } from "@/lib/suppression";
import { personalizeVariables } from "@/lib/campaigns";
import { createOutboundMessage, MessagePolicyError } from "@/server/services/message-service";

/** Bounded batches; CAS claims prevent two workers sending the same recipient.
 * Ambiguous sends are never automatically retried (the provider is not idempotent).
 */
export async function processDueCampaigns(deadline = Date.now() + 45_000) {
  await prisma.campaignRecipient.updateMany({
    where: { status: "PROCESSING", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "UNKNOWN", error: "העיבוד נקטע; יש לבדוק אצל הספק לפני שליחה נוספת", completedAt: new Date() },
  });
  await prisma.campaign.updateMany({ where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } }, data: { status: "RUNNING" } });
  const due = await prisma.campaignRecipient.findMany({
    where: { status: "QUEUED", campaign: { status: "RUNNING" } },
    orderBy: { id: "asc" }, take: 20,
  });
  let processed = 0;
  for (const recipient of due) {
    if (Date.now() >= deadline) break;
    const claimed = await prisma.campaignRecipient.updateMany({
      where: { id: recipient.id, status: "QUEUED", campaign: { status: "RUNNING" } },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
    if (!claimed.count) continue;
    processed++;
    try {
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: recipient.campaignId }, include: { createdBy: true } });
      if (campaign.status !== "RUNNING") {
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: campaign.status === "CANCELLED" ? { status: "SKIPPED", error: "הקמפיין בוטל", completedAt: new Date() } : { status: "QUEUED", claimedAt: null } });
        continue;
      }
      if (!campaign.createdBy.isActive || !["owner", "manager"].includes(campaign.createdBy.role)) {
        await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED" } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null } });
        continue;
      }
      const template = await prisma.template.findUnique({ where: { id: campaign.templateId } });
      if (!campaign.senderSnapshot || campaign.senderSnapshot !== await activeSenderSnapshot(campaign.providerCredentialId) || !template || template.status !== "APPROVED" || campaign.templateSnapshot !== templateFingerprint(template)) {
        await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED" } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, error: "החיבור או התבנית השתנו. יש ליצור טיוטה חדשה לאחר בדיקה" } });
        continue;
      }
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: recipient.contactId } });
      // Global suppression (any channel) is re-checked in the worker right before sending.
      const suppressed = await sendBlockReason(requireBusinessId(), contact.id, "marketing");
      if (contact.isBlocked || contact.consentStatus !== "OPTED_IN" || suppressed) {
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
          status: "SKIPPED", error: "אין הסכמה פעילה לדיוור", completedAt: new Date(),
        } });
        continue;
      }
      const conversation = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${contact.id} FOR UPDATE`;
        return await tx.conversation.findFirst({
        where: { contactId: contact.id, providerCredentialId: campaign.providerCredentialId, status: { in: ["OPEN", "PENDING"] }, isSpam: false }, orderBy: { createdAt: "desc" },
      }) ?? await tx.conversation.create({ data: { businessId: requireBusinessId(), contactId: contact.id, providerCredentialId: campaign.providerCredentialId, source: "MANUAL" } });
      });
      const { message } = await createOutboundMessage({
        conversationId: conversation.id, body: "", templateId: campaign.templateId,
        templateVariables: personalizeVariables(campaign.variables as Record<string, string>, contact.fullName),
        sentByUserId: campaign.createdById, requireOptIn: true, campaignRecipientId: recipient.id, requestKey: `campaign:${recipient.id}`,
      });
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
        status: message.status === "FAILED" ? "FAILED" : "SENT", messageId: message.id,
        error: message.status === "FAILED" ? "הספק דחה את ההודעה" : null, completedAt: new Date(),
      } });
    } catch (error) {
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
        status: error instanceof MessagePolicyError ? "SKIPPED" : "UNKNOWN",
        error: error instanceof MessagePolicyError ? error.message : "לא ניתן לאמת את השליחה; יש לבדוק לפני ניסיון נוסף", completedAt: new Date(),
      } });
    }
  }
  await prisma.campaign.updateMany({
    where: { status: "RUNNING", recipients: { none: { status: { in: ["QUEUED", "PROCESSING"] } } } },
    data: { status: "COMPLETED" },
  });
  return { processed };
}
