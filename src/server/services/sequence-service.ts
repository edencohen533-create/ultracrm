/**
 * Cross-channel marketing sequences.
 *  • Triggered by domain events (message.delivery_failed / message.sent / contact.tag_added).
 *  • One run per (sequence, contact, source) – duplicate events never start a second run.
 *  • Before EVERY step: consent + global suppression + frequency cap + stop conditions
 *    (reply since start, conversion, unsubscribe) are re-evaluated; failing → STOPPED.
 *  • Steps send through the same idempotent send paths (requestKey `seq:{run}:{step}`).
 *  • "email not opened" is deliberately not a trigger: opens are unreliable signals.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/response";
import { sendBlockReason } from "@/lib/suppression";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import type { SessionUser } from "@/lib/auth";
import type { DomainEvent, Prisma, SequenceRun } from "@/generated/prisma/client";
import { MAX_AUTOMATION_DEPTH } from "@/lib/events";

export const sequenceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().default(true),
  trigger: z.enum(["DELIVERY_FAILED", "SENT_NO_REPLY", "TAG_ADDED", "CONTACT_CREATED", "LEAD_STATUS_CHANGED"]),
  triggerConfig: z.object({ channel: z.enum(["whatsapp", "sms", "email"]).optional(), tagName: z.string().trim().max(40).optional(), campaignId: z.string().optional(), marketingOnly: z.boolean().default(true), leadStatus: z.enum(["new", "contacted", "qualified", "unqualified", "converted"]).optional(), contactSource: z.string().trim().max(100).optional() }).default({ marketingOnly: true }),
  stopOn: z.array(z.enum(["reply", "conversion", "unsubscribe"])).default(["reply", "conversion", "unsubscribe"]),
  steps: z.array(z.object({
    action: z.enum(["send", "task"]).default("send"),
    channel: z.enum(["whatsapp", "sms", "email"]),
    templateId: z.string().min(1).optional(),
    waitMinutes: z.number().int().min(0).max(43200),
    variables: z.record(z.string(), z.string().max(1024)).default({}),
    /** Branching by reply / customer data: every listed condition must hold or the step is skipped. */
    condition: z.object({ requireNoReply: z.boolean().default(true), tagName: z.string().trim().max(40).optional(), notTagName: z.string().trim().max(40).optional(), leadStatus: z.enum(["new", "contacted", "qualified", "unqualified", "converted", "none"]).optional(), customKey: z.string().trim().max(100).optional(), customValue: z.string().max(200).optional(), consent: z.enum(["OPTED_IN"]).optional() }).default({ requireNoReply: true }),
    /** task steps: title and due offset for the contact owner / creator. */
    taskTitle: z.string().trim().max(200).optional(),
    taskDueHours: z.number().int().min(1).max(720).optional(),
  }).refine((s) => s.action === "task" ? Boolean(s.taskTitle) : Boolean(s.templateId), "שלב שליחה דורש תבנית; שלב משימה דורש כותרת")).min(1).max(6),
}).superRefine((s, ctx) => {
  if (s.trigger === "SENT_NO_REPLY" && s.steps[0].waitMinutes < 30) ctx.addIssue({ code: "custom", path: ["steps", 0, "waitMinutes"], message: "המתנה של לפחות 30 דקות לפני מעקב אחרי שליחה" });
  if (s.trigger === "TAG_ADDED" && !s.triggerConfig.tagName) ctx.addIssue({ code: "custom", path: ["triggerConfig"], message: "יש לבחור תגית" });
});
export type SequenceInput = z.infer<typeof sequenceSchema>;

export async function listSequences() {
  return prisma.marketingSequence.findMany({ orderBy: { createdAt: "desc" }, include: { steps: { orderBy: { position: "asc" }, include: { template: { select: { id: true, name: true, channel: true, category: true } } } }, _count: { select: { runs: true } } } });
}

