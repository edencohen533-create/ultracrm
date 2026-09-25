import { resolveSender, ProviderUnavailableError } from "@/server/providers/provider-registry";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { AutomationTrigger, type Prisma } from "@/generated/prisma/client";
import type { Session } from "@/lib/auth-compat";
import { evaluateTrigger } from "@/server/services/automation-service";

export interface ConversationListFilter {
  status?: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
  assignedTo?: "me" | "unassigned" | "all";
  search?: string;
  providerCredentialId?: string;
  tagId?: string;
  teamId?: string;
  channel?: "whatsapp" | "sms" | "email";
}

/**
 * Builds the Prisma where-clause for a conversation list query, scoped to
 * the requesting user's role. Agents only ever see conversations assigned
 * to them or unassigned ones — enforced here at the data layer, not just
 * hidden in the UI, so an Agent can't reach other agents' conversations by
 * manipulating query params.
 */
export function buildConversationScope(session: Session, filter: ConversationListFilter = {}): Prisma.ConversationWhereInput {
  const clauses: Prisma.ConversationWhereInput[] = [];

  if (session.user.role === "agent") {
    clauses.push({ OR: [{ assignedAgentId: session.user.id }, { assignedAgentId: null }] });
    clauses.push({ OR: [{ providerCredentialId: null }, { providerCredential: { teamId: null } }, ...(session.user.teamId ? [{ providerCredential: { teamId: session.user.teamId } }] : [])] });
  }

  if (filter.providerCredentialId) clauses.push({ providerCredentialId: filter.providerCredentialId });
  if (filter.tagId) clauses.push({ tags: { some: { tagId: filter.tagId } } });
  if (filter.teamId) clauses.push({ OR: [{ providerCredential: { teamId: filter.teamId } }, { assignedAgent: { teamId: filter.teamId } }] });
  if (filter.channel) clauses.push({ channel: filter.channel });

  if (filter.status) {
    clauses.push({ status: filter.status });
  }

  if (filter.assignedTo === "me") {
    clauses.push({ assignedAgentId: session.user.id });
  } else if (filter.assignedTo === "unassigned") {
    clauses.push({ assignedAgentId: null });
  }

  if (filter.search) {
    clauses.push({
      OR: [
        { contact: { fullName: { contains: filter.search, mode: "insensitive" } } },
        ...(filter.search.replace(/\D/g, "").length >= 3 ? [{ contact: { phoneE164: { contains: filter.search.replace(/\D/g, "") } } }] : []),
        { contact: { email: { contains: filter.search, mode: "insensitive" } } },
        { messages: { some: { body: { contains: filter.search, mode: "insensitive" } } } },
      ],
    });
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}

export function buildContactScope(session: Session): Prisma.ContactWhereInput {
  return session.user.role === "agent" ? { OR: [
    { conversations: { none: {} } },
    { conversations: { some: buildConversationScope(session) } },
  ] } : {};
}


export async function listConversations(session: Session, filter: ConversationListFilter = {}) {
  return prisma.conversation.findMany({
    where: buildConversationScope(session, filter),
    orderBy: { lastMessageAt: "desc" },
    include: {
      contact: true,
      providerCredential: { select: { id: true, label: true, displayPhoneNumber: true, teamId: true, isActive: true, sendingBlocked: true } },
      assignedAgent: { select: { id: true, fullName: true } },
      tags: { include: { tag: true } },
      messages: { take: 1, orderBy: { createdAt: "desc" }, select: { body: true, direction: true } },
    },
    take: 100,
  });
}

export async function getConversationForUser(session: Session, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, ...buildConversationScope(session) },
    include: {
      providerCredential: { select: { id: true, label: true, displayPhoneNumber: true, teamId: true, isActive: true, sendingBlocked: true } },
      contact: { include: { tags: { include: { tag: true } } } },
      assignedAgent: { select: { id: true, fullName: true } },
      tags: { include: { tag: true } },
      messages: {
        take: 100,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { attachments: true, sentByUser: { select: { id: true, fullName: true } }, template: true },
      },
      notes: { orderBy: { createdAt: "desc" }, include: { author: { select: { id: true, fullName: true } } } },
    },
  });

  if (conversation) conversation.messages.reverse();
  return conversation;
}

