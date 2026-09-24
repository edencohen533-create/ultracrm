import { prisma } from "@/lib/db";
import type { MessageStatus } from "@/generated/prisma/client";
import { publishMessageStatus } from "@/lib/realtime/publish";

export function previousStatuses(status: MessageStatus): MessageStatus[] {
  if (status === "READ") return ["QUEUED", "UNKNOWN", "ACCEPTED", "SENT", "DELIVERED"];
  if (status === "DELIVERED") return ["QUEUED", "UNKNOWN", "ACCEPTED", "SENT"];
  if (status === "FAILED") return ["QUEUED", "UNKNOWN", "ACCEPTED", "SENT"];
  if (status === "SENT") return ["QUEUED", "UNKNOWN", "ACCEPTED"];
  return [];
}
export async function updateProviderMessageStatus(providerMessageId: string, status: MessageStatus, timestamp: Date, credentialId?: string, failure?: { reason: string; code: string | null }) {
  // Predicates make repeated/out-of-order callbacks harmless.
  const messages = await prisma.message.findMany({ where: { providerMessageId, ...(credentialId ? { providerCredentialId: credentialId } : {}), direction: "OUTBOUND" }, select: { id: true, conversationId: true, businessId: true, channel: true, category: true, conversation: { select: { contactId: true } }, campaignRecipient: { select: { campaignId: true } } } });
  for (const message of messages) {
    const updated = await prisma.message.updateMany({ where: { id: message.id, status: { in: previousStatuses(status) } }, data: {
      status,
      ...(status === "SENT" ? { sentAt: timestamp } : {}),
      ...(status === "FAILED" ? { failedAt: timestamp, ...(failure ? { errorReason: failure.reason, errorCode: failure.code } : {}) } : {}),
      ...(status === "DELIVERED" ? { deliveredAt: timestamp } : {}),
      ...(status === "READ" ? { readAt: timestamp } : {}),
    } });
    if (!updated.count) continue;
    await publishMessageStatus({ type: "message_status", conversationId: message.conversationId, messageId: message.id, status });
    if (status === "FAILED") {
      const { emitEvent, kickEventProcessing } = await import("@/lib/events");
      await emitEvent(prisma, { businessId: message.businessId, type: "message.delivery_failed", contactId: message.conversation.contactId, source: "webhook", occurredAt: timestamp, dedupeKey: `message.delivery_failed:${message.id}`, payload: { messageId: message.id, channel: message.channel, category: message.category, campaignId: message.campaignRecipient?.campaignId ?? null, permanent: true, detail: failure?.reason ?? null } });
      kickEventProcessing(message.businessId);
    }
  }
}