export async function saveSequence(user: SessionUser, input: SequenceInput, id?: string) {
  const templates = await prisma.template.findMany({ where: { id: { in: input.steps.flatMap((s) => (s.templateId ? [s.templateId] : [])) } }, select: { id: true, channel: true, status: true } });
  for (const [i, step] of input.steps.entries()) {
    if (step.action === "task") continue;
    const t = templates.find((x) => x.id === step.templateId);
    if (!t || t.channel !== step.channel || t.status !== "APPROVED") throw new ApiError(`שלב ${i + 1}: התבנית אינה מאושרת לערוץ ${step.channel}`, 400, "template_invalid");
  }
  const stopOn = [...new Set([...input.stopOn, "unsubscribe"])];
  const data = { name: input.name, isActive: input.isActive, trigger: input.trigger, triggerConfig: input.triggerConfig as Prisma.InputJsonValue, stopOn };
  const row = await prisma.$transaction(async (tx) => {
    const seq = id
      ? await tx.marketingSequence.update({ where: { id }, data })
      : await tx.marketingSequence.create({ data: { ...data, businessId: user.businessId, createdById: user.id } });
    await tx.sequenceStep.deleteMany({ where: { sequenceId: seq.id } });
    // Task steps have no template; the relation is required, so they reference a placeholder-free path via a nullable-like sentinel: we store the first template of the sequence when present, otherwise refuse.
    for (const s of input.steps) if (s.action === "task" && !s.templateId) { const any = templates[0]?.id ?? (await tx.template.findFirst({ select: { id: true } }))?.id; if (!any) throw new ApiError("שלב משימה דורש שתהיה לפחות תבנית אחת במערכת (שדה טכני)", 400, "template_required"); s.templateId = any; }
    await tx.sequenceStep.createMany({ data: input.steps.map((s, position) => ({ sequenceId: seq.id, position, action: s.action, channel: s.channel, templateId: s.templateId!, waitMinutes: s.waitMinutes, variables: { ...s.variables, ...(s.taskTitle ? { __taskTitle: s.taskTitle, __taskDueHours: String(s.taskDueHours ?? 24) } : {}) } as Prisma.InputJsonValue, condition: s.condition as Prisma.InputJsonValue })) });
    return seq;
  });
  await audit(user.businessId, user.id, "sequence", row.id, id ? "sequence.updated" : "sequence.created", { trigger: input.trigger, steps: input.steps.length });
  return row;
}

export async function deleteSequence(user: SessionUser, id: string) {
  const r = await prisma.marketingSequence.deleteMany({ where: { id } });
  if (!r.count) throw new ApiError("הרצף לא נמצא", 404, "not_found");
  await audit(user.businessId, user.id, "sequence", id, "sequence.deleted");
}

