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
export async function updateProviderMessageStatus(providerMessageId: string, status: MessageStatus, timestamp: Date, credentialId?: string) {
  // Predicates make repeated/out-of-order callbacks harmless.
  const messages = await prisma.message.findMany({ where: { providerMessageId, ...(credentialId ? { providerCredentialId: credentialId } : {}), direction: "OUTBOUND" }, select: { id: true, conversationId: true } });
  for (const message of messages) {
    const updated = await prisma.message.updateMany({ where: { id: message.id, status: { in: previousStatuses(status) } }, data: {
      status,
      ...(status === "SENT" ? { sentAt: timestamp } : {}),
      ...(status === "FAILED" ? { failedAt: timestamp } : {}),
      ...(status === "DELIVERED" ? { deliveredAt: timestamp } : {}),
      ...(status === "READ" ? { readAt: timestamp } : {}),
    } });
    if (updated.count) await publishMessageStatus({ type: "message_status", conversationId: message.conversationId, messageId: message.id, status });
  }
}
