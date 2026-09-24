/**
 * Lead queue: atomic claim (FOR UPDATE SKIP LOCKED), lock renewal, release,
 * skip and outcome application. All operations are business-scoped.
 */
import crypto from "node:crypto";
import { lockAgent } from "./locking";
import { Prisma } from "@/generated/prisma/client";
import type { OutcomeKey } from "@/generated/prisma/enums";
import { prisma, dbSchema } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";
import { getBusinessSettings, isWithinDialWindow, nextDialWindowOpening, type DialWindow } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { explainScore, scoreSql } from "@/lib/dialer/prioritization";

const CALLBACK_GRACE_MINUTES = 60;

export async function isDnc(businessId: string, phoneE164: string) {
  const hit = await prisma.dncEntry.findUnique({ where: { businessId_phoneE164: { businessId, phoneE164 } }, select: { id: true } });
  return Boolean(hit);
}

export async function listDialWindow(businessId: string, listId: string | null): Promise<DialWindow> {
  const settings = await getBusinessSettings(businessId);
  if (!listId) return settings.dialWindow;
  const list = await prisma.dialList.findUnique({ where: { id: listId }, select: { dialWindowJson: true } });
  const w = list?.dialWindowJson as Partial<DialWindow> | null;
  return { ...settings.dialWindow, ...(w ?? {}) };
}

