import { requireBusinessId } from "@/lib/tenant";
import { personalizeVariables } from "@/lib/campaigns";
import { prisma } from "@/lib/db";
import {
  AutomationActionType,
  AutomationRunStatus,
  AutomationTrigger,
  ConversationStatus,
  MessageStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { createOutboundMessage } from "@/server/services/message-service";
import { writeAuditLog } from "@/lib/audit";

export async function listRules() {
  return prisma.automationRule.findMany({ orderBy: { createdAt: "desc" } });
}

export async function listRuns() {
  return prisma.automationRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { rule: true },
  });
}

interface TriggerContext {
  conversationId?: string;
  tagId?: string;
  runId?: string;
}



async function getSystemActorId(): Promise<string> {
  const admin = await prisma.user.findFirst({ where: { role: { in: ["owner", "manager"] }, isActive: true }, orderBy: { createdAt: "asc" } });
  if (!admin) throw new Error("No admin user found to attribute automation actions to");
  return admin.id;
}

/**
 * Evaluates all active rules for a given trigger and runs their actions.
 * Used for the four "immediate" triggers, called inline right after the
 * relevant DB write (new message, new conversation, tag added, unassigned).
 * The delayed NO_REPLY_TIMEOUT trigger is handled separately by the cron
 * job in src/jobs/automation-runner.ts.
 */
export async function evaluateTrigger(trigger: AutomationTrigger, context: TriggerContext): Promise<void> {
  const rules = await prisma.automationRule.findMany({ where: { trigger, isActive: true } });

  for (const rule of rules) {
    if (trigger === AutomationTrigger.TAG_ADDED) {
      const config = rule.triggerConfig as { tagName?: string };
      if (config.tagName && context.tagId) {
        const tag = await prisma.tag.findUnique({ where: { id: context.tagId } });
        if (tag?.name !== config.tagName) continue;
      }
    }

    await runRule(rule.id, context);
  }
}

