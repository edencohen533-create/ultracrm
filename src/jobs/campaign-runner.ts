import { activeSenderSnapshot, templateFingerprint } from "@/server/services/campaign-snapshot";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { sendBlockReason } from "@/lib/suppression";
import { personalizeVariables } from "@/lib/campaigns";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import { createOutboundMessage, MessagePolicyError } from "@/server/services/message-service";
import { sendChannelMessage } from "@/server/services/channel-send-service";
import { ChannelUnavailableError } from "@/server/channels/registry";

/**
 * Bounded batches; CAS claims prevent two workers sending the same recipient.
 * Ambiguous sends are never automatically retried (providers are not idempotent).
 * SMS / email respect the business marketing window and per-minute rate limit; a provider
 * outage pauses the campaign (recipients go back to the queue) instead of failing them.
 */
export async function processDueCampaigns(deadline = Date.now() + 45_000) {
  await prisma.campaignRecipient.updateMany({
    where: { status: "PROCESSING", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "UNKNOWN", error: "העיבוד נקטע; יש לבדוק אצל הספק לפני שליחה נוספת", completedAt: new Date() },
  });
  await prisma.campaign.updateMany({ where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } }, data: { status: "RUNNING" } });
  const settings = await getBusinessSettings(requireBusinessId());
  const insideWindow = isWithinDialWindow({ ...settings.marketing.window, timezone: settings.marketing.window.timezone ?? settings.timezone });
  const channelBudget = settings.marketing.maxPerMinute > 0 ? settings.marketing.maxPerMinute : Number.MAX_SAFE_INTEGER;
  const due = await prisma.campaignRecipient.findMany({
    where: { status: "QUEUED", campaign: { status: "RUNNING", ...(insideWindow ? {} : { channel: "whatsapp" }) } },
    orderBy: { id: "asc" }, take: 50, include: { campaign: { select: { channel: true } } },
  });
  let processed = 0;
  let channelSends = 0;
  const pausedCampaigns = new Set<string>();
  for (const recipient of due) {
    if (Date.now() >= deadline) break;
    if (pausedCampaigns.has(recipient.campaignId)) continue;
    const isChannel = recipient.campaign.channel !== "whatsapp";
    if (isChannel && channelSends >= channelBudget) continue;
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
        await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED", statusReason: "יוצר הקמפיין אינו פעיל או איבד הרשאה" } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null } });
        continue;
      }
      const template = await prisma.template.findUnique({ where: { id: campaign.templateId } });
      if (!campaign.senderSnapshot || campaign.senderSnapshot !== await activeSenderSnapshot(campaign.providerCredentialId) || !template || template.status !== "APPROVED" || campaign.templateSnapshot !== templateFingerprint(template)) {
        await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED", statusReason: "החיבור או התבנית השתנו" } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, error: "החיבור או התבנית השתנו. יש ליצור טיוטה חדשה לאחר בדיקה" } });
        pausedCampaigns.add(campaign.id);
        continue;
      }
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: recipient.contactId } });
      const marketing = template.category === "MARKETING" || campaign.channel === "whatsapp";
      // Global suppression (any channel) is re-checked in the worker right before sending.
      const suppressed = await sendBlockReason(requireBusinessId(), contact.id, marketing ? "marketing" : "service");
      if (contact.isBlocked || (marketing && contact.consentStatus !== "OPTED_IN") || suppressed) {
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
          status: "SKIPPED", error: suppressed ?? "אין הסכמה פעילה לדיוור", completedAt: new Date(),
        } });
        continue;
      }
      if (campaign.channel !== "whatsapp") {
        channelSends++;
        try {
          const { message } = await sendChannelMessage({
            channel: campaign.channel, contactId: contact.id, credentialId: campaign.providerCredentialId, templateId: campaign.templateId,
            variables: campaign.variables as Record<string, string>, category: marketing ? "marketing" : "service", requestKey: `campaign:${recipient.id}`,
            sentByUserId: campaign.createdById, campaignRecipientId: recipient.id, campaignId: campaign.id, senderId: campaign.senderId,
          });
          await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
            status: message.status === "FAILED" ? "FAILED" : "SENT", messageId: message.id, identifier: message.toIdentifier,
            error: message.status === "FAILED" ? (message.errorReason ?? "הספק דחה את ההודעה") : null, completedAt: new Date(),
          } });
        } catch (error) {
          if (error instanceof ChannelUnavailableError) {
            // Provider unreachable / disconnected: pause the whole campaign, requeue this recipient, do not mark anyone failed.
            await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED", statusReason: `הספק אינו זמין: ${error.message.slice(0, 200)}` } });
            await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, messageId: null, error: "הספק אינו זמין – הקמפיין הושהה" } });
            pausedCampaigns.add(campaign.id);
            continue;
          }
          throw error;
        }
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
        status: message.status === "FAILED" ? "FAILED" : "SENT", messageId: message.id, identifier: contact.phoneE164,
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
