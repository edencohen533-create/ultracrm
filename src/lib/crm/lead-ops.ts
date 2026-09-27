/**
 * CRM lead operations that touch the dialer:
 *  • dial attempts per lead (derived from the call log – one Call row per real attempt),
 *  • follow-ups (status "follow_up" + one open callback task that holds the time) and their dial-queue sync,
 *  • manager transfer of leads (immediate, or deferred until a live call on the lead is finished),
 *  • the manager's "waiting for a call today" snapshot.
 *
 * Every function takes the business from the session / explicit businessId and filters every raw query by it
 * (RLS applies underneath as defence in depth).
 */
import crypto from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings, isWithinDialWindow, nextDialWindowOpening } from "@/lib/settings";
import { businessDayStart, zonedDateTime, zonedParts } from "@/lib/business-day";
import { ownerScope } from "./access";
import { OPEN_LEAD_STATUSES } from "./labels";

type Db = Prisma.TransactionClient;
const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);
const QS = () => Prisma.raw(`"${dbSchema()}"."QueueLeadStatus"`);
const OPEN = Prisma.join(OPEN_LEAD_STATUSES.map((s) => Prisma.sql`${s}`));
const CLOSED = ["unqualified", "converted", "lost"];

// ─── Dial attempts ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A dial attempt = an outbound call whose lead leg was actually dialed (lead_dialed_at). One Call row per attempt
 * (unique idempotency key); provider webhooks only update that row, so repeated provider events never add attempts.
 * A click that failed before the lead was dialed (agent leg failed, DNC, lock lost…) is not an attempt.
 * Each call is attributed to the contact's lead that was current when the call was placed (latest lead created
 * before it; calls older than every lead go to the first lead) – this also backfills leads created before this feature.
 * Attempts live on the lead/contact, never on the agent, so a transfer keeps the full history.
 */
const ATTEMPT_LEAD = Prisma.sql`JOIN LATERAL (
    SELECT l2.id AS lead_id FROM ${T("leads")} l2
    WHERE l2.business_id = cl.business_id AND l2.contact_id = cl.contact_id
    ORDER BY (l2.created_at <= cl.created_at) DESC, CASE WHEN l2.created_at <= cl.created_at THEN l2.created_at END DESC NULLS LAST, l2.created_at ASC
    LIMIT 1
  ) x ON true`;
const IS_ATTEMPT = Prisma.sql`cl.direction = 'outbound' AND cl.lead_dialed_at IS NOT NULL`;

export async function attemptStats(businessId: string, contactIds: string[], db: Db = prisma) {
  const out = new Map<string, { count: number; lastAt: Date | null }>();
  if (!contactIds.length) return out;
  const rows = await db.$queryRaw<Array<{ leadId: string; n: number; lastAt: Date | null }>>(Prisma.sql`
    SELECT x.lead_id AS "leadId", count(*)::int AS n, max(cl.created_at) AS "lastAt"
    FROM ${T("calls")} cl ${ATTEMPT_LEAD}
    WHERE cl.business_id = ${businessId} AND ${IS_ATTEMPT} AND cl.contact_id = ANY(${[...new Set(contactIds)]})
    GROUP BY x.lead_id`);
  for (const r of rows) out.set(r.leadId, { count: r.n, lastAt: r.lastAt });
  return out;
}

/** Attempt history of one lead (visible to whoever may see the lead – history follows the lead on transfer). */
export async function attemptHistory(user: SessionUser, leadId: string) {
  const lead = await leadForUser(user, leadId);
  return prisma.$queryRaw<Array<{ id: string; at: Date; agent: string; mode: string; result: string | null; outcome: string | null; answered: boolean; talkSeconds: number | null; note: string | null }>>(Prisma.sql`
    SELECT cl.id, cl.created_at AS at, u.full_name AS agent, cl.mode::text AS mode, cl.telephony_result::text AS result, cl.outcome::text AS outcome,
           (cl.answered_at IS NOT NULL) AS answered, cl.talk_seconds AS "talkSeconds", cl.outcome_note AS note
    FROM ${T("calls")} cl ${ATTEMPT_LEAD} JOIN ${T("users")} u ON u.id = cl.user_id
    WHERE cl.business_id = ${user.businessId} AND ${IS_ATTEMPT} AND cl.contact_id = ${lead.contactId} AND x.lead_id = ${lead.id}
    ORDER BY cl.created_at DESC LIMIT 200`);
}

