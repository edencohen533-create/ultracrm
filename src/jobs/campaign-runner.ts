import { activeSenderSnapshot, templateFingerprint } from "@/server/services/campaign-snapshot";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { sendBlockReason } from "@/lib/suppression";
import { personalizeVariablesForContact } from "@/lib/campaigns";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import { createOutboundMessage, MessagePolicyError, QuotaExceededError } from "@/server/services/message-service";
import { sendChannelMessage } from "@/server/services/channel-send-service";
import { ChannelUnavailableError } from "@/server/channels/registry";
import { ProviderUnavailableError } from "@/server/providers/provider-registry";
import { MAX_AUTO_ATTEMPTS, retryDelayMs } from "@/lib/meta/errors";
import type { Message } from "@/generated/prisma/client";

/**
 * Bounded batches; CAS claims prevent two workers sending the same recipient.
 *  • Every attempt has its own requestKey (`campaign:<recipient>[:a<n>]`) – a retried worker never sends
 *    twice, and an UNKNOWN (timeout) outcome is never retried automatically.
 *  • Transient provider failures (rate limit, 5xx, network) are retried with backoff up to
 *    MAX_AUTO_ATTEMPTS; a rate-limit answer also stops the campaign for the rest of this run.
 *  • Marketing campaigns on every channel respect the business send window and per-minute budget;
 *    a provider outage pauses the campaign (recipients go back to the queue) instead of failing them.
 */
export async function processDueCampaigns(deadline = Date.now() + 45_000) {
  await prisma.campaignRecipient.updateMany({
    where: { status: "PROCESSING", claimedAt: { lt: new Date(Date.now() - 10 * 60_000) }, campaign: { businessId: requireBusinessId() } },
    data: { status: "UNKNOWN", error: "העיבוד נקטע; יש לבדוק אצל הספק לפני שליחה נוספת", completedAt: new Date() },
  });
  await prisma.campaign.updateMany({ where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } }, data: { status: "RUNNING" } });
  const settings = await getBusinessSettings(requireBusinessId());
  const insideWindow = isWithinDialWindow({ ...settings.marketing.window, timezone: settings.marketing.window.timezone ?? settings.timezone });
  const budget = settings.marketing.maxPerMinute > 0 ? settings.marketing.maxPerMinute : Number.MAX_SAFE_INTEGER;
  const now = new Date();
  const due = await prisma.campaignRecipient.findMany({
    where: { status: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }], campaign: { businessId: requireBusinessId(), status: "RUNNING", ...(insideWindow ? {} : { template: { category: { not: "MARKETING" } } }) } },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }], take: 50, include: { campaign: { select: { channel: true } } },
  });
  let processed = 0;
  let sends = 0;
  const pausedCampaigns = new Set<string>();
  for (const recipient of due) {
    if (Date.now() >= deadline) break;
    if (pausedCampaigns.has(recipient.campaignId)) continue;
    if (sends >= budget) break;
    const claimed = await prisma.campaignRecipient.updateMany({
      where: { id: recipient.id, status: "QUEUED", campaign: { businessId: requireBusinessId(), status: "RUNNING" } },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
    if (!claimed.count) continue;
    processed++;
    const attempt = recipient.attempts;
    const requestKey = attempt === 0 ? `campaign:${recipient.id}` : `campaign:${recipient.id}:a${attempt}`;
    /** Transient failure → schedule another attempt (bounded), otherwise final FAILED. */
    const settle = async (message: Message, identifier: string | null) => {
      if (message.status === "FAILED" && message.retryable && attempt + 1 < MAX_AUTO_ATTEMPTS) {
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, messageId: message.id, identifier, attempts: attempt + 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(attempt)), error: `${message.errorReason ?? "כשל זמני"} – ניסיון חוזר מתוזמן (${attempt + 2}/${MAX_AUTO_ATTEMPTS})` } });
        if (message.errorCode === "130429" || message.errorCode === "http_429") pausedCampaigns.add(recipient.campaignId);
        return;
      }
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
        status: message.status === "FAILED" ? "FAILED" : "SENT", messageId: message.id, identifier, attempts: attempt + 1, nextAttemptAt: null,
        error: message.status === "FAILED" ? (message.errorReason ?? "הספק דחה את ההודעה") : null, completedAt: new Date(),
      } });
    };
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
        await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "PAUSED", statusReason: template && ["PAUSED", "DISABLED"].includes(template.status) ? "התבנית הושהתה/הושבתה על ידי Meta" : "החיבור או התבנית השתנו" } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, error: "החיבור או התבנית השתנו. יש ליצור טיוטה חדשה לאחר בדיקה" } });
        pausedCampaigns.add(campaign.id);
        continue;
      }
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: recipient.contactId } });
      const marketing = template.category === "MARKETING" || campaign.channel === "whatsapp";
      // Global suppression (any channel) is re-checked in the worker right before sending.
      const suppressed = await sendBlockReason(requireBusinessId(), contact.id, marketing ? "marketing" : "service");
      if (contact.isBlocked || (marketing && contact.consentStatus !== "OPTED_IN") || suppressed) {
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "SKIPPED", error: suppressed ?? "אין הסכמה פעילה לדיוור", completedAt: new Date() } });
        continue;
      }
      sends++;
      if (campaign.channel !== "whatsapp") {
        try {
          const { message } = await sendChannelMessage({
            channel: campaign.channel, contactId: contact.id, credentialId: campaign.providerCredentialId, templateId: campaign.templateId,
            variables: campaign.variables as Record<string, string>, category: marketing ? "marketing" : "service", requestKey,
            sentByUserId: campaign.createdById, campaignRecipientId: recipient.id, campaignId: campaign.id, senderId: campaign.senderId,
          });
          await settle(message, message.toIdentifier);
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
        templateVariables: personalizeVariablesForContact(campaign.variables as Record<string, string>, contact),
        templateMedia: campaign.mediaUrl ? { link: campaign.mediaUrl } : undefined,
        templateButtonParams: (campaign.buttonParams as Record<string, string> | null) ?? undefined,
        sentByUserId: campaign.createdById, requireOptIn: true, campaignRecipientId: recipient.id, requestKey,
      });
      await settle(message, contact.phoneE164);
    } catch (error) {
      if (error instanceof ChannelUnavailableError || error instanceof ProviderUnavailableError || error instanceof QuotaExceededError) {
        // Nothing reached the provider: pause the campaign with the reason and requeue the recipient (no UNKNOWN, no burned slot).
        const reason = error instanceof QuotaExceededError ? `המכסה החודשית נוצלה: ${error.message.slice(0, 160)}` : `הספק אינו זמין: ${error.message.slice(0, 160)}`;
        await prisma.campaign.updateMany({ where: { id: recipient.campaignId, status: "RUNNING" }, data: { status: "PAUSED", statusReason: reason } });
        await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, messageId: null, error: "הקמפיין הושהה – " + reason } });
        pausedCampaigns.add(recipient.campaignId);
        continue;
      }
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
