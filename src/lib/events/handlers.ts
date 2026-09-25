/**
 * Built-in cross-module automations. Each handler runs at most once per event
 * (see AutomationJob) and must be safe for late / out-of-order events.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { getBusinessSettings } from "@/lib/settings";
import type { DomainEvent } from "@/generated/prisma/client";
import { MAX_AUTOMATION_DEPTH } from "./index";

export interface EventHandler {
  name: string;
  types: string[];
  run: (event: DomainEvent) => Promise<Record<string, unknown> | void>;
}

function payload<T extends Record<string, unknown>>(event: DomainEvent): T {
  return ((event.payload ?? {}) as T);
}

/** Bump the contact's activity timestamp without moving it backwards. */
async function touchContact(contactId: string | null, at: Date) {
  if (!contactId) return;
  await prisma.contact.updateMany({ where: { id: contactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }] }, data: { lastActivityAt: at } });
}

/**
 * Choose the owner of a new lead that has none. A contact already owned by an *agent* keeps that agent; a contact whose
 * owner is the manager/owner who imported it goes through the distribution policy (round robin / least loaded, cap per
 * agent) and only falls back to that manager when the policy finds nobody.
 */
async function pickOwner(businessId: string, preferredUserId?: string | null) {
  let fallback: string | null = null;
  if (preferredUserId) {
    const u = await prisma.user.findFirst({ where: { id: preferredUserId, businessId, isActive: true }, select: { id: true, role: true } });
    if (u?.role === "agent") return u.id;
    if (u) fallback = u.id;
  }
  // Distribution policy (settings → leads → חלוקת לידים): least-loaded (default) or round robin, optional cap per agent.
  const settings = await getBusinessSettings(businessId);
  const policy = settings.leadAssignment;
  const agents = await prisma.user.findMany({ where: { businessId, isActive: true, role: { in: ["agent", "manager"] }, ...(policy.agentIds.length ? { id: { in: policy.agentIds } } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, _count: { select: { ownedLeads: { where: { status: { in: ["new", "contacted", "qualified"] } } } } } } });
  const eligible = agents.filter((a) => !policy.maxOpenLeadsPerAgent || a._count.ownedLeads < policy.maxOpenLeadsPerAgent);
  if (eligible.length === 0) return agents.length === 0 ? fallback : null; // no pool at all → the importing manager; pool exhausted (cap) → unassigned
  let chosen: string;
  if (policy.mode === "round_robin") {
    const idx = eligible.findIndex((a) => a.id === policy.lastAssignedUserId);
    chosen = eligible[(idx + 1) % eligible.length].id;
  } else {
    chosen = [...eligible].sort((a, b) => a._count.ownedLeads - b._count.ownedLeads)[0].id;
  }
  // Persist the pointer (raw JSON merge – no other settings touched).
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { settings: true } });
  const raw = (biz?.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
  const la = (raw.leadAssignment && typeof raw.leadAssignment === "object" ? raw.leadAssignment : {}) as Record<string, unknown>;
  await prisma.business.update({ where: { id: businessId }, data: { settings: { ...raw, leadAssignment: { ...la, lastAssignedUserId: chosen } } as Prisma.InputJsonValue } });
  return chosen;
}

const leadCreated: EventHandler = {
  name: "lead.assign-and-task",
  types: ["lead.created"],
  async run(event) {
    const { leadId } = payload<{ leadId: string }>(event);
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { contact: { select: { ownerUserId: true, fullName: true } } } });
    if (!lead) return { skipped: "lead missing" };
    let ownerUserId = lead.ownerUserId;
    if (!ownerUserId) {
      ownerUserId = await pickOwner(event.businessId, lead.contact.ownerUserId);
      if (ownerUserId) await prisma.lead.updateMany({ where: { id: lead.id, ownerUserId: null }, data: { ownerUserId } });
    }
    if (!ownerUserId) return { skipped: "no active agent" };
    const settings = await getBusinessSettings(event.businessId);
    const task = await prisma.task.upsert({
      where: { businessId_requestKey: { businessId: event.businessId, requestKey: `lead:${lead.id}:first-contact` } },
      create: {
        businessId: event.businessId, userId: ownerUserId, createdById: null, contactId: lead.contactId, leadId: lead.id, type: "follow_up",
        title: `פנייה ראשונית לליד – ${lead.contact.fullName}`, dueAt: new Date(Date.now() + settings.automations.newLeadTaskMinutes * 60_000),
        note: lead.source ? `מקור: ${lead.source}` : null, requestKey: `lead:${lead.id}:first-contact`,
      },
      update: {},
    });
    await audit(event.businessId, null, "automation", lead.id, "automation.lead_assigned", { trigger: event.type, ownerUserId, taskId: task.id, result: "ok" });
    return { ownerUserId, taskId: task.id };
  },
};