// ─── Access ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The lead if this user may see it (owner scope enforced on the server: direct links / API included). */
export async function leadForUser(user: SessionUser, leadId: string) {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId: user.businessId, ...ownerScope(ids) } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  return lead;
}

/**
 * May this user open this contact? Owner: always. Others: they own the contact or one of its leads, or the contact
 * is in the shared pool and none of its open leads belongs to someone they cannot see. So an agent whose lead was
 * transferred away loses the contact card (calls, notes, chat) too – not only the lead.
 */
export async function canAccessContact(user: SessionUser, contact: { id: string; ownerUserId: string | null }) {
  const ids = await visibleUserIds(user);
  if (!ids) return true;
  if (contact.ownerUserId && ids.includes(contact.ownerUserId)) return true;
  const leads = await prisma.lead.findMany({ where: { businessId: user.businessId, contactId: contact.id }, select: { ownerUserId: true, status: true } });
  if (leads.some((l) => l.ownerUserId && ids.includes(l.ownerUserId))) return true;
  if (contact.ownerUserId) return false;
  return !leads.some((l) => l.ownerUserId && !CLOSED.includes(l.status));
}

/** Does this user own the contact or one of its leads (→ sees its whole history, including calls by earlier agents)? */
export async function ownsContactHistory(user: SessionUser, contact: { id: string; ownerUserId: string | null }) {
  const ids = await visibleUserIds(user);
  if (!ids) return true;
  if (contact.ownerUserId && ids.includes(contact.ownerUserId)) return true;
  return Boolean(await prisma.lead.findFirst({ where: { businessId: user.businessId, contactId: contact.id, ownerUserId: { in: ids } }, select: { id: true } }));
}

// ─── Follow-ups ────────────────────────────────────────────────────────────────────────────────────────────────
export const followUpSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  note: z.string().trim().max(1000).optional(),
});

/** Open follow-up (callback task) per lead: a task linked to the lead, or an unlinked callback task of its contact. */
export async function followUpsFor(businessId: string, leads: Array<{ id: string; contactId: string }>, db: Db = prisma) {
  const out = new Map<string, { taskId: string; dueAt: Date; note: string | null; userId: string }>();
  if (!leads.length) return out;
  const tasks = await db.task.findMany({ where: { businessId, status: "open", type: "callback", contactId: { in: [...new Set(leads.map((l) => l.contactId))] } }, orderBy: { dueAt: "asc" }, select: { id: true, leadId: true, contactId: true, dueAt: true, note: true, userId: true } });
  for (const l of leads) {
    const t = tasks.find((x) => x.leadId === l.id) ?? tasks.find((x) => x.contactId === l.contactId && !x.leadId);
    if (t) out.set(l.id, { taskId: t.id, dueAt: t.dueAt, note: t.note, userId: t.userId });
  }
  return out;
}

/** The dynamic "הלידים של <agent>" list (created when the agent first starts the dialer from the CRM). */
export async function personalListId(db: Db, businessId: string, userId: string) {
  return (await db.dialList.findFirst({ where: { businessId, isDynamic: true, filterJson: { path: ["leadOwnerUserId"], equals: userId } }, select: { id: true } }))?.id ?? null;
}

/**
 * Put due-dated follow-ups into the dial queue. The follow-up time becomes the queue row's earliest dial time
 * (never before it); the row is marked "callback" for the assignee so the agent's priority setting can order it.
 * Rows that are locked / in a call / DNC are never touched. Filter by contact (one lead changed) or by user (dialer start).
 */
