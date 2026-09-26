import { prisma } from "@/lib/db";
import { AutomationRunStatus, AutomationActionType, type Prisma } from "@/generated/prisma/client";
import { executeAction } from "@/server/services/automation-service";

/**
 * Processes due delayed AutomationRun rows (currently only produced by the
 * NO_REPLY_TIMEOUT trigger). Called from the Vercel Cron-triggered route.
 * Re-validates the trigger condition still holds before executing the
 * action, since state may have changed between scheduling and firing —
 * e.g. an agent may have replied in the meantime.
 */
export async function processDueAutomationRuns(deadline = Date.now() + 45_000): Promise<{ processed: number }> {
  // An interrupted send may already have reached the provider. Surface it for review,
  // rather than silently abandoning RUNNING rows or repeating an uncertain action.
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  await prisma.automationRun.updateMany({
    where: { status: AutomationRunStatus.RUNNING, OR: [
      { claimedAt: { lt: staleBefore } },
      { claimedAt: null, createdAt: { lt: staleBefore } },
    ] },
    data: { status: AutomationRunStatus.FAILED, completedAt: new Date(), error: "העיבוד נקטע; יש לבדוק את תוצאת הפעולה לפני הרצה נוספת" },
  });
  const due = await prisma.automationRun.findMany({
    where: { status: AutomationRunStatus.PENDING, scheduledFor: { lte: new Date() } },
    take: 25,
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
  });

  let processed = 0;

  for (const run of due) {
    if (Date.now() >= deadline) break;
    const claimed = await prisma.automationRun.updateMany({
      where: { id: run.id, status: AutomationRunStatus.PENDING },
      data: { status: AutomationRunStatus.RUNNING, claimedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // claimed by a concurrent invocation

    processed++;

    const rule = await prisma.automationRule.findUnique({ where: { id: run.ruleId } });
    if (!rule || !rule.isActive || !run.conversationId) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: AutomationRunStatus.COMPLETED, result: { skipped: "rule inactive or no conversation" }, completedAt: new Date() },
      });
      continue;
    }

    const conversation = await prisma.conversation.findUnique({ where: { id: run.conversationId } });
    const snapshot = (run.triggerPayload ?? {}) as Record<string, unknown>;
    const sameInbound = typeof snapshot.inboundAt !== "string" || conversation?.lastInboundAt?.toISOString() === snapshot.inboundAt;
    const stillUnanswered = sameInbound &&
      conversation?.lastInboundAt &&
      (!conversation.lastMessageAt || conversation.lastMessageAt.getTime() <= conversation.lastInboundAt.getTime());

    if (!stillUnanswered) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: AutomationRunStatus.COMPLETED,
          result: { skipped: "condition no longer holds — conversation was answered" },
          completedAt: new Date(),
        },
      });
      continue;
    }

    try {
      const result = await executeAction(
        typeof snapshot.actionType === "string" && Object.values(AutomationActionType).includes(snapshot.actionType as AutomationActionType)
          ? snapshot.actionType as AutomationActionType : rule.actionType,
        (snapshot.actionConfig ?? rule.actionConfig) as Record<string, unknown>, {
        conversationId: run.conversationId,
        runId: run.id,
      });
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: AutomationRunStatus.COMPLETED, result: result as Prisma.InputJsonValue, completedAt: new Date() },
      });
    } catch (error) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: AutomationRunStatus.FAILED,
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });
    }
  }

  return { processed };
}