export async function runRule(ruleId: string, context: TriggerContext): Promise<void> {
  const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: ruleId } });

  if (!rule.isActive) return;

  const run = await prisma.automationRun.create({
    data: {
      businessId: requireBusinessId(),
      ruleId: rule.id,
      conversationId: context.conversationId ?? null,
      status: AutomationRunStatus.RUNNING,
      triggerPayload: context as Prisma.InputJsonValue,
    },
  });

  try {
    const result = await executeAction(rule.actionType, rule.actionConfig as Record<string, unknown>, { ...context, runId: run.id });
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

export async function scheduleNoReplyChecks(conversationId: string): Promise<void> {
  const rules = await prisma.automationRule.findMany({
    where: { trigger: AutomationTrigger.NO_REPLY_TIMEOUT, isActive: true },
  });

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { lastInboundAt: true } });
  if (!conversation?.lastInboundAt) return;
  for (const rule of rules) {
    const minutes = (rule.triggerConfig as { minutes?: number }).minutes ?? 30;
    await prisma.automationRun.create({
      data: {
        businessId: requireBusinessId(),
        ruleId: rule.id,
        conversationId,
        status: AutomationRunStatus.PENDING,
        scheduledFor: new Date(Date.now() + minutes * 60_000),
        triggerPayload: {
          conversationId,
          inboundAt: conversation.lastInboundAt.toISOString(),
          // Pending runs retain the action that was configured when scheduled.
          actionType: rule.actionType,
          actionConfig: rule.actionConfig,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

export async function executeAction(
  actionType: AutomationActionType,
  config: Record<string, unknown>,
  context: TriggerContext
): Promise<Record<string, unknown>> {
  if (!context.conversationId) {
    return { skipped: "no conversation in context" };
  }
  const conversationId = context.conversationId;

  switch (actionType) {
    case AutomationActionType.ASSIGN_AGENT: {
      const agentId = config.agentId as string | undefined;
      if (!agentId) return { skipped: "no agentId configured" };
      const agent = await prisma.user.findFirst({ where: { id: agentId, isActive: true }, select: { id: true, role: true, teamId: true } });
      if (!agent) return { skipped: "agent unavailable" };
      const teamScope: Prisma.ConversationWhereInput = agent.role === "agent" ? { OR: [{ providerCredentialId: null }, { providerCredential: { teamId: null } }, ...(agent.teamId ? [{ providerCredential: { teamId: agent.teamId } }] : [])] } : {};
      const assigned = await prisma.conversation.updateMany({ where: { id: conversationId, ...teamScope }, data: { assignedAgentId: agentId } });
      if (!assigned.count) return { skipped: "conversation unavailable or agent outside number team" };
      await writeAuditLog({
        action: "automation.assigned",
        entityType: "Conversation",
        entityId: conversationId,
        conversationId,
        metadata: { agentId },
      });
      return { assignedAgentId: agentId };
    }

    case AutomationActionType.ADD_TAG: {
      const tagName = config.tagName as string | undefined;
      if (!tagName) return { skipped: "no tagName configured" };
      const tag = await prisma.tag.upsert({ where: { businessId_name: { businessId: requireBusinessId(), name: tagName } }, update: {}, create: { businessId: requireBusinessId(), name: tagName } });
      await prisma.conversationTag.upsert({
        where: { conversationId_tagId: { conversationId, tagId: tag.id } },
        update: {},
        create: { conversationId, tagId: tag.id },
      });
      return { tagId: tag.id };
    }

    case AutomationActionType.CHANGE_STATUS: {
      const status = config.status as ConversationStatus | undefined;
      if (!status) return { skipped: "no status configured" };
      await prisma.conversation.update({ where: { id: conversationId }, data: { status } });
      return { status };
    }

    case AutomationActionType.ADD_INTERNAL_NOTE: {
      const body = (config.body as string | undefined) ?? "הערה אוטומטית";
      const authorId = await getSystemActorId();
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { contactId: true } });
      const note = await prisma.note.create({ data: { businessId: requireBusinessId(), conversationId, contactId: conv.contactId, authorId, body } });
      return { noteId: note.id };
    }

    case AutomationActionType.SEND_CANNED_REPLY: {
      const cannedReplyId = config.cannedReplyId as string | undefined;
      if (!cannedReplyId) return { skipped: "no cannedReplyId configured" };
      const reply = await prisma.cannedReply.findUnique({ where: { id: cannedReplyId } });
      if (!reply) return { skipped: "canned reply not found" };
      const sentByUserId = await getSystemActorId();
      const { message } = await createOutboundMessage({ conversationId, body: reply.body, sentByUserId, automated: true, requestKey: context.runId ? `automation:${context.runId}` : undefined });
      assertAccepted(message);
      return { messageId: message.id };
    }

    case AutomationActionType.SEND_TEMPLATE: {
      const templateId = config.templateId as string | undefined;
      if (!templateId) return { skipped: "no templateId configured" };
      const template = await prisma.template.findUnique({ where: { id: templateId } });
      if (!template) return { skipped: "template not found" };
      const sentByUserId = await getSystemActorId();
      const contact = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { contact: { select: { fullName: true } } } });
      const variables = personalizeVariables((config.variables ?? {}) as Record<string, string>, contact.contact.fullName);
      const { message } = await createOutboundMessage({
        conversationId,
        body: template.body,
        sentByUserId,
        templateId: template.id,
        automated: true,
        templateVariables: variables,
        requestKey: context.runId ? `automation:${context.runId}` : undefined,
      });
      assertAccepted(message);
      return { messageId: message.id };
    }

    default:
      return { skipped: "unknown action type" };
  }
}

function assertAccepted(message: { status: MessageStatus; errorReason?: string | null }) {
  if (!new Set<MessageStatus>([MessageStatus.ACCEPTED, MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ]).has(message.status)) {
    throw new Error(message.errorReason || "השליחה לא אושרה על ידי הספק; אין לבצע ניסיון חוזר אוטומטי");
  }
}