export async function syncFollowUpQueue(db: Db, businessId: string, filter: { contactId?: string; userId?: string }) {
  const tasks = await db.task.findMany({
    where: { businessId, status: "open", type: "callback", ...(filter.contactId ? { contactId: filter.contactId } : {}), ...(filter.userId ? { userId: filter.userId } : {}) },
    orderBy: { dueAt: "asc" }, select: { contactId: true, userId: true, dueAt: true },
  });
  const first = new Map<string, { userId: string; dueAt: Date }>();
  for (const t of tasks) if (!first.has(t.contactId)) first.set(t.contactId, { userId: t.userId, dueAt: t.dueAt });
  const lists = new Map<string, string | null>();
  for (const [contactId, f] of first) {
    if (!lists.has(f.userId)) lists.set(f.userId, await personalListId(db, businessId, f.userId));
    const personal = lists.get(f.userId);
    if (personal) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO ${T("list_leads")} (id, business_id, list_id, contact_id, status, priority, attempts, follow_up_attempts, next_attempt_at, preferred_user_id, created_at, updated_at)
        SELECT ${"fu" + crypto.randomUUID().replaceAll("-", "")}, ${businessId}, ${personal}, ${contactId}, 'callback'::${QS()}, 0, 0, 0, ${f.dueAt}, ${f.userId}, timezone('UTC', now()), timezone('UTC', now())
        WHERE NOT EXISTS (SELECT 1 FROM ${T("dnc_entries")} d JOIN ${T("contacts")} c ON c.phone_e164 = d.phone_e164 AND c.business_id = d.business_id WHERE c.id = ${contactId})
        ON CONFLICT (list_id, contact_id) DO UPDATE SET status = 'callback'::${QS()}, next_attempt_at = EXCLUDED.next_attempt_at, preferred_user_id = EXCLUDED.preferred_user_id,
          follow_up_attempts = COALESCE(${T("list_leads")}.follow_up_attempts, 0), updated_at = timezone('UTC', now())
        WHERE ${T("list_leads")}.status NOT IN ('locked'::${QS()}, 'in_call'::${QS()}, 'dnc'::${QS()})`);
    }
    // Other lists that hold this contact: never dial before the follow-up time, and prefer the assignee.
    await db.listLead.updateMany({ where: { businessId, contactId, status: { in: ["pending", "callback"] }, ...(personal ? { NOT: { listId: personal } } : {}) }, data: { status: "callback", nextAttemptAt: f.dueAt, preferredUserId: f.userId, followUpAttempts: 0 } });
  }
  return first.size;
}

async function assertFollowUpTime(businessId: string, date: string, time: string) {
  const settings = await getBusinessSettings(businessId);
  const tz = settings.timezone;
  const dueAt = zonedDateTime(tz, date, time);
  if (!dueAt) throw new ApiError("מועד לא תקין", 400, "invalid_time");
  if (dueAt.getTime() < Date.now() - 60_000) throw new ApiError("מועד הפולואפ חייב להיות בעתיד", 400, "follow_up_in_past");
  const window = { ...settings.dialWindow, timezone: settings.dialWindow.timezone ?? tz };
  if (!isWithinDialWindow(window, dueAt)) {
    const next = nextDialWindowOpening(window, dueAt);
    throw new ApiError(`המועד שנבחר מחוץ לשעות החיוג המותרות (${window.start}–${window.end}). החייגן לא יחייג בשעה הזו.`, 409, "outside_dial_window", { suggestion: next ? { at: next.toISOString(), ...zonedParts(tz, next) } : null, window: { start: window.start, end: window.end, days: window.days } });
  }
  return { dueAt, tz };
}

/** Set or move the follow-up of a lead (time is mandatory). Moving it cancels the previous schedule first. */
export async function scheduleFollowUp(user: SessionUser, leadId: string, input: z.infer<typeof followUpSchema>) {
  const lead = await leadForUser(user, leadId);
  if (CLOSED.includes(lead.status)) throw new ApiError("לא ניתן לקבוע פולואפ לליד סגור", 409, "lead_closed");
  if (lead.pendingTransferToUserId) throw new ApiError("הליד ממתין להעברה לנציג אחר – קבע את הפולואפ אחרי ההעברה", 409, "transfer_pending");
  const { dueAt } = await assertFollowUpTime(user.businessId, input.date, input.time);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + lead.id}, 0))`);
    const previous = await tx.task.findMany({ where: { businessId: user.businessId, status: "open", type: "callback", OR: [{ leadId: lead.id }, { contactId: lead.contactId, leadId: null }] }, select: { id: true, dueAt: true } });
    if (previous.length) await tx.task.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: "cancelled", note: undefined } });
    const task = await tx.task.create({ data: { businessId: user.businessId, userId: lead.ownerUserId ?? user.id, createdById: user.id, contactId: lead.contactId, leadId: lead.id, type: "callback", title: "פולואפ", dueAt, note: input.note || null } });
    if (lead.status !== "follow_up") {
      await tx.lead.update({ where: { id: lead.id }, data: { status: "follow_up", closedAt: null } });
      await emitEvent(tx, { businessId: user.businessId, type: "lead.status_changed", contactId: lead.contactId, actorUserId: user.id, source: "user", dedupeKey: `lead.status_changed:${lead.id}:follow_up:${Date.now()}`, payload: { leadId: lead.id, from: lead.status, to: "follow_up" } });
    }
    // Moving the time: queue rows were pointing at the old time – reset them before re-syncing to the new one.
    if (previous.length) await tx.listLead.updateMany({ where: { businessId: user.businessId, contactId: lead.contactId, status: "callback" }, data: { nextAttemptAt: dueAt } });
    await syncFollowUpQueue(tx, user.businessId, { contactId: lead.contactId });
    await audit(user.businessId, user.id, "lead", lead.id, previous.length ? "lead.follow_up_rescheduled" : "lead.follow_up_scheduled", { dueAt: dueAt.toISOString(), previous: previous.map((p) => p.dueAt.toISOString()), taskId: task.id }, tx);
    return { taskId: task.id, dueAt };
  });
  kickEventProcessing(user.businessId);
  return result;
}