/** Start runs for an event. Called by the domain-event handler; idempotent per (sequence, contact, source). */
export async function startSequencesForEvent(event: DomainEvent) {
  if (!event.contactId) return { started: 0 };
  if (event.depth >= MAX_AUTOMATION_DEPTH) return { started: 0, skipped: "automation depth" };
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const trigger = event.type === "message.delivery_failed" ? "DELIVERY_FAILED" : event.type === "message.sent" ? "SENT_NO_REPLY" : event.type === "contact.tag_added" ? "TAG_ADDED" : event.type === "contact.created" ? "CONTACT_CREATED" : event.type === "lead.status_changed" ? "LEAD_STATUS_CHANGED" : null;
  if (!trigger) return { started: 0 };
  const sequences = await prisma.marketingSequence.findMany({ where: { businessId: event.businessId, trigger, isActive: true }, include: { steps: { orderBy: { position: "asc" } } } });
  if (!sequences.length) return { started: 0 };
  // Messages sent BY a sequence step (requestKey `seq:…`) never start another sequence – no self-chaining loops.
  if (typeof p.messageId === "string") {
    const source = await prisma.message.findUnique({ where: { id: p.messageId }, select: { requestKey: true } });
    if (source?.requestKey?.startsWith("seq:")) return { started: 0, skipped: "sequence-originated message" };
  }
  if (typeof p.sequenceRunId === "string") return { started: 0, skipped: "sequence-originated message" };
  let started = 0;
  for (const seq of sequences) {
    const cfg = (seq.triggerConfig ?? {}) as { channel?: string; tagName?: string; campaignId?: string; marketingOnly?: boolean; leadStatus?: string; contactSource?: string };
    if (trigger === "DELIVERY_FAILED" || trigger === "SENT_NO_REPLY") {
      if (cfg.channel && p.channel !== cfg.channel) continue;
      if (cfg.campaignId && p.campaignId !== cfg.campaignId) continue;
      if (cfg.marketingOnly !== false && p.category !== "marketing") continue;
    } else if (trigger === "TAG_ADDED") { if (cfg.tagName && p.tagName !== cfg.tagName) continue; }
    else if (trigger === "LEAD_STATUS_CHANGED") { if (cfg.leadStatus && p.to !== cfg.leadStatus) continue; }
    else if (trigger === "CONTACT_CREATED") { if (cfg.contactSource && p.source !== cfg.contactSource) continue; }
    if (!seq.steps.length) continue;
    const sourceKey = typeof p.messageId === "string" ? `message:${p.messageId}` : `event:${event.id}`;
    try {
      await prisma.sequenceRun.create({ data: { businessId: event.businessId, sequenceId: seq.id, contactId: event.contactId, sourceKey, nextAt: new Date(Date.now() + seq.steps[0].waitMinutes * 60_000), log: [] } });
      started++;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // duplicate event → run already exists
      throw err;
    }
  }
  return { started };
}

async function stepSkipReason(run: SequenceRun, cond: { requireNoReply?: boolean; tagName?: string; notTagName?: string; leadStatus?: string; customKey?: string; customValue?: string; consent?: string }) {
  if (cond.requireNoReply !== false && await prisma.message.findFirst({ where: { direction: "INBOUND", createdAt: { gt: run.startedAt }, conversation: { contactId: run.contactId } }, select: { id: true } })) return "reply received";
  if (cond.tagName || cond.notTagName || cond.leadStatus || cond.customKey || cond.consent) {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: run.contactId }, select: { consentStatus: true, customFields: true, tags: { select: { tag: { select: { name: true } } } }, leads: { select: { status: true }, orderBy: { createdAt: "desc" }, take: 1 } } });
    const tags = c.tags.map((t) => t.tag.name);
    if (cond.tagName && !tags.includes(cond.tagName)) return `condition: tag ${cond.tagName} missing`;
    if (cond.notTagName && tags.includes(cond.notTagName)) return `condition: tag ${cond.notTagName} present`;
    if (cond.leadStatus) { const st = c.leads[0]?.status ?? "none"; if (st !== cond.leadStatus) return `condition: lead status ${st}`; }
    if (cond.customKey) { const v = (c.customFields as Record<string, unknown> | null)?.[cond.customKey]; if (String(v ?? "") !== String(cond.customValue ?? "")) return `condition: ${cond.customKey}`; }
    if (cond.consent === "OPTED_IN" && c.consentStatus !== "OPTED_IN") return "condition: consent";
  }
  return null;
}

async function stopCondition(run: SequenceRun, stopOn: string[]) {
  if (stopOn.includes("reply")) {
    const reply = await prisma.message.findFirst({ where: { direction: "INBOUND", createdAt: { gt: run.startedAt }, conversation: { contactId: run.contactId } }, select: { id: true } });
    if (reply) return "reply";
  }
  if (stopOn.includes("conversion")) {
    const won = await prisma.deal.findFirst({ where: { contactId: run.contactId, status: "won", closedAt: { gt: run.startedAt } }, select: { id: true } });
    if (won) return "conversion";
  }
  return null;
}

