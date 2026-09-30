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
import { ownerScope, sharesPool } from "./access";
import { LEAD_STATUS_LABEL, OPEN_LEAD_STATUSES } from "./labels";

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
    SELECT l2.id AS lead_id, l2.reopened_at FROM ${T("leads")} l2
    WHERE l2.business_id = cl.business_id AND l2.contact_id = cl.contact_id
    ORDER BY (l2.created_at <= cl.created_at) DESC, CASE WHEN l2.created_at <= cl.created_at THEN l2.created_at END DESC NULLS LAST, l2.created_at ASC
    LIMIT 1
  ) x ON true`;
// A lead reopened on transfer starts counting again (the earlier calls stay in its history).
const IS_ATTEMPT = Prisma.sql`cl.direction = 'outbound' AND cl.lead_dialed_at IS NOT NULL AND (x.reopened_at IS NULL OR cl.created_at >= x.reopened_at)`;

/** First actual dial attributed by the same CRM-lead policy as the dial-attempt counters. */
export async function firstDialForLead(businessId: string, leadId: string, contactId: string, since: Date, now: Date) {
  const rows = await prisma.$queryRaw<Array<{ at: Date }>>(Prisma.sql`
    SELECT cl.lead_dialed_at AS at FROM ${T("calls")} cl ${ATTEMPT_LEAD}
    WHERE cl.business_id = ${businessId} AND cl.contact_id = ${contactId} AND x.lead_id = ${leadId}
      AND ${IS_ATTEMPT} AND cl.lead_dialed_at >= ${since} AND cl.lead_dialed_at <= ${now}
    ORDER BY cl.lead_dialed_at ASC LIMIT 1`);
  return rows[0]?.at ?? null;
}

export async function attemptStats(businessId: string, contactIds: string[], db: Db = prisma) {
  const out = new Map<string, { count: number; lastAt: Date | null; answered: number }>();
  if (!contactIds.length) return out;
  const rows = await db.$queryRaw<Array<{ leadId: string; n: number; lastAt: Date | null; answered: number }>>(Prisma.sql`
    SELECT x.lead_id AS "leadId", count(*)::int AS n, max(cl.created_at) AS "lastAt", count(cl.answered_at)::int AS answered
    FROM ${T("calls")} cl ${ATTEMPT_LEAD}
    WHERE cl.business_id = ${businessId} AND ${IS_ATTEMPT} AND cl.contact_id = ANY(${[...new Set(contactIds)]})
    GROUP BY x.lead_id`);
  for (const r of rows) out.set(r.leadId, { count: r.n, lastAt: r.lastAt, answered: r.answered });
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
  if (contact.ownerUserId || !sharesPool(ids)) return false;
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
/** Closed statuses that restart as "new" when the lead is transferred to another agent. */
export const REOPEN_ON_TRANSFER: string[] = ["lost"];

async function applyTransfer(businessId: string, leadId: string, toUserId: string, actorId: string, onlyIfPending = false, guard?: (tx: Db) => Promise<boolean>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + leadId}, 0))`);
    const lead = await tx.lead.findFirst({ where: { id: leadId, businessId }, include: { contact: { select: { id: true, ownerUserId: true } } } });
    if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
    // A deferred transfer is applied by whoever gets the lock first (outcome save or the cron safety net) – exactly once.
    if (onlyIfPending && lead.pendingTransferToUserId !== toUserId) return null;
    if (guard && !(await guard(tx))) return null;
    const from = lead.ownerUserId;
    // A lost lead handed to another agent starts over for them as a new lead; everything before stays in its history.
    const reopen = REOPEN_ON_TRANSFER.includes(lead.status);
    await tx.lead.update({ where: { id: lead.id }, data: { ownerUserId: toUserId, pendingTransferToUserId: null, pendingTransferById: null, pendingTransferAt: null, ...(reopen ? { status: "new", closedAt: null, closeReason: null, reopenedAt: new Date() } : {}) } });
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
      await tx.listLead.updateMany({ where: { listId: toList, contactId: lead.contactId, status: { in: reopen ? ["removed", "completed", "exhausted"] : ["removed", "completed"] } }, data: { status: "pending", nextAttemptAt: null, preferredUserId: toUserId, ...(reopen ? { attempts: 0, lastOutcome: null } : {}) } });
    }
    await syncFollowUpQueue(tx, businessId, { contactId: lead.contactId });
    await audit(businessId, actorId, "lead", lead.id, "lead.transferred", { from, to: toUserId, by: actorId, at: new Date().toISOString(), tasksMoved: tasks.count, ...(reopen ? { reopened: true } : {}) }, tx);
    if (reopen) {
      await audit(businessId, actorId, "lead", lead.id, "lead.reopened", { previousStatus: lead.status, previousCloseReason: lead.closeReason, closedAt: lead.closedAt?.toISOString() ?? null, from, to: toUserId }, tx);
      const { emitEvent } = await import("@/lib/events");
      await emitEvent(tx, { businessId, type: "lead.status_changed", contactId: lead.contactId, actorUserId: actorId, source: "user", dedupeKey: `lead.status_changed:${lead.id}:new:reopen:${Date.now()}`, payload: { leadId: lead.id, from: lead.status, to: "new", reason: "transfer" } });
    }
    return { from, to: toUserId, reopened: reopen };
  });
}