/** Cancel the follow-up: the task is cancelled, the lead goes back to "contacted" and leaves the callback queue. */
export async function cancelFollowUp(user: SessionUser, leadId: string) {
  const lead = await leadForUser(user, leadId);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + lead.id}, 0))`);
    const r = await tx.task.updateMany({ where: { businessId: user.businessId, status: "open", type: "callback", OR: [{ leadId: lead.id }, { contactId: lead.contactId, leadId: null }] }, data: { status: "cancelled" } });
    await tx.listLead.updateMany({ where: { businessId: user.businessId, contactId: lead.contactId, status: "callback" }, data: { status: "pending", nextAttemptAt: null, preferredUserId: null } });
    if (lead.status === "follow_up") await tx.lead.update({ where: { id: lead.id }, data: { status: "contacted" } });
    await audit(user.businessId, user.id, "lead", lead.id, "lead.follow_up_cancelled", { tasks: r.count }, tx);
  });
}

/**
 * After a dial attempt on a contact (outcome saved): record the result of the follow-up that was due, and make sure
 * it cannot loop. Callback → the new callback task (created by the outcome) replaces it. Retry outcome (no answer /
 * busy…) with a queue row still pending → the follow-up moves to the retry time of the existing retry policy.
 * Retries exhausted / manual call without a queue → the follow-up is closed and the lead shows "נדרש תזמון".
 * Answered → done, and a lead still in "follow_up" goes to "contacted".
 */
export async function afterFollowUpAttempt(tx: Db, input: { businessId: string; userId: string; callId: string; contactId: string; listLeadId: string | null; outcome: string; retry: boolean; callbackTaskCreated: boolean }) {
  const due = await tx.task.findMany({ where: { businessId: input.businessId, contactId: input.contactId, status: "open", type: "callback", dueAt: { lte: new Date(Date.now() + 60_000) }, OR: [{ callId: null }, { callId: { not: input.callId } }] }, select: { id: true, leadId: true, note: true } });
  const lead = await tx.lead.findFirst({ where: { businessId: input.businessId, contactId: input.contactId, status: { in: [...OPEN_LEAD_STATUSES] } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
  if (input.callbackTaskCreated && lead) await tx.task.updateMany({ where: { callId: input.callId, type: "callback", leadId: null }, data: { leadId: lead.id, title: "פולואפ" } });
  if (!due.length) {
    if (input.callbackTaskCreated && lead && lead.status !== "follow_up") await tx.lead.update({ where: { id: lead.id }, data: { status: "follow_up" } });
    return;
  }
  const row = input.listLeadId ? await tx.listLead.findUnique({ where: { id: input.listLeadId }, select: { status: true, nextAttemptAt: true } }) : null;
  const tag = (note: string | null) => `${note ? `${note}\n` : ""}תוצאת ניסיון: ${input.outcome}`;
  if (!input.callbackTaskCreated && input.retry && row?.status === "pending" && row.nextAttemptAt) {
    for (const t of due) await tx.task.update({ where: { id: t.id }, data: { dueAt: row.nextAttemptAt, note: tag(t.note) } });
    await tx.listLead.update({ where: { id: input.listLeadId! }, data: { status: "callback" } });
    await audit(input.businessId, input.userId, "lead", lead?.id ?? input.contactId, "lead.follow_up_retry", { outcome: input.outcome, next: row.nextAttemptAt.toISOString() }, tx);
    return;
  }
  for (const t of due) await tx.task.update({ where: { id: t.id }, data: { status: "done", doneAt: new Date(), note: tag(t.note) } });
  if (lead && !input.callbackTaskCreated && !input.retry && lead.status === "follow_up") await tx.lead.update({ where: { id: lead.id }, data: { status: "contacted" } });
  if (lead && input.callbackTaskCreated && lead.status !== "follow_up") await tx.lead.update({ where: { id: lead.id }, data: { status: "follow_up" } });
  await audit(input.businessId, input.userId, "lead", lead?.id ?? input.contactId, "lead.follow_up_result", { outcome: input.outcome, needsScheduling: Boolean(input.retry && !input.callbackTaskCreated) }, tx);
}

// ─── Transfer ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A live call or a dial attempt that already started on this contact (the old agent must finish + document it). */
async function activeCallOn(db: Db, businessId: string, contactId: string) {
  const call = await db.call.findFirst({ where: { businessId, contactId, OR: [{ endedAt: null }, { outcomeSavedAt: null, createdAt: { gte: new Date(Date.now() - 12 * 3600_000) } }] }, select: { id: true } });
  if (call) return true;
  return Boolean(await db.listLead.findFirst({ where: { businessId, contactId, status: "in_call" }, select: { id: true } }));
}

/** Move one lead now: owner, contact, open tasks (same times), queue rows; audited as who/from/to/when. */
async function applyTransfer(businessId: string, leadId: string, toUserId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + leadId}, 0))`);
    const lead = await tx.lead.findFirst({ where: { id: leadId, businessId }, include: { contact: { select: { id: true, ownerUserId: true } } } });
    if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
    const from = lead.ownerUserId;
    await tx.lead.update({ where: { id: lead.id }, data: { ownerUserId: toUserId, pendingTransferToUserId: null, pendingTransferById: null, pendingTransferAt: null } });
    if (!lead.contact.ownerUserId || lead.contact.ownerUserId === from) await tx.contact.update({ where: { id: lead.contactId }, data: { ownerUserId: toUserId } });
    const tasks = await tx.task.updateMany({ where: { businessId, status: "open", OR: [{ leadId: lead.id }, ...(from ? [{ contactId: lead.contactId, userId: from }] : []), { contactId: lead.contactId, leadId: null, type: "callback" }] }, data: { userId: toUserId } });
    // Queue: out of the previous agent's personal list and any lock they hold; other lists now prefer the new agent.
    if (from) {
      const fromList = await personalListId(tx, businessId, from);
      if (fromList) await tx.listLead.updateMany({ where: { listId: fromList, contactId: lead.contactId, status: { notIn: ["in_call"] } }, data: { status: "removed", lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null } });
      const held = await tx.listLead.findMany({ where: { businessId, contactId: lead.contactId, lockedByUserId: from, status: "locked" }, select: { id: true, lastOutcome: true, nextAttemptAt: true } });
      for (const h of held) await tx.listLead.update({ where: { id: h.id }, data: { status: h.lastOutcome === "callback" && h.nextAttemptAt ? "callback" : "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
    }
    await tx.listLead.updateMany({ where: { businessId, contactId: lead.contactId, status: { in: ["pending", "callback"] } }, data: { preferredUserId: toUserId } });
    const toList = await personalListId(tx, businessId, toUserId);
    if (toList) {
      await tx.listLead.createMany({ data: [{ businessId, listId: toList, contactId: lead.contactId }], skipDuplicates: true });
      await tx.listLead.updateMany({ where: { listId: toList, contactId: lead.contactId, status: { in: ["removed", "completed"] } }, data: { status: "pending", nextAttemptAt: null, preferredUserId: toUserId } });
    }
    await syncFollowUpQueue(tx, businessId, { contactId: lead.contactId });
    await audit(businessId, actorId, "lead", lead.id, "lead.transferred", { from, to: toUserId, by: actorId, at: new Date().toISOString(), tasksMoved: tasks.count }, tx);
    return { from, to: toUserId };
  });
}