/** Worker: process due runs (called from the automations cron inside the business scope). */
export async function processDueSequenceRuns(deadline = Date.now() + 40_000, businessId?: string) {
  const bid = businessId ?? (await import("@/lib/tenant")).requireBusinessId();
  const settings = await getBusinessSettings(bid);
  if (!isWithinDialWindow({ ...settings.marketing.window, timezone: settings.marketing.window.timezone ?? settings.timezone })) return { processed: 0, skipped: "outside marketing window" };
  // A worker killed mid-step leaves RUNNING + lockedAt; steps are idempotent (seq:{run}:{step}) so reclaiming is safe.
  await prisma.sequenceRun.updateMany({ where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: "PENDING", lockedAt: null } });
  const due = await prisma.sequenceRun.findMany({ where: { status: "PENDING", nextAt: { lte: new Date() } }, orderBy: { nextAt: "asc" }, take: 25 });
  let processed = 0;
  for (const run of due) {
    if (Date.now() >= deadline) break;
    const claimed = await prisma.sequenceRun.updateMany({ where: { id: run.id, status: "PENDING" }, data: { status: "RUNNING", lockedAt: new Date() } });
    if (!claimed.count) continue;
    processed++;
    const log = Array.isArray(run.log) ? (run.log as Prisma.JsonArray) : [];
    const finish = (status: "COMPLETED" | "STOPPED" | "FAILED" | "PENDING", extra: Partial<Prisma.SequenceRunUncheckedUpdateInput> = {}) =>
      prisma.sequenceRun.update({ where: { id: run.id }, data: { status, ...(status !== "PENDING" ? { completedAt: new Date() } : {}), ...extra } });
    try {
      const seq = await prisma.marketingSequence.findUnique({ where: { id: run.sequenceId }, include: { steps: { orderBy: { position: "asc" } } } });
      if (!seq || !seq.isActive) { await finish("STOPPED", { stopReason: "sequence inactive" }); continue; }
      const step = seq.steps[run.stepIndex];
      if (!step) { await finish("COMPLETED"); continue; }
      const stop = await stopCondition(run, seq.stopOn);
      if (stop) { await finish("STOPPED", { stopReason: stop }); continue; }
      // Send steps re-check global suppression/consent before every send; task steps only create CRM work and never message the contact.
      const blocked = step.action === "task" ? null : await sendBlockReason(bid, run.contactId, "marketing");
      if (blocked) { await finish("STOPPED", { stopReason: `unsubscribe: ${blocked}` }); continue; }
      // Per-step conditions (branching): reply / tags / lead status / custom field – skip this step, not the run.
      const cond = (step.condition ?? {}) as { requireNoReply?: boolean; tagName?: string; notTagName?: string; leadStatus?: string; customKey?: string; customValue?: string };
      const skipReason = await stepSkipReason(run, cond);
      if (skipReason) {
        const entry = { step: step.position, channel: step.channel, messageId: null, skipped: skipReason, at: new Date().toISOString() };
        const next = seq.steps[run.stepIndex + 1];
        if (!next) { await finish("COMPLETED", { log: [...log, entry] as Prisma.InputJsonValue }); continue; }
        await finish("PENDING", { stepIndex: run.stepIndex + 1, nextAt: new Date(Date.now() + next.waitMinutes * 60_000), lockedAt: null, log: [...log, entry] as Prisma.InputJsonValue });
        continue;
      }
      const requestKey = `seq:${run.id}:${step.position}`;
      let messageId: string | null = null;
      let skipped: string | null = null;
      let deferUntil: Date | null = null; // frequency cap / provider outage: try the same step later instead of losing it
      if (step.action === "task") {
        const vars = (step.variables ?? {}) as Record<string, string>;
        const contact = await prisma.contact.findUniqueOrThrow({ where: { id: run.contactId }, select: { ownerUserId: true, fullName: true } });
        const userId = contact.ownerUserId ?? seq.createdById;
        if (!userId) skipped = "אין אחראי/יוצר להקצות לו משימה";
        else {
          const task = await prisma.task.upsert({ where: { businessId_requestKey: { businessId: bid, requestKey } }, create: { businessId: bid, userId, createdById: null, contactId: run.contactId, type: "follow_up", title: `${vars.__taskTitle ?? "מעקב"} – ${contact.fullName}`, dueAt: new Date(Date.now() + Number(vars.__taskDueHours ?? 24) * 3600_000), note: `רצף: ${seq.name}`, requestKey }, update: {} });
          messageId = null; void task;
        }
      } else if (step.channel === "whatsapp") {
        const { resolveSender, ProviderUnavailableError } = await import("@/server/providers/provider-registry");
        const { startConversationForAutomation } = await import("@/server/services/conversation-service");
        const { createOutboundMessage, MessagePolicyError, FrequencyCapError } = await import("@/server/services/message-service");
        const { personalizeVariables } = await import("@/lib/campaigns");
        try {
          const sender = await resolveSender(undefined);
          if (!sender) skipped = "אין ערוץ WhatsApp מחובר";
          else {
            const contact = await prisma.contact.findUniqueOrThrow({ where: { id: run.contactId }, select: { fullName: true } });
            const conversation = await startConversationForAutomation(run.contactId, sender.id, seq.createdById ?? "");
            const { message } = await createOutboundMessage({ conversationId: conversation.id, body: "", templateId: step.templateId, templateVariables: personalizeVariables((step.variables as Record<string, string>) ?? {}, contact.fullName), sentByUserId: seq.createdById ?? "", automated: true, requireOptIn: true, requestKey, eventDepth: 1 });
            if (!["ACCEPTED", "SENT", "DELIVERED", "READ"].includes(message.status)) throw new Error(message.errorReason ?? "הספק לא אישר את השליחה");
            messageId = message.id;
          }
        } catch (err) {
          if (err instanceof FrequencyCapError) deferUntil = new Date(Date.now() + 60 * 60_000);
          else if (err instanceof ProviderUnavailableError) deferUntil = new Date(Date.now() + 15 * 60_000);
          else if (err instanceof MessagePolicyError) skipped = err.message;
          else throw err;
        }
      } else {
        const { sendChannelMessage } = await import("@/server/services/channel-send-service");
        const { MessagePolicyError, FrequencyCapError } = await import("@/server/services/message-service");
        const { ChannelUnavailableError } = await import("@/server/channels/registry");
        try {
          const { message } = await sendChannelMessage({ channel: step.channel, contactId: run.contactId, templateId: step.templateId, variables: (step.variables as Record<string, string>) ?? {}, category: "marketing", requestKey, sentByUserId: seq.createdById, automated: true, eventDepth: 1, sequenceRunId: run.id });
          if (!["ACCEPTED", "SENT", "DELIVERED", "READ"].includes(message.status)) throw new Error(message.errorReason ?? "הספק לא אישר את השליחה");
          messageId = message.id;
        } catch (err) {
          if (err instanceof FrequencyCapError) deferUntil = new Date(Date.now() + 60 * 60_000);
          else if (err instanceof MessagePolicyError) skipped = err.message;
          else if (err instanceof ChannelUnavailableError) deferUntil = new Date(Date.now() + 15 * 60_000);
          else throw err;
        }
      }
      if (deferUntil) { await finish("PENDING", { nextAt: deferUntil, lockedAt: null }); continue; }
      const entry = { step: step.position, channel: step.channel, messageId, skipped, at: new Date().toISOString() };
      const nextStep = seq.steps[run.stepIndex + 1];
      await audit(bid, null, "sequence", seq.id, "sequence.step", { runId: run.id, contactId: run.contactId, ...entry });
      if (skipped && /הוסר|חסום|הסכמה|ממתינה/.test(skipped)) { await finish("STOPPED", { stopReason: skipped, log: [...log, entry] as Prisma.InputJsonValue }); continue; }
      if (!nextStep) { await finish("COMPLETED", { log: [...log, entry] as Prisma.InputJsonValue }); continue; }
      await finish("PENDING", { stepIndex: run.stepIndex + 1, nextAt: new Date(Date.now() + nextStep.waitMinutes * 60_000), lockedAt: null, log: [...log, entry] as Prisma.InputJsonValue });
    } catch (err) {
      await finish("FAILED", { stopReason: (err as Error).message.slice(0, 300) });
    }
  }
  return { processed };
}
