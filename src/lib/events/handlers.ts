/**
 * Built-in cross-module automations. Each handler runs at most once per event
 * (see AutomationJob) and must be safe for late / out-of-order events.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { getBusinessSettings, mergeSettings } from "@/lib/settings";
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
async function pickOwner(businessId: string, preferredUserId?: string | null, source: string | null = null): Promise<{ owner: string | null; overrideId: string | null; listId: string | null; reason: Record<string, unknown> }> {
  let fallback: string | null = null;
  if (preferredUserId) {
    const u = await prisma.user.findFirst({ where: { id: preferredUserId, businessId, isActive: true }, select: { id: true, role: true } });
    if (u?.role === "agent") return { owner: u.id, overrideId: null, listId: null, reason: { rule: "contact_owner", detail: "איש הקשר כבר שייך לנציג הזה" } };
    if (u) fallback = u.id;
  }
  // Distribution policy (CRM → חלוקת לידים): least-loaded (default) or round robin, optional cap per agent and
  // availability. The decision itself is pure (src/lib/crm/distribution.ts – shared with the preview); read pointer →
  // decide → write pointer runs under a per-business advisory lock, so two new leads at the same moment can never both
  // be handed out from the same pointer (no double turn, no skipped turn).
  const { ruleFor } = await import("@/server/ops/rules");
  const loadCap = await ruleFor(businessId, "load_cap").catch(() => null);
  const { decide } = await import("@/lib/crm/distribution");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-assign:${businessId}`}))`;
    const biz = await tx.business.findUnique({ where: { id: businessId }, select: { settings: true } });
    const policy = mergeSettings(biz?.settings).leadAssignment;
    const users = await tx.user.findMany({ where: { businessId, isActive: true, role: { in: ["agent", "manager"] } }, orderBy: { createdAt: "asc" }, select: { id: true, _count: { select: { ownedLeads: { where: { status: { in: ["new", "contacted", "qualified"] } } } } } } });
    const auto = loadCap?.autonomy === "auto";
    const untouched = auto && users.length ? await tx.lead.groupBy({ by: ["ownerUserId"], where: { businessId, ownerUserId: { in: users.map((a) => a.id) }, status: "new", NOT: { contact: { calls: { some: { direction: "outbound", leadDialedAt: { not: null } } } } } }, _count: { _all: true } }) : [];
    const online = policy.requireOnline && users.length ? new Set((await tx.dialerSession.findMany({ where: { businessId, userId: { in: users.map((u) => u.id) }, status: "active", lastHeartbeatAt: { gte: new Date(Date.now() - 5 * 60_000) } }, select: { userId: true } })).map((x) => x.userId)) : null;
    const agents = users.map((u) => ({ id: u.id, openLeads: u._count.ownedLeads, untouched: untouched.find((x) => x.ownerUserId === u.id)?._count._all ?? 0, online: online ? online.has(u.id) : true }));
    const pool = policy.agentIds.length ? agents.filter((a) => policy.agentIds.includes(a.id)) : agents;
    // The active temporary allocation (approved "מנהל AI" request / distribution rule) – see src/server/ops/engine.ts.
    const { activeOverride, recordOverride } = await import("@/server/ops/engine");
    const ov = await activeOverride(tx, businessId, source);
    const d = decide(policy, agents, auto ? loadCap!.config.maxUntouched : null, ov);
    // No pool at all → the importing manager; pool exhausted (cap / load / availability) → unassigned.
    if (!d.owner) return { owner: pool.length === 0 ? fallback : null, overrideId: null, listId: null, reason: { rule: "none", ...d.reason } };
    const listId = ov ? await recordOverride(tx, ov, d, d.reason.eligible) : null;
    if (d.movePointer) {
      // Persist the pointer (raw JSON merge – no other settings touched).
      const raw = (biz?.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
      const la = (raw.leadAssignment && typeof raw.leadAssignment === "object" ? raw.leadAssignment : {}) as Record<string, unknown>;
      await tx.business.update({ where: { id: businessId }, data: { settings: { ...raw, leadAssignment: { ...la, lastAssignedUserId: d.owner } } as Prisma.InputJsonValue } });
    }
    return { owner: d.owner, overrideId: d.overrideId, listId, reason: { rule: d.overrideId ? "allocation" : policy.mode, pointerFrom: policy.lastAssignedUserId, ...d.reason } };
  });
}

const leadCreated: EventHandler = {
  name: "lead.assign-and-task",
  types: ["lead.created"],
  async run(event) {
    const { leadId } = payload<{ leadId: string }>(event);
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { contact: { select: { ownerUserId: true, fullName: true } } } });
    if (!lead) return { skipped: "lead missing" };
    let ownerUserId = lead.ownerUserId;
    // An existing customer without an active handling agent waits for a manager – never round robin.
    if (!ownerUserId && lead.reviewReason) {
      await audit(event.businessId, null, "lead", lead.id, "automation.lead_review", { reason: lead.reviewReason, existingCustomer: lead.existingCustomer });
      return { skipped: `review: ${lead.reviewReason}` };
    }
    if (!ownerUserId) {
      const picked = await pickOwner(event.businessId, lead.contact.ownerUserId, lead.source);
      ownerUserId = picked.owner;
      const set = ownerUserId ? await prisma.lead.updateMany({ where: { id: lead.id, ownerUserId: null }, data: { ownerUserId } }) : { count: 0 };
      // Why this lead went to this agent (or stayed unassigned) – shown in the lead's history and the distribution screen.
      await audit(event.businessId, null, "lead", lead.id, set.count ? "lead.assigned" : "lead.unassigned", { owner: set.count ? ownerUserId : null, ...picked.reason });
      if (set.count && picked.overrideId) {
        // Allocated through an approved "מנהל AI" allocation: traceable per lead, queued in its campaign if set.
        const ov = await prisma.assignmentOverride.findUnique({ where: { id: picked.overrideId }, select: { recommendationId: true } });
        await audit(event.businessId, null, "lead", lead.id, "ai_ops.lead_allocated", { recommendationId: ov?.recommendationId ?? null, overrideId: picked.overrideId, agentId: ownerUserId });
        // An inactive / archived list gets no automatically distributed leads.
        if (picked.listId && await (await import("@/lib/dialer/list-admin")).isListOpen(prisma, picked.listId)) await prisma.listLead.createMany({ data: [{ businessId: event.businessId, listId: picked.listId, contactId: lead.contactId, preferredUserId: ownerUserId }], skipDuplicates: true });
      }
    }
    if (!ownerUserId) return { skipped: "no active agent" };
    // Personal WhatsApp to the agent (if enabled) – never blocks the assignment / task.
    const { notifyAgentNewLead } = await import("@/server/services/agent-notify");
    await notifyAgentNewLead(event.businessId, lead.id, ownerUserId).catch((e: Error) => console.error("agent notify failed", { leadId: lead.id, error: e.message }));
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
    const { callId, outcome, userId, statusId, statusDefId } = payload<{ callId: string; outcome: string; userId: string; statusId?: string | null; statusDefId?: string | null }>(event);
    if (!event.contactId) return { skipped: "no contact" };
    const settings = await getBusinessSettings(event.businessId);
    const result: Record<string, unknown> = {};
    // The agent chose a CRM status at wrap-up: it was already written to the lead (dialer/calls.ts) – no mapping here.
    const chosenStatus = Boolean(statusId);
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
    if (!chosenStatus && outcome === "answered") result.leadsContacted = (await prisma.lead.updateMany({ where: { contactId: event.contactId, status: "new" }, data: { status: "contacted" } })).count;
    if (!chosenStatus && outcome === "answered_interested") result.leadsQualified = (await prisma.lead.updateMany({ where: { contactId: event.contactId, status: { in: ["new", "contacted"] } }, data: { status: "qualified" } })).count;
    if (!chosenStatus && outcome === "answered_not_interested") result.leadsUnqualified = (await prisma.lead.updateMany({ where: { contactId: event.contactId, status: { in: ["new", "contacted"] } }, data: { status: "unqualified", closedAt: new Date() } })).count;
    if (outcome === "sale") {
      const openLead = await prisma.lead.findFirst({ where: { contactId: event.contactId, status: { in: ["new", "contacted", "follow_up", "qualified"] } }, orderBy: { createdAt: "desc" } });
      // A sale closes a pending follow-up of that lead (the dialer must not call a customer who just bought).
      if (openLead?.status === "follow_up") {
        const cancelled = await prisma.task.updateMany({ where: { businessId: event.businessId, status: "open", type: "callback", OR: [{ leadId: openLead.id }, { contactId: event.contactId, leadId: null }], NOT: { callId } }, data: { status: "cancelled" } });
        if (cancelled.count) await prisma.listLead.updateMany({ where: { businessId: event.businessId, contactId: event.contactId, status: "callback" }, data: { status: "completed", nextAttemptAt: null, preferredUserId: null } });
      }
      const contact = await prisma.contact.findUnique({ where: { id: event.contactId }, select: { fullName: true } });
      const deal = await prisma.deal.create({ data: { businessId: event.businessId, contactId: event.contactId, leadId: openLead?.id, title: `מכירה טלפונית – ${contact?.fullName ?? ""}`.trim(), stage: "won", status: "won", ownerUserId: userId, closedAt: new Date(), notes: `נוצר אוטומטית מתוצאת שיחה ${callId}` } });
      if (openLead) await prisma.lead.update({ where: { id: openLead.id }, data: { status: "converted", statusDefId: statusDefId ?? null, dealId: deal.id, closedAt: new Date() } });
      await (await import("@/lib/crm/customer-identity")).markPurchase(prisma, { businessId: event.businessId, contactId: event.contactId, actorUserId: userId, via: "call_outcome_sale" });
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
    if (!(await isModuleEnabled(event.businessId, "whatsapp"))) return { skipped: "whatsapp module not in the package" };
    const { sendBlockReason } = await import("@/lib/suppression");
    const template = await prisma.template.findUnique({ where: { id: cfg.templateId } });
    if (!template || template.status !== "APPROVED") return { skipped: "template not approved" };
    const category = template.category === "MARKETING" ? "marketing" : "service";
    const blocked = await sendBlockReason(event.businessId, event.contactId, category, undefined, { automated: true });
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

/** A customer's WhatsApp reply about availability → the lead owner's dial queue (idempotent per message). */
const whatsappAvailability: EventHandler = {
  name: "dialer.whatsapp-availability",
  types: ["message.received"],
  async run(event) {
    const { messageId } = payload<{ messageId?: string }>(event);
    if (!messageId) return { skipped: "no message" };
    const { handleInboundAvailability } = await import("@/lib/dialer/availability");
    return await handleInboundAvailability(event.businessId, messageId);
  },
};