export const transferSchema = z.object({ leadIds: z.array(z.string()).min(1).max(500), toUserId: z.string().min(1) });

/**
 * Manager: transfer leads to an active agent of the same business (a manager only within their team).
 * A lead in a live call / started dial attempt is marked pending and moved right after that call is documented.
 */
export async function transferLeads(user: SessionUser, input: z.infer<typeof transferSchema>) {
  if (user.role === "agent") throw new ApiError("רק מנהל יכול להעביר לידים", 403, "forbidden");
  const ids = await visibleUserIds(user);
  const target = await prisma.user.findFirst({ where: { id: input.toUserId, businessId: user.businessId, isActive: true }, select: { id: true, fullName: true } });
  if (!target || (ids && !ids.includes(target.id))) throw new ApiError("יש לבחור נציג פעיל בעסק", 400, "invalid_agent");
  const leads = await prisma.lead.findMany({ where: { id: { in: input.leadIds }, businessId: user.businessId, ...ownerScope(ids) }, select: { id: true, contactId: true, ownerUserId: true } });
  const found = new Set(leads.map((l) => l.id));
  const result = { transferred: [] as string[], pending: [] as string[], unchanged: [] as string[], notFound: input.leadIds.filter((id) => !found.has(id)) };
  for (const l of leads) {
    if (l.ownerUserId === target.id) { result.unchanged.push(l.id); continue; }
    if (await activeCallOn(prisma, user.businessId, l.contactId)) {
      await prisma.lead.update({ where: { id: l.id }, data: { pendingTransferToUserId: target.id, pendingTransferById: user.id, pendingTransferAt: new Date() } });
      await audit(user.businessId, user.id, "lead", l.id, "lead.transfer_pending", { from: l.ownerUserId, to: target.id });
      result.pending.push(l.id);
      continue;
    }
    await applyTransfer(user.businessId, l.id, target.id, user.id);
    result.transferred.push(l.id);
  }
  return { ...result, to: target };
}

