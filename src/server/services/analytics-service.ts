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

  return {
    openConversations,
    messagesToday,
    avgFirstResponseMinutes: firstResponseCount > 0 ? Math.round(totalFirstResponseMs / firstResponseCount / 60000) : null,
    avgResolutionHours: null, // updatedAt is not a closure timestamp; do not invent handling duration.
    firstResponseCount,
    conversationsInRangeCount: conversationsInRange.length,
    perAgent: Array.from(perAgent.values()),
  };
}