/** "No leads available" for an agent in a campaign → managers who may see the agent (deduped per emptying). */
const dialerQueueEmpty: EventHandler = {
  name: "dialer.queue-empty-alert",
  types: ["dialer.queue_empty"],
  async run(event) {
    const { notifyQueueEmpty } = await import("@/lib/dialer/exhaustion");
    return await notifyQueueEmpty(event.businessId, payload<{ alertId: string }>(event).alertId);
  },
};

/** Customer-service AI (off by default; per channel, hours and limits; skips conversations handled by a human). */
const aiService: EventHandler = {
  name: "ai.service-agent",
  types: ["message.received"],
  async run(event) {
    const { handleServiceInbound } = await import("@/server/ai/service-agent");
    return await handleServiceInbound(event.businessId, payload<{ messageId?: string; conversationId?: string; channel?: string }>(event));
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
  types: ["message.delivery_failed", "message.sent", "contact.tag_added", "contact.created", "lead.status_changed", "cart.abandoned", "call.outcome_saved"],
  async run(event) {
    const { isModuleEnabled } = await import("@/lib/modules");
    if (!(await isModuleEnabled(event.businessId, "whatsapp")) && !(await isModuleEnabled(event.businessId, "sms")) && !(await isModuleEnabled(event.businessId, "email"))) return { skipped: "no messaging module in the package" };
    const { startSequencesForEvent } = await import("@/server/services/sequence-service");
    return await startSequencesForEvent(event);
  },
};

/** Real-time sales coach: extract reviewable examples after a call, label them when the deal closes. Never blocks the call. */
const coachLearning: EventHandler = {
  name: "coach.learning",
  types: ["call.ended", "deal.won", "deal.lost", "deal.reopened"],
  async run(event) {
    const { learnFromCall, attachDealOutcome } = await import("@/server/coach/learning");
    if (event.type === "call.ended") {
      const { callId } = payload<{ callId?: string }>(event);
      if (!callId) return { skipped: "no callId" };
      return (await learnFromCall(callId)) ?? {};
    }
    const { dealId } = payload<{ dealId?: string }>(event);
    if (!dealId) return { skipped: "no dealId" };
    // Sales coach: a closed deal queues its own recordings; a deal that leaves "won" sends what it taught back to review.
    const sales = await import("@/server/coach/sales");
    if (event.type === "deal.won") return { examples: await attachDealOutcome(dealId, "won"), sales: await sales.learnFromClosedDeal(event.businessId, dealId) };
    const changed = await sales.dealOutcomeChanged(event.businessId, dealId, event.type === "deal.lost" ? "העסקה סומנה כלא נסגרה / בוטלה" : "העסקה נפתחה מחדש");
    return event.type === "deal.lost" ? { examples: await attachDealOutcome(dealId, "lost"), sales: changed } : { sales: changed };
  },
};

/** AI documentation of the answered call (summary + timeline), stored on the call's coach session. */
const callDocumentation: EventHandler = {
  name: "call.documentation",
  types: ["call.ended"],
  async run(event) {
    const { callId } = payload<{ callId?: string }>(event);
    if (!callId) return { skipped: "no callId" };
    const { documentCall } = await import("@/server/coach/documentation");
    return documentCall(callId);
  },
};

/** Outgoing webhooks (Make / Zapier …): queue one signed delivery per subscribed endpoint. */
const webhooks: EventHandler = {
  name: "webhooks",
  types: ["lead.created", "lead.status_changed", "deal.created", "deal.won", "deal.lost", "call.outcome_saved", "call.summary_ready", "message.received", "contact.created", "contact.suppressed", "cart.abandoned", "task.created"],
  run: async (event) => { const { enqueueWebhookDeliveries } = await import("@/server/services/integrations"); return enqueueWebhookDeliveries(event); },
};

/** "עלה לקו" / "ירד מהקו" → WhatsApp to users who asked for it (src/server/assistant/subscriptions.ts). */
const agentPresence: EventHandler = {
  name: "assistant.agent-presence",
  types: ["agent.online", "agent.offline"],
  async run(event) {
    const p = payload<{ userId: string; sessionId: string; listId?: string | null; mode?: string; reason?: string }>(event);
    if (!p.userId || !p.sessionId) return { skipped: "no session" };
    const { deliverPresence } = await import("@/server/assistant/subscriptions");
    return deliverPresence(event.businessId, event.type === "agent.online" ? "agent_online" : "agent_offline", p, event.occurredAt);
  },
};

/** External CRM write-back: queue call activity / late AI summary / follow-up / status / block for linked records. */
const crmWriteback: EventHandler = {
  name: "crm.writeback",
  types: ["call.outcome_saved", "call.summary_ready", "task.created", "contact.suppressed", "lead.status_changed"],
  async run(event) { return (await import("@/server/crm-sync/outbox")).enqueueCrmWriteback(event); },
};

export const HANDLERS: EventHandler[] = [agentPresence, coachLearning, callDocumentation, leadCreated, callEnded, outcomeFollowUp, outcomeFollowUpMessage, messageReceived, aiService, whatsappAvailability, dialerQueueEmpty, suppressed, taskCreated, sequences, webhooks, crmWriteback];