export const transferSchema = z.object({ leadIds: z.array(z.string()).min(1).max(500), toUserId: z.string().min(1) });

/**
 * Manager: transfer leads to an active agent of the same business (a manager only within their team).
 * A lead in a live call / started dial attempt is marked pending and moved right after that call is documented.
 */
/** Managers/owner always; an agent only when settings → הרשאות allow it (all agents or selected ones). */
/** One source of truth: the "העברת לידים" CRM permission (users not migrated yet derive it from הרשאות, as before). */
export async function canTransferLeads(user: SessionUser) {
  const { effectiveAccess, can } = await import("@/lib/access/engine");
  return can(await effectiveAccess(user.businessId, user.id), "crm.transfer");
}

export async function transferLeads(user: SessionUser, input: z.infer<typeof transferSchema>) {
  const agent = user.role === "agent";
  if (!(await canTransferLeads(user))) throw new ApiError("אין לך הרשאה להעביר לידים (ניתן לאפשר בהגדרות → הרשאות)", 403, "forbidden");
  const ids = await visibleUserIds(user);
  const target = await prisma.user.findFirst({ where: { id: input.toUserId, businessId: user.businessId, isActive: true }, select: { id: true, fullName: true } });
  // Agents may hand their leads to any active user; a team-scoped manager only within their teams.
  if (!target || (!agent && ids && !ids.includes(target.id))) throw new ApiError("יש לבחור נציג פעיל בעסק", 400, "invalid_agent");
  const leads = await prisma.lead.findMany({ where: { id: { in: input.leadIds }, businessId: user.businessId, ...(agent ? { ownerUserId: user.id } : ownerScope(ids)) }, select: { id: true, contactId: true, ownerUserId: true } });
  const found = new Set(leads.map((l) => l.id));
  const result = { transferred: [] as string[], reopened: [] as string[], pending: [] as string[], unchanged: [] as string[], notFound: input.leadIds.filter((id) => !found.has(id)) };
  for (const l of leads) {
    if (l.ownerUserId === target.id) { result.unchanged.push(l.id); continue; }
    if (await activeCallOn(prisma, user.businessId, l.contactId)) {
      await prisma.lead.update({ where: { id: l.id }, data: { pendingTransferToUserId: target.id, pendingTransferById: user.id, pendingTransferAt: new Date() } });
      await audit(user.businessId, user.id, "lead", l.id, "lead.transfer_pending", { from: l.ownerUserId, to: target.id });
      result.pending.push(l.id);
      continue;
    }
    const done = await applyTransfer(user.businessId, l.id, target.id, user.id);
    result.transferred.push(l.id);
    if (done?.reopened) result.reopened.push(l.id);
    await notifyTransferred(user.businessId, l.id, target.id);
  }
  return { ...result, to: target };
}

/**
 * A transfer decided by the source of truth (an external CRM that owns assignment): same rules as a manual transfer –
 * during a live call it waits for the call to end; otherwise tasks, follow-ups and queues move with the lead.
 */