/** Apply transfers that were waiting for a call to finish (after an outcome is saved, and as a cron safety net). */
export async function applyPendingTransfers(businessId: string, contactId?: string) {
  const waiting = await prisma.lead.findMany({ where: { businessId, pendingTransferToUserId: { not: null }, ...(contactId ? { contactId } : {}) }, select: { id: true, contactId: true, pendingTransferToUserId: true, pendingTransferById: true } });
  let applied = 0;
  for (const l of waiting) {
    if (await activeCallOn(prisma, businessId, l.contactId)) continue;
    const target = await prisma.user.findFirst({ where: { id: l.pendingTransferToUserId!, businessId, isActive: true }, select: { id: true } });
    if (!target) { await prisma.lead.update({ where: { id: l.id }, data: { pendingTransferToUserId: null, pendingTransferById: null, pendingTransferAt: null } }); continue; }
    await applyTransfer(businessId, l.id, target.id, l.pendingTransferById ?? target.id);
    applied++;
  }
  return applied;
}

// ─── "Waiting for a call today" ────────────────────────────────────────────────────────────────────────────────
export type WaitingCategory = "total" | "new" | "today" | "overdue" | "schedule";
export const waitingFilterSchema = z.object({ agent: z.string().optional() });

/**
 * Open, dialable leads that need a call today, each counted once in the total:
 *  new = status "new" with no dial attempt yet (any age) · today = follow-up due today (incl. later today) ·
 *  overdue = follow-up due before today. "schedule" (follow-up without a time) is shown separately, not dialed.
 * Closed and DNC leads are excluded. Unassigned leads are included (and counted) but never dialed before assignment.
 * The same function feeds the card and the filtered list, so the numbers always match the list that opens.
 */