export async function assignConversation(conversationId: string, agentId: string | null, actorUserId: string, scope: Prisma.ConversationWhereInput = {}) {
  const agent = agentId ? await prisma.user.findFirst({ where: { id: agentId, isActive: true }, select: { role: true, teamId: true } }) : null;
  if (agentId && !agent) return null;
  const teamScope: Prisma.ConversationWhereInput = agent?.role === "agent" ? { OR: [{ providerCredentialId: null }, { providerCredential: { teamId: null } }, ...(agent.teamId ? [{ providerCredential: { teamId: agent.teamId } }] : [])] } : {};
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, AND: [scope, teamScope] }, data: { assignedAgentId: agentId },
  });
  if (!result.count) return null;
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

  await prisma.auditLog.create({
    data: {
      businessId: requireBusinessId(),
      actorId: actorUserId,
      action: "conversation.assigned",
      entityType: "Conversation",
      entityId: conversationId,
      conversationId,
      payload: { assignedAgentId: agentId },
    },
  });

  if (agentId === null) {
    await evaluateTrigger(AutomationTrigger.CONVERSATION_UNASSIGNED, { conversationId });
  }

  return conversation;
}

export class ConversationStartError extends Error {}

/** Locks the contact so manual starts and inbound webhooks cannot create duplicate open threads. */
export async function startConversation(session: Session, contactId: string, agentId?: string | null, senderId?: string | null) {
  let sender;
  try { sender = await resolveSender(senderId); }
  catch (error) { if (error instanceof ProviderUnavailableError) throw new ConversationStartError(error.message); throw error; }
  if (session.user.role === "agent" && sender?.teamId && sender.teamId !== session.user.teamId) throw new ConversationStartError("המספר אינו משויך לצוות שלך");
  const providerCredentialId = sender?.id ?? null;
  const assignee = agentId === undefined ? session.user.id : agentId;
  if (session.user.role === "agent" && assignee !== session.user.id) throw new ConversationStartError("נציג יכול לשייך שיחה חדשה לעצמו בלבד");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${contactId} FOR UPDATE`;
    const contact = await tx.contact.findFirst({ where: { id: contactId, ...buildContactScope(session) } });
    if (!contact) throw new ConversationStartError("איש הקשר לא נמצא או משויך לנציג אחר");
    // Opening/assigning a thread sends nothing. Outbound service/marketing eligibility is enforced at send time.
    const previous = await tx.conversation.findFirst({ where: { contactId, providerCredentialId }, orderBy: { createdAt: "desc" } });
    if (session.user.role === "agent" && previous?.assignedAgentId && previous.assignedAgentId !== session.user.id) throw new ConversationStartError("הליד משויך לנציג אחר");
    if (assignee && !await tx.user.findFirst({ where: { id: assignee, isActive: true, ...(sender?.teamId ? { OR: [{ teamId: sender.teamId }, { role: { in: ["owner", "manager"] } }] } : {}) }, select: { id: true } })) throw new ConversationStartError("הנציג אינו פעיל");
    const existing = await tx.conversation.findFirst({ where: { contactId, providerCredentialId, status: { in: ["OPEN", "PENDING"] } }, orderBy: { createdAt: "desc" } });
    if (existing) {
      if (session.user.role === "agent" && existing.assignedAgentId && existing.assignedAgentId !== session.user.id) throw new ConversationStartError("השיחה משויכת לנציג אחר");
      return existing;
    }
    const conversation = await tx.conversation.create({ data: { businessId: requireBusinessId(), contactId, providerCredentialId, assignedAgentId: assignee, source: "MANUAL", lastMessageAt: new Date() } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session.user.id, action: "conversation.started", entityType: "Conversation", entityId: conversation.id, conversationId: conversation.id, payload: { assignedAgentId: assignee } } });
    return conversation;
  });
}

/** Open (or reuse) the conversation an automation sends into. No permission checks: callers are trusted workers. */
export async function startConversationForAutomation(contactId: string, providerCredentialId: string | null, assignedAgentId: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${contactId} FOR UPDATE`;
    const existing = await tx.conversation.findFirst({ where: { contactId, providerCredentialId, status: { in: ["OPEN", "PENDING"] } }, orderBy: { createdAt: "desc" } });
    if (existing) return existing;
    return tx.conversation.create({ data: { businessId: requireBusinessId(), contactId, providerCredentialId, assignedAgentId, source: "MANUAL", lastMessageAt: new Date() } });
  });
}