const callEnded: EventHandler = {
  name: "call.timeline",
  types: ["call.ended"],
  async run(event) {
    const { answered } = payload<{ answered?: boolean }>(event);
    await touchContact(event.contactId, event.occurredAt);
    if (event.contactId && answered) {
      const r = await prisma.lead.updateMany({ where: { contactId: event.contactId, status: "new" }, data: { status: "contacted" } });
      return { leadsContacted: r.count };
    }
    return {};
  },
};

const outcomeFollowUp: EventHandler = {
  name: "call.outcome-follow-up",
  types: ["call.outcome_saved"],
  async run(event) {
    const { callId, outcome, userId } = payload<{ callId: string; outcome: string; userId: string }>(event);
    if (!event.contactId) return { skipped: "no contact" };
    const settings = await getBusinessSettings(event.businessId);
    const result: Record<string, unknown> = {};
    // Follow-up task for interested / sale (callback outcome already created its own task in the dialer).
    if (settings.automations.followUpTaskOutcomes.includes(outcome)) {
      const task = await prisma.task.upsert({
        where: { businessId_requestKey: { businessId: event.businessId, requestKey: `call:${callId}:follow-up` } },
        create: {
          businessId: event.businessId, userId, contactId: event.contactId, callId, type: "follow_up", title: "מעקב אחרי שיחה",
          dueAt: new Date(Date.now() + settings.automations.followUpTaskHours * 3600_000), note: `תוצאת שיחה: ${outcome}`, requestKey: `call:${callId}:follow-up`,
        },
        update: {},
      });
      result.taskId = task.id;
    }
    // Lead pipeline
    if (outcome === "answered_interested") result.leadsQualified = (await prisma.lead.updateMany({ where: { contactId: event.contactId, status: { in: ["new", "contacted"] } }, data: { status: "qualified" } })).count;
    if (outcome === "answered_not_interested") result.leadsUnqualified = (await prisma.lead.updateMany({ where: { contactId: event.contactId, status: { in: ["new", "contacted"] } }, data: { status: "unqualified", closedAt: new Date() } })).count;
    if (outcome === "sale") {
      const openLead = await prisma.lead.findFirst({ where: { contactId: event.contactId, status: { in: ["new", "contacted", "qualified"] } }, orderBy: { createdAt: "desc" } });
      const contact = await prisma.contact.findUnique({ where: { id: event.contactId }, select: { fullName: true } });
      const deal = await prisma.deal.create({ data: { businessId: event.businessId, contactId: event.contactId, leadId: openLead?.id, title: `מכירה טלפונית – ${contact?.fullName ?? ""}`.trim(), stage: "won", status: "won", ownerUserId: userId, closedAt: new Date(), notes: `נוצר אוטומטית מתוצאת שיחה ${callId}` } });
      if (openLead) await prisma.lead.update({ where: { id: openLead.id }, data: { status: "converted", dealId: deal.id, closedAt: new Date() } });
      result.dealId = deal.id;
    }
    await audit(event.businessId, null, "automation", callId, "automation.outcome_follow_up", { trigger: event.type, outcome, ...result, result: "ok" });
    return result;
  },
};