/** Make sure the agent may work this list. */
export async function assertListAccess(businessId: string, userId: string, role: string, listId: string) {
  const list = await prisma.dialList.findFirst({ where: { id: listId, businessId }, select: { id: true, isActive: true, isPaused: true, archivedAt: true, agents: { select: { userId: true } } } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  if (!list.isActive || list.archivedAt) throw new ApiError("הרשימה אינה פעילה", 400, "list_inactive");
  if (list.isPaused) throw new ApiError("הרשימה מושהית על ידי המנהל", 409, "list_paused");
  if (role === "agent" && list.agents.length > 0 && !list.agents.some((a) => a.userId === userId)) {
    throw new ApiError("הרשימה אינה משויכת אליך", 403, "forbidden");
  }
}

/** The lead currently locked by this user (at most one). */
export async function currentLockedLead(userId: string, db: Prisma.TransactionClient = prisma) {
  return db.listLead.findFirst({
    where: { lockedByUserId: userId, status: { in: ["locked", "in_call"] } },
    include: { contact: true, list: { select: { id: true, name: true, scriptId: true } } },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Atomically claim the next eligible lead in a list for this agent.
 * Returns null when the queue is empty. Never hands the same lead to two agents.
 */
export async function claimNextLead(businessId: string, userId: string, listId: string) {
  const settings = await getBusinessSettings(businessId);
  if (settings.dialingPaused) throw new ApiError("החיוג מושהה ברמת העסק על ידי המנהל", 409, "dialing_paused");
  const window = await listDialWindow(businessId, listId);
  if (!isWithinDialWindow(window)) {
    const next = nextDialWindowOpening(window);
    throw new ApiError("מחוץ לחלון החיוג של הרשימה", 409, "outside_dial_window", { nextOpening: next?.toISOString() ?? null, window });
  }
  return prisma.$transaction(async (tx) => {
    await lockAgent(tx, userId);
    const existing = await currentLockedLead(userId, tx);
    if (existing) {
      if (existing.listId !== listId) throw new ApiError("יש ליד פתוח ברשימה אחרת – סיים אותו קודם", 409, "lead_already_locked");
      return existing;
    }

    const list = await tx.dialList.findUniqueOrThrow({ where: { id: listId }, select: { maxAttempts: true } });
    const maxAttempts = list.maxAttempts ?? settings.maxAttempts;
    const token = crypto.randomUUID();
    const ttl = settings.lockTtlSeconds;
    const S = dbSchema();
    const T = (t: string) => Prisma.raw(`"${S}"."${t}"`);
    const E = Prisma.raw(`"${S}"."LeadStatus"`);
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE ${T("list_leads")} SET
        status = 'locked'::${E},
        locked_by_user_id = ${userId},
        lock_token = ${token},
        lock_expires_at = timezone('UTC', now()) + (${ttl} || ' seconds')::interval,
        updated_at = timezone('UTC', now())
      WHERE id = (
        SELECT l.id FROM ${T("list_leads")} l
        JOIN ${T("contacts")} c ON c.id = l.contact_id
        WHERE l.list_id = ${listId}
          AND l.business_id = ${businessId}
          AND (
            l.status IN ('pending'::${E}, 'callback'::${E})
            OR (l.status = 'locked'::${E} AND l.lock_expires_at < timezone('UTC', now()))
          )
          AND (l.attempts < ${maxAttempts} OR l.status = 'callback'::${E})
          AND NOT EXISTS (SELECT 1 FROM ${T("calls")} active_call WHERE active_call.lead_id = l.id AND active_call.outcome_saved_at IS NULL)
          AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= timezone('UTC', now()))
          AND (
            l.preferred_user_id IS NULL
            OR l.preferred_user_id = ${userId}
            OR l.next_attempt_at < timezone('UTC', now()) - (${CALLBACK_GRACE_MINUTES} || ' minutes')::interval
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${T("dnc_entries")} d WHERE d.business_id = l.business_id AND d.phone_e164 = c.phone_e164
          )
        ORDER BY
          ${scoreSql(settings.prioritization, userId)} DESC,
          l.created_at ASC
        LIMIT 1
        FOR UPDATE OF l SKIP LOCKED
      )
      RETURNING id
    `);
    if (rows.length === 0) return null;
    const claimed = await tx.listLead.findUnique({ where: { id: rows[0].id }, include: { contact: true } });
    const { score, reason } = explainScore(settings.prioritization, claimed!, userId);
    const lead = await tx.listLead.update({
      where: { id: rows[0].id },
      data: { claimReason: reason, claimScore: score },
      include: { contact: true, list: { select: { id: true, name: true, scriptId: true } } },
    });
    await audit(businessId, userId, "lead", rows[0].id, "lead.claimed", { listId, score, reason }, tx);
    return lead;
  });
}

/** Extend the lock while the agent is still working the lead. */
export async function renewLock(userId: string, leadId: string, lockToken: string, seconds: number) {
  const r = await prisma.listLead.updateMany({
    where: { id: leadId, lockedByUserId: userId, lockToken, status: { in: ["locked", "in_call"] } },
    data: { lockExpiresAt: new Date(Date.now() + seconds * 1000) },
  });
  return r.count > 0;
}

export async function assertLeadLock(userId: string, leadId: string, lockToken: string | undefined) {
  const lead = await prisma.listLead.findUnique({ where: { id: leadId }, include: { contact: true } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (lead.lockedByUserId !== userId || (lockToken && lead.lockToken !== lockToken)) {
    throw new ApiError("הליד כבר לא נעול עבורך (פג תוקף או עבר לנציג אחר)", 409, "lock_lost");
  }
  if (lead.lockExpiresAt && lead.lockExpiresAt.getTime() < Date.now() && lead.status !== "in_call") {
    throw new ApiError("נעילת הליד פגה – משוך ליד מחדש", 409, "lock_expired");
  }
  return lead;
}

/** Release a lead back to the queue (e.g. session ended without dialing). */
export async function releaseLead(userId: string, leadId: string, reason: string, db: Prisma.TransactionClient = prisma) {
  const lead = await db.listLead.findUnique({ where: { id: leadId } });
  if (!lead || lead.lockedByUserId !== userId) return false;
  if (lead.status === "in_call") return false; // never release while a call may be alive
  const back: "pending" | "callback" = lead.lastOutcome === "callback" && lead.nextAttemptAt ? "callback" : "pending";
  const released = await db.listLead.updateMany({
    where: { id: leadId, lockedByUserId: userId, status: "locked" },
    data: { status: back, lockedByUserId: null, lockToken: null, lockExpiresAt: null },
  });
  if (!released.count) return false;
  await audit(lead.businessId, userId, "lead", leadId, "lead.released", { reason }, db);
  return true;
}

/** Preview mode: skip a lead with a reason. It goes back to the queue after the retry interval (attempt not counted). */
export async function skipLead(businessId: string, userId: string, leadId: string, lockToken: string, reason: string) {
  const lead = await assertLeadLock(userId, leadId, lockToken);
  if (lead.status === "in_call") throw new ApiError("לא ניתן לדלג במהלך שיחה", 409, "call_active");
  const settings = await getBusinessSettings(businessId);
  const list = await prisma.dialList.findUnique({ where: { id: lead.listId }, select: { retryIntervalMinutes: true } });
  const minutes = list?.retryIntervalMinutes ?? settings.retryIntervalMinutes;
  const skipped = await prisma.listLead.updateMany({
    where: { id: leadId, lockedByUserId: userId, lockToken, status: "locked" },
    data: {
      status: "pending",
      lockedByUserId: null,
      lockToken: null,
      lockExpiresAt: null,
      lastSkipReason: reason,
      nextAttemptAt: new Date(Date.now() + minutes * 60_000),
      preferredUserId: null,
    },
  });
  if (!skipped.count) throw new ApiError("נעילת הליד השתנתה", 409, "lock_lost");
  await audit(businessId, userId, "lead", leadId, "lead.skipped", { reason });
}

/** Apply the agent's business outcome to the lead and release the lock. */
export async function applyOutcomeToLead(opts: {
  businessId: string;
  userId: string;
  leadId: string;
  outcome: OutcomeKey;
  callbackAt?: Date;
  note?: string;
}, db: Prisma.TransactionClient = prisma) {
  const { businessId, userId, leadId, outcome, callbackAt } = opts;
  const def = OUTCOME_BY_KEY[outcome];
  const lead = await db.listLead.findUnique({ where: { id: leadId }, include: { contact: true, list: true } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  const settings = await getBusinessSettings(businessId, db);
  const maxAttempts = lead.list.maxAttempts ?? settings.maxAttempts;
  const window = { ...settings.dialWindow, ...((lead.list.dialWindowJson as Partial<DialWindow> | null) ?? {}) };

  const release = { lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null as string | null };
  let data: Prisma.ListLeadUpdateInput = { lastOutcome: outcome, ...release };

  if (def.addsToDnc) {
    data = { ...data, status: "dnc", nextAttemptAt: null };
  } else if (def.requiresCallbackTime) {
    if (!callbackAt) throw new ApiError("יש לבחור מועד לחזרה", 400, "callback_time_required");
    data = { ...data, status: "callback", nextAttemptAt: callbackAt, preferredUserId: userId };
  } else if (def.closesLead) {
    data = { ...data, status: "completed", nextAttemptAt: null };
  } else if (def.retry) {
    if (lead.attempts >= maxAttempts) {
      data = { ...data, status: "exhausted", nextAttemptAt: null };
    } else {
      const minutes = outcome === "busy" ? settings.busyRetryMinutes : (lead.list.retryIntervalMinutes ?? settings.retryIntervalMinutes);
      let next = new Date(Date.now() + minutes * 60_000);
      if (!isWithinDialWindow(window, next)) next = nextDialWindowOpening(window, next) ?? next;
      data = { ...data, status: "pending", nextAttemptAt: next, preferredUserId: settings.stickyOwner ? userId : null };
    }
  } else {
    data = { ...data, status: "completed" };
  }

  await db.listLead.update({ where: { id: leadId }, data });

  if (def.addsToDnc) {
    await addToDnc(businessId, userId, lead.contact.phoneE164, `outcome:${outcome}`, db);
  }
  await audit(businessId, userId, "lead", leadId, "lead.outcome", { outcome, callbackAt: callbackAt?.toISOString() }, db);
}

/** Block a number for the whole business and pull it out of every list. */
export async function addToDnc(businessId: string, userId: string | null, phoneE164: string, reason?: string, db: Prisma.TransactionClient = prisma) {
  await db.dncEntry.upsert({
    where: { businessId_phoneE164: { businessId, phoneE164 } },
    create: { businessId, phoneE164, reason, createdByUserId: userId },
    update: { reason },
  });
  const contacts = await db.contact.findMany({ where: { businessId, phoneE164 }, select: { id: true } });
  await db.listLead.updateMany({
    where: { businessId, contactId: { in: contacts.map((c) => c.id) }, status: { notIn: ["in_call"] } },
    data: { status: "dnc", lockedByUserId: null, lockToken: null, lockExpiresAt: null, nextAttemptAt: null, preferredUserId: null },
  });
  await db.task.updateMany({ where: { businessId, contactId: { in: contacts.map((c) => c.id) }, status: "open" }, data: { status: "cancelled" } });
  await audit(businessId, userId, "dnc", phoneE164, "dnc.added", { reason }, db);
}

export async function removeFromDnc(businessId: string, userId: string, phoneE164: string) {
  await prisma.dncEntry.deleteMany({ where: { businessId, phoneE164 } });
  await audit(businessId, userId, "dnc", phoneE164, "dnc.removed");
}

/** Queue counters for a list (used by the workspace and list pages). */
/** Queue counters + why leads are NOT available right now. */
export async function listQueueStats(listId: string) {
  const now = new Date();
  const [grouped, due, notDue, lockedNow, list] = await Promise.all([
    prisma.listLead.groupBy({ by: ["status"], where: { listId }, _count: { _all: true } }),
    prisma.listLead.count({ where: { listId, status: { in: ["pending", "callback"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } }),
    prisma.listLead.count({ where: { listId, status: { in: ["pending", "callback"] }, nextAttemptAt: { gt: now } } }),
    prisma.listLead.count({ where: { listId, status: "locked", lockExpiresAt: { gt: now } } }),
    prisma.dialList.findUnique({ where: { id: listId }, select: { businessId: true, dialWindowJson: true, isPaused: true, archivedAt: true, isActive: true } }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;
  const window = list ? await listDialWindow(list.businessId, listId) : null;
  const inWindow = window ? isWithinDialWindow(window, now) : true;
  const unavailable = {
    notDueYet: notDue,
    inProgress: lockedNow + (byStatus.in_call ?? 0),
    exhausted: byStatus.exhausted ?? 0,
    completed: byStatus.completed ?? 0,
    dnc: byStatus.dnc ?? 0,
    removed: byStatus.removed ?? 0,
    outsideDialWindow: !inWindow,
    listPaused: Boolean(list?.isPaused),
    listInactive: Boolean(list && (!list.isActive || list.archivedAt)),
  };
  return { byStatus, dueNow: inWindow && !unavailable.listPaused && !unavailable.listInactive ? due : 0, dueIgnoringWindow: due, unavailable, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
}

/** Manager: move a held/pending lead to another agent (sets preference, releases any lock, audited). */
export async function transferLead(businessId: string, actorId: string, leadId: string, toUserId: string | null, note?: string) {
  const lead = await prisma.listLead.findFirst({ where: { id: leadId, businessId } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (lead.status === "in_call") throw new ApiError("לא ניתן להעביר ליד בזמן שיחה", 409, "call_active");
  if (toUserId) {
    const u = await prisma.user.findFirst({ where: { id: toUserId, businessId, isActive: true } });
    if (!u) throw new ApiError("נציג יעד לא נמצא", 404, "not_found");
  }
  const back = lead.status === "locked" ? (lead.lastOutcome === "callback" && lead.nextAttemptAt ? "callback" : "pending") : lead.status;
  const updated = await prisma.listLead.update({
    where: { id: leadId },
    data: { preferredUserId: toUserId, status: back, lockedByUserId: null, lockToken: null, lockExpiresAt: null },
  });
  await prisma.task.updateMany({ where: { leadId, status: "open" }, data: toUserId ? { userId: toUserId } : {} });
  await audit(businessId, actorId, "lead", leadId, "lead.transferred", { from: lead.lockedByUserId ?? lead.preferredUserId, to: toUserId, note });
  return updated;
}