export async function transferLeadBySource(businessId: string, leadId: string, toUserId: string, actorId: string) {
  const l = await prisma.lead.findFirst({ where: { id: leadId, businessId }, select: { id: true, contactId: true, ownerUserId: true } });
  if (!l || l.ownerUserId === toUserId) return { changed: false, pending: false };
  if (await activeCallOn(prisma, businessId, l.contactId)) {
    await prisma.lead.update({ where: { id: l.id }, data: { pendingTransferToUserId: toUserId, pendingTransferById: actorId, pendingTransferAt: new Date() } });
    await audit(businessId, actorId, "lead", l.id, "lead.transfer_pending", { from: l.ownerUserId, to: toUserId, via: "external_crm" });
    return { changed: false, pending: true };
  }
  await applyTransfer(businessId, l.id, toUserId, actorId);
  await notifyTransferred(businessId, l.id, toUserId);
  return { changed: true, pending: false };
}

/** Apply transfers that were waiting for a call to finish (after an outcome is saved, and as a cron safety net). */
export async function applyPendingTransfers(businessId: string, contactId?: string) {
  const waiting = await prisma.lead.findMany({ where: { businessId, pendingTransferToUserId: { not: null }, ...(contactId ? { contactId } : {}) }, select: { id: true, contactId: true, pendingTransferToUserId: true, pendingTransferById: true } });
  let applied = 0;
  for (const l of waiting) {
    if (await activeCallOn(prisma, businessId, l.contactId)) continue;
    const target = await prisma.user.findFirst({ where: { id: l.pendingTransferToUserId!, businessId, isActive: true }, select: { id: true } });
    if (!target) { await prisma.lead.update({ where: { id: l.id }, data: { pendingTransferToUserId: null, pendingTransferById: null, pendingTransferAt: null } }); continue; }
    const done = await applyTransfer(businessId, l.id, target.id, l.pendingTransferById ?? target.id, true);
    if (!done) continue;
    await notifyTransferred(businessId, l.id, target.id);
    applied++;
  }
  return applied;
}