const outcomeFollowUpMessage: EventHandler = {
  name: "call.outcome-follow-up-message",
  types: ["call.outcome_saved"],
  async run(event) {
    if (event.depth >= MAX_AUTOMATION_DEPTH) return { skipped: "automation depth" };
    const { callId, outcome, userId } = payload<{ callId: string; outcome: string; userId: string }>(event);
    if (!event.contactId) return { skipped: "no contact" };
    const settings = await getBusinessSettings(event.businessId);
    const cfg = settings.automations.followUpMessage;
    if (!cfg.enabled || !cfg.templateId || !cfg.outcomes.includes(outcome)) return { skipped: "not configured for this outcome" };
    const { isModuleEnabled } = await import("@/lib/modules");
    if (!(await isModuleEnabled(event.businessId, "messaging"))) return { skipped: "messaging module disabled" };
    const { sendBlockReason } = await import("@/lib/suppression");
    const template = await prisma.template.findUnique({ where: { id: cfg.templateId } });
    if (!template || template.status !== "APPROVED") return { skipped: "template not approved" };
    const category = template.category === "MARKETING" ? "marketing" : "service";
    const blocked = await sendBlockReason(event.businessId, event.contactId, category);
    if (blocked) return { skipped: blocked };
    const { resolveSender, ProviderUnavailableError } = await import("@/server/providers/provider-registry");
    let sender;
    try { sender = await resolveSender(undefined); } catch (err) { if (err instanceof ProviderUnavailableError) return { skipped: err.message }; throw err; }
    if (!sender) return { skipped: "אין ערוץ WhatsApp מחובר – הודעת המשך לא נשלחה" };
    const { startConversationForAutomation } = await import("@/server/services/conversation-service");
    const { createOutboundMessage, MessagePolicyError } = await import("@/server/services/message-service");
    const { personalizeVariables } = await import("@/lib/campaigns");
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: event.contactId }, select: { fullName: true } });
    const conversation = await startConversationForAutomation(event.contactId, sender.id, userId);
    try {
      const { message } = await createOutboundMessage({
        conversationId: conversation.id, body: template.body, templateId: template.id, sentByUserId: userId,
        templateVariables: personalizeVariables(cfg.variables ?? {}, contact.fullName), automated: true, requireOptIn: category === "marketing",
        requestKey: `event:${event.id}:follow-up`, eventDepth: event.depth + 1,
      });
      await audit(event.businessId, null, "automation", callId, "automation.follow_up_message", { trigger: event.type, outcome, messageId: message.id, status: message.status, result: "ok" });
      return { messageId: message.id, status: message.status };
    } catch (err) {
      if (err instanceof MessagePolicyError) {
        await audit(event.businessId, null, "automation", callId, "automation.follow_up_message", { trigger: event.type, outcome, result: "skipped", reason: err.message });
        return { skipped: err.message };
      }
      throw err;
    }
  },
};

const messageReceived: EventHandler = {
  name: "message.timeline",
  types: ["message.received", "message.sent"],
  async run(event) {
    await touchContact(event.contactId, event.occurredAt);
    if (event.type === "message.received" && event.contactId) {
      const r = await prisma.lead.updateMany({ where: { contactId: event.contactId, status: "new" }, data: { status: "contacted" } });
      return { leadsContacted: r.count };
    }
    return {};
  },
};

const suppressed: EventHandler = {
  name: "contact.enforce-suppression",
  types: ["contact.suppressed"],
  async run(event) {
    if (!event.contactId) return { skipped: "no contact" };
    const { stopPendingMarketing } = await import("@/lib/suppression");
    const { scope } = payload<{ scope: "marketing" | "all" }>(event);
    return await stopPendingMarketing(event.businessId, event.contactId, scope ?? "marketing");
  },
};

const taskCreated: EventHandler = {
  name: "task.timeline",
  types: ["task.created", "deal.created", "deal.won", "lead.status_changed"],
  async run(event) {
    await touchContact(event.contactId, event.occurredAt);
    return {};
  },
};

const sequences: EventHandler = {
  name: "marketing.sequences",
  types: ["message.delivery_failed", "message.sent", "contact.tag_added", "contact.created", "lead.status_changed"],
  async run(event) {
    const { isModuleEnabled } = await import("@/lib/modules");
    if (!(await isModuleEnabled(event.businessId, "messaging"))) return { skipped: "messaging module disabled" };
    const { startSequencesForEvent } = await import("@/server/services/sequence-service");
    return await startSequencesForEvent(event);
  },
};

/** Real-time sales coach: extract reviewable examples after a call, label them when the deal closes. Never blocks the call. */
const coachLearning: EventHandler = {
  name: "coach.learning",
  types: ["call.ended", "deal.won", "deal.lost"],
  async run(event) {
    const { learnFromCall, attachDealOutcome } = await import("@/server/coach/learning");
    if (event.type === "call.ended") {
      const { callId } = payload<{ callId?: string }>(event);
      if (!callId) return { skipped: "no callId" };
      return (await learnFromCall(callId)) ?? {};
    }
    const { dealId } = payload<{ dealId?: string }>(event);
    if (!dealId) return { skipped: "no dealId" };
    return attachDealOutcome(dealId, event.type === "deal.won" ? "won" : "lost");
  },
};

export const HANDLERS: EventHandler[] = [coachLearning, leadCreated, callEnded, outcomeFollowUp, outcomeFollowUpMessage, messageReceived, suppressed, taskCreated, sequences];
