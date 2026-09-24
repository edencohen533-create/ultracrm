import { prisma } from "@/lib/db";
import { ConversationStatus, MessageDirection } from "@/generated/prisma/client";

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export async function getOverviewStats(range: AnalyticsRange) {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const [openConversations, messagesToday] = await Promise.all([
    prisma.conversation.count({ where: { status: ConversationStatus.OPEN } }),
    prisma.message.count({ where: { createdAt: { gte: startOfToday } } }),
  ]);

  const conversationsInRange = await prisma.conversation.findMany({
    where: { createdAt: { gte: range.from, lte: range.to } },
    select: {
      id: true,
      createdAt: true,
      status: true,
      updatedAt: true,
      assignedAgentId: true,
      assignedAgent: { select: { fullName: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { direction: true, createdAt: true, status: true },
      },
    },
  });

  let totalFirstResponseMs = 0;
  let firstResponseCount = 0;

  for (const conversation of conversationsInRange) {
    const firstInbound = conversation.messages.find((m) => m.direction === MessageDirection.INBOUND);
    const firstOutboundAfter = conversation.messages.find(
      (m) => m.direction === MessageDirection.OUTBOUND && ["SENT", "DELIVERED", "READ"].includes(m.status) && firstInbound && m.createdAt > firstInbound.createdAt
    );
    if (firstInbound && firstOutboundAfter) {
      totalFirstResponseMs += firstOutboundAfter.createdAt.getTime() - firstInbound.createdAt.getTime();
      firstResponseCount++;
    }
  }

  const perAgent = new Map<string, { name: string; total: number; resolved: number }>();
  for (const conversation of conversationsInRange) {
    if (!conversation.assignedAgentId || !conversation.assignedAgent) continue;
    const entry = perAgent.get(conversation.assignedAgentId) ?? {
      name: conversation.assignedAgent.fullName,
      total: 0,
      resolved: 0,
    };
    entry.total++;
    if (conversation.status === ConversationStatus.RESOLVED || conversation.status === ConversationStatus.CLOSED) {
      entry.resolved++;
    }
    perAgent.set(conversation.assignedAgentId, entry);
  }

  // Per outbound number (11.02): outbound messages and delivery outcomes in range, by provider credential.
  const byNumberRaw = await prisma.message.groupBy({ by: ["providerCredentialId", "status"], where: { direction: MessageDirection.OUTBOUND, createdAt: { gte: range.from, lte: range.to }, providerCredentialId: { not: null } }, _count: { _all: true } });
  const credentials = await prisma.providerCredential.findMany({ where: { id: { in: [...new Set(byNumberRaw.map((r) => r.providerCredentialId!))] } }, select: { id: true, label: true, displayPhoneNumber: true, channel: true, isActive: true } });
  const perNumber = credentials.map((c) => {
    const rows = byNumberRaw.filter((r) => r.providerCredentialId === c.id);
    const count = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
    return { id: c.id, label: c.label || c.displayPhoneNumber || c.id, channel: c.channel, isActive: c.isActive, sent: count(["ACCEPTED", "SENT", "DELIVERED", "READ"]), delivered: count(["DELIVERED", "READ"]), read: count(["READ"]), failed: count(["FAILED", "BOUNCED"]), unknown: count(["UNKNOWN"]) };
  });

  return {
    openConversations,
    messagesToday,
    perNumber,
    range,
    avgFirstResponseMinutes: firstResponseCount > 0 ? Math.round(totalFirstResponseMs / firstResponseCount / 60000) : null,
    avgResolutionHours: null, // updatedAt is not a closure timestamp; do not invent handling duration.
    firstResponseCount,
    conversationsInRangeCount: conversationsInRange.length,
    perAgent: Array.from(perAgent.values()),
  };
}