/** The new agent gets the personal WhatsApp "new lead" message too (if enabled; deduped per lead + agent). */
async function notifyTransferred(businessId: string, leadId: string, userId: string) {
  const { notifyAgentNewLead } = await import("@/server/services/agent-notify");
  await notifyAgentNewLead(businessId, leadId, userId).catch((e: Error) => console.error("agent notify failed", { leadId, error: e.message }));
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
  const scope = ids ? (sharesPool(ids) ? Prisma.sql`AND (l.owner_user_id = ANY(${ids}) OR l.owner_user_id IS NULL)` : Prisma.sql`AND l.owner_user_id = ANY(${ids})`) : Prisma.empty;
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
/** Kept for callers / tests: the central dial eligibility check (src/lib/dialer/eligibility.ts). */
export async function assertDialAllowed(user: SessionUser, contactId: string, auto: boolean, listId?: string | null) {
  const { dialEligibility } = await import("@/lib/dialer/eligibility");
  await dialEligibility(user, { contactId, auto, listId });
}

// ─── Lead history (the lead's own record: owner changes, reopen, status changes) ────────────────────────────────
export interface LeadHistoryItem { id: string; leadId: string; kind: "transfer" | "reopen" | "status" | "exhausted"; at: Date; title: string; body: string | null; actor: string | null }
/** Audit entries of the leads, readable: transfers (from → to), reopen after "lost", status changes, quota closes. */
export async function leadHistory(businessId: string, leadIds: string[]): Promise<LeadHistoryItem[]> {
  if (!leadIds.length) return [];
  const rows = await prisma.auditLog.findMany({ where: { businessId, entityType: "lead", entityId: { in: leadIds }, action: { in: ["lead.transferred", "lead.transfer_pending", "lead.reopened", "lead.updated", "lead.attempts_exhausted"] } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, entityId: true, action: true, payload: true, createdAt: true, actor: { select: { fullName: true } } } });
  const userIds = new Set<string>();
  for (const r of rows) { const p = (r.payload ?? {}) as Record<string, unknown>; for (const k of ["from", "to"]) if (typeof p[k] === "string") userIds.add(p[k] as string); }
  const names = new Map((await prisma.user.findMany({ where: { businessId, id: { in: [...userIds] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  const who = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "נציג" : "ללא נציג");
  const status = (s: unknown) => LEAD_STATUS_LABEL[s as keyof typeof LEAD_STATUS_LABEL] ?? String(s ?? "");
  const out: LeadHistoryItem[] = [];
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const base = { id: r.id, leadId: r.entityId, at: r.createdAt, actor: r.actor?.fullName ?? null };
    if (r.action === "lead.transferred") out.push({ ...base, kind: "transfer", title: `הליד הועבר מ${who(p.from)} ל${who(p.to)}`, body: p.reopened ? "נפתח מחדש אצל הנציג החדש כליד חדש" : null });
    else if (r.action === "lead.transfer_pending") out.push({ ...base, kind: "transfer", title: `הועברה ל${who(p.to)} ממתינה לסיום השיחה`, body: null });
    else if (r.action === "lead.reopened") out.push({ ...base, kind: "reopen", title: `נפתח מחדש כליד חדש (היה: ${status(p.previousStatus)})`, body: [p.previousCloseReason ? `סיבת הסגירה: ${p.previousCloseReason}` : null, `אצל ${who(p.from)} · הועבר ל${who(p.to)}`, "ספירת ניסיונות החיוג מתחילה מחדש; השיחות הקודמות נשארות בהיסטוריה"].filter(Boolean).join(" · ") });
    else if (r.action === "lead.updated" && p.status) out.push({ ...base, kind: "status", title: `סטטוס שונה ל${status(p.status)}`, body: null });
    else if (r.action === "lead.attempts_exhausted") out.push({ ...base, kind: "exhausted", title: "הועבר ללא רלוונטי – מכסת ניסיונות ללא מענה", body: null });
  }
  return out;
}

/** Rule-only transfer. The recommendation and original follow-up are checked under the SAME lock as a
 * reschedule/manual transfer; completing the request and moving the lead commit together. No deferred transfer.
 */
export async function transferFollowupFromRule(actor: SessionUser, toUserId: string, rec: import("@/generated/prisma/client").OpsRecommendation, automatic = false, via = automatic ? "rule" : "app") {
  if (actor.businessId !== rec.businessId || !(await canTransferLeads(actor))) throw new ApiError("אין הרשאה להעברה", 403, "forbidden");
  const ids = await visibleUserIds(actor);
  if (ids && (!ids.includes(toUserId) || !rec.agentId || !ids.includes(rec.agentId))) throw new ApiError("אין הרשאה לנציג", 403, "forbidden");
  const p = rec.proposal as { taskId: string; leadId: string; dueAt: string; version: number; ruleVersion: string };
  const result = await applyTransfer(rec.businessId, p.leadId, toUserId, actor.id, false, async tx => {
    const now = new Date(), since = new Date(now.getTime() - 180000);
    const rule = await tx.opsRule.findFirst({ where: { id: rec.ruleId!, businessId: rec.businessId, status: "active", updatedAt: new Date(p.ruleVersion), OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    if (!rule) return false;
    if (automatic) {
      const policy = await tx.opsRule.findFirst({ where: { businessId: rec.businessId, kind: "approval_policy", status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
      const actions = (policy?.config as { actions?: string[] } | null)?.actions;
      if (rule.autonomy !== "auto" || !actions || actions.includes("ownership")) return false;
    }
    const task = await tx.task.findFirst({ where: { id: p.taskId, businessId: rec.businessId, leadId: p.leadId, userId: rec.agentId!, status: "open", dueAt: new Date(p.dueAt), version: p.version, lead: { ownerUserId: rec.agentId, pendingTransferToUserId: null, status: { in: [...OPEN_LEAD_STATUSES] } } } });
    const contact = task ? await tx.contact.findFirst({ where: { id: task.contactId, businessId: rec.businessId } }) : null;
    if (!contact || contact.isBlocked || contact.consentStatus === "OPTED_OUT" || await tx.dncEntry.findFirst({ where: { businessId: rec.businessId, phoneE164: contact.phoneE164 } })) return false;
    if (!task || task.dueAt > now || await activeCallOn(tx, rec.businessId, task.contactId)) return false;
    if (await tx.dialerSession.findFirst({ where: { businessId: rec.businessId, userId: rec.agentId!, status: "active", lastHeartbeatAt: { gte: since } } })) return false;
    if (!(await tx.dialerSession.findFirst({ where: { businessId: rec.businessId, userId: toUserId, status: "active", lastHeartbeatAt: { gte: since }, user: { isActive: true } } }))) return false;
    if (await tx.call.findFirst({ where: { businessId: rec.businessId, userId: toUserId, endedAt: null } })) return false;
    const changed = await tx.opsRecommendation.updateMany({ where: { id: rec.id, businessId: rec.businessId, kind: "followup_checkin", status: "pending_manager", expiresAt: { gt: now }, agentReply: "transfer" }, data: { status: "completed", decidedById: actor.id, decidedAt: now, decidedVia: via, result: { transferred: true, toAgentId: toUserId, reason: "הפולואפ הועבר לאחר בקשת הנציג" } } });
    return changed.count === 1;
  });
  if (result) await audit(rec.businessId, actor.id, "ai_ops", rec.id, "ai_ops.transfer_executed", { leadId: p.leadId, to: toUserId, source: "followup_checkin", via });
  return Boolean(result);
}

/** One automatic escalation per SLA occurrence, atomically guarded with the ownership change. */
export async function transferSlaFromRule(actor:SessionUser,toUserId:string,rec:import("@/generated/prisma/client").OpsRecommendation){
 if(actor.businessId!==rec.businessId||actor.role!=="owner"||!(await canTransferLeads(actor)))return false;
 const p=rec.proposal as {leadId:string;startedAt:string;ruleVersion:string};
 const result=await applyTransfer(rec.businessId,p.leadId,toUserId,actor.id,false,async tx=>{
  const now=new Date();
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"sla-target:"+toUserId},0))`);
  const settings=await getBusinessSettings(rec.businessId,tx);if(!settings.aiOps.enabled)return false;
  const rule=await tx.opsRule.findFirst({where:{id:rec.ruleId!,businessId:rec.businessId,kind:"lead_response_sla",status:"active",autonomy:"auto",updatedAt:new Date(p.ruleVersion),OR:[{expiresAt:null},{expiresAt:{gt:now}}]}});
  if(!rule||(rule.config as {onBreach?:string}).onBreach!=="transfer_to_available")return false;
  const policy=await tx.opsRule.findFirst({where:{businessId:rec.businessId,kind:"approval_policy",status:"active",OR:[{expiresAt:null},{expiresAt:{gt:now}}]},orderBy:[{priority:"asc"},{createdAt:"asc"}]});
  const actions=(policy?.config as {actions?:string[]}|null)?.actions;if(!actions||actions.includes("ownership"))return false;
  const lead=await tx.lead.findFirst({where:{id:p.leadId,businessId:rec.businessId,ownerUserId:rec.agentId,pendingTransferToUserId:null,status:{in:[...OPEN_LEAD_STATUSES]}},include:{contact:true}});
  if(!lead||(lead.reopenedAt??lead.createdAt).toISOString()!==p.startedAt||lead.contact.isBlocked||lead.contact.consentStatus==="OPTED_OUT")return false;
  if(await tx.dncEntry.findFirst({where:{businessId:rec.businessId,phoneE164:lead.contact.phoneE164}})||await activeCallOn(tx,rec.businessId,lead.contactId))return false;
  // Conservative: any real dial since this occurrence prevents automatic reassignment.
  if(await tx.call.findFirst({where:{businessId:rec.businessId,contactId:lead.contactId,direction:"outbound",leadDialedAt:{gte:new Date(p.startedAt)}}}))return false;
  if(toUserId===lead.ownerUserId||!await tx.dialerSession.findFirst({where:{businessId:rec.businessId,userId:toUserId,status:"active",lastHeartbeatAt:{gte:new Date(now.getTime()-180000)},user:{isActive:true}}}))return false;
  if(await tx.call.findFirst({where:{businessId:rec.businessId,userId:toUserId,endedAt:null}}))return false;
  const pool=settings.leadAssignment;if(pool.agentIds.length&&!pool.agentIds.includes(toUserId))return false;
  const cap=pool.perAgentMax[toUserId]??pool.maxOpenLeadsPerAgent;
  if(cap&&await tx.lead.count({where:{businessId:rec.businessId,ownerUserId:toUserId,status:{in:[...OPEN_LEAD_STATUSES]}}})>=cap)return false;
  const latest=await tx.opsRecommendation.findFirst({where:{id:rec.id,businessId:rec.businessId,status:"needs_attention",expiresAt:{lte:now}}});
  if(!latest||(latest.result as {transferred?:boolean}|null)?.transferred)return false;
  const changed=await tx.opsRecommendation.updateMany({where:{id:rec.id,businessId:rec.businessId,status:"needs_attention",expiresAt:{lte:now}},data:{agentId:toUserId,result:{transferred:true,toAgentId:toUserId,reason:"חריגה מיעד החיוג: הליד הועבר פעם אחת לנציג מחובר לפי הכלל המאושר"}}});
  return changed.count===1;
 });
 return Boolean(result);
}