export async function waitingToday(user: SessionUser, agent?: string | null) {
  const ids = await visibleUserIds(user);
  if (agent && agent !== "unassigned" && ids && !ids.includes(agent)) throw new ApiError("אין הרשאה לנתוני נציג זה", 403, "forbidden");
  const settings = await getBusinessSettings(user.businessId);
  const now = new Date();
  const dayStart = businessDayStart(settings.timezone, now);
  const dayEnd = businessDayStart(settings.timezone, new Date(dayStart.getTime() + 36 * 3600_000));
  const scope = ids ? Prisma.sql`AND (l.owner_user_id = ANY(${ids}) OR l.owner_user_id IS NULL)` : Prisma.empty;
  const who = agent === "unassigned" ? Prisma.sql`AND l.owner_user_id IS NULL` : agent ? Prisma.sql`AND l.owner_user_id = ${agent}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ id: string; owner: string | null; status: string; due: Date | null; attempts: number }>>(Prisma.sql`
    WITH base AS (
      SELECT l.id, l.owner_user_id, l.status::text AS status, l.contact_id FROM ${T("leads")} l JOIN ${T("contacts")} c ON c.id = l.contact_id
      WHERE l.business_id = ${user.businessId} AND l.status::text IN (${OPEN}) ${scope} ${who}
        AND NOT EXISTS (SELECT 1 FROM ${T("dnc_entries")} d WHERE d.business_id = l.business_id AND d.phone_e164 = c.phone_e164)
    ), fu AS (
      SELECT b.id, min(t.due_at) AS due FROM base b JOIN ${T("tasks")} t ON t.business_id = ${user.businessId} AND t.contact_id = b.contact_id
        AND t.status = 'open' AND t.type = 'callback' AND (t.lead_id = b.id OR t.lead_id IS NULL)
      GROUP BY b.id
    ), att AS (
      SELECT x.lead_id, count(*)::int AS n FROM ${T("calls")} cl ${ATTEMPT_LEAD}
      WHERE cl.business_id = ${user.businessId} AND ${IS_ATTEMPT} AND cl.contact_id IN (SELECT contact_id FROM base WHERE status = 'new')
      GROUP BY x.lead_id
    )
    SELECT b.id, b.owner_user_id AS owner, b.status, fu.due, COALESCE(att.n, 0) AS attempts
    FROM base b LEFT JOIN fu ON fu.id = b.id LEFT JOIN att ON att.lead_id = b.id`);
  const cat: Record<Exclude<WaitingCategory, "total">, string[]> = { new: [], today: [], overdue: [], schedule: [] };
  for (const r of rows) {
    if (r.due && r.due < dayStart) cat.overdue.push(r.id);
    else if (r.due && r.due < dayEnd) cat.today.push(r.id);
    if (r.status === "new" && r.attempts === 0 && !r.due) cat.new.push(r.id);
    if (r.status === "follow_up" && !r.due) cat.schedule.push(r.id);
  }
  const total = [...new Set([...cat.new, ...cat.today, ...cat.overdue])];
  const owners = new Map(rows.map((r) => [r.id, r.owner]));
  return {
    asOf: now, timezone: settings.timezone, dayStart, dayEnd,
    counts: { total: total.length, new: cat.new.length, today: cat.today.length, overdue: cat.overdue.length, schedule: cat.schedule.length, unassigned: total.filter((id) => !owners.get(id)).length },
    ids: { total, ...cat } as Record<WaitingCategory, string[]>,
  };
}

// ─── Dial guard ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Re-checked right before a call is placed (the queue claim applies the same rules in SQL):
 *  • a lead waiting for a transfer is not dialed by anyone,
 *  • an open lead is dialed only by its owner (auto dialer) / by someone who may see the owner (manual) –
 *    an unassigned lead is never auto-dialed before it is assigned,
 *  • auto dialer only: never before the follow-up time, and never a follow-up that has no time.
 */
export async function assertDialAllowed(user: SessionUser, contactId: string, auto: boolean) {
  const leads = await prisma.lead.findMany({ where: { businessId: user.businessId, contactId, status: { in: [...OPEN_LEAD_STATUSES] } }, select: { ownerUserId: true, status: true, pendingTransferToUserId: true } });
  if (leads.some((l) => l.pendingTransferToUserId)) throw new ApiError("הליד בהעברה לנציג אחר – אי אפשר לחייג אליו עד שההעברה תושלם", 409, "transfer_pending");
  if (leads.length) {
    const ids = auto ? [user.id] : await visibleUserIds(user);
    const allowed = leads.some((l) => (l.ownerUserId ? !ids || ids.includes(l.ownerUserId) : !auto));
    if (!allowed) throw new ApiError(leads.every((l) => !l.ownerUserId) ? "ליד ללא שיוך לא נכנס לחיוג אוטומטי – יש לשייך אותו לנציג" : "הליד משויך לנציג אחר", 409, "lead_not_assigned_to_you");
  }
  if (auto) {
    const open = await prisma.task.findMany({ where: { businessId: user.businessId, contactId, status: "open", type: "callback" }, select: { dueAt: true } });
    if (open.some((t) => t.dueAt.getTime() > Date.now())) throw new ApiError("מועד הפולואפ עוד לא הגיע", 409, "follow_up_not_due");
    if (!open.length && leads.some((l) => l.status === "follow_up")) throw new ApiError("לפולואפ אין מועד – נדרש תזמון לפני חיוג", 409, "follow_up_unscheduled");
  }
}
