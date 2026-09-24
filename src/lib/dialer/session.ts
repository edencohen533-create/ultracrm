/**
 * Dialer sessions: one live session per agent, owned by a single browser tab.
 * Heartbeats renew the lead lock and keep presence accurate.
 */
import { lockAgent } from "./locking";
import type { Prisma } from "@/generated/prisma/client";
import type { DialMode } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { assertListAccess, currentLockedLead, releaseLead } from "@/lib/dialer/queue";
import { audit } from "@/lib/audit";

export const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_AFTER_MS = 75_000;

export async function currentSession(userId: string) {
  return prisma.dialerSession.findFirst({
    where: { userId, status: { in: ["active", "paused"] } },
    include: { list: { select: { id: true, name: true, scriptId: true } } },
    orderBy: { startedAt: "desc" },
  });
}

export async function startSession(user: SessionUser, input: { mode: DialMode; listId?: string; browserSessionId: string; countdownSeconds?: number }) {
  if (input.mode !== "manual") {
    if (!input.listId) throw new ApiError("יש לבחור רשימת חיוג", 400, "list_required");
    await assertListAccess(user.businessId, user.id, user.role, input.listId);
  }
  const live = await prisma.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
  if (live) throw new ApiError("יש שיחה פעילה – סיים אותה לפני התחלת סשן חדש", 409, "call_active", { callId: live.id });

  const settings = await getBusinessSettings(user.businessId);
  const countdown = Math.min(60, Math.max(0, input.countdownSeconds ?? settings.autoDialCountdownSeconds));

  return prisma.$transaction(async (tx) => {
    await lockAgent(tx, user.id);
    const live = await tx.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
    if (live) throw new ApiError("יש שיחה פעילה", 409, "call_active");
    const pending = await tx.call.findFirst({ where: { userId: user.id, endedAt: { not: null }, outcomeSavedAt: null }, select: { id: true } });
    if (pending) throw new ApiError("יש לתעד את השיחה הקודמת", 409, "outcome_required");
    const held = await currentLockedLead(user.id, tx);
    if (held && held.status === "locked") await releaseLead(user.id, held.id, "session_superseded", tx);
    // A new session (possibly from another tab) supersedes any previous one.
    await tx.dialerSession.updateMany({ where: { userId: user.id, status: { in: ["active", "paused"] } }, data: { status: "ended", endedAt: new Date() } });
    const s = await tx.dialerSession.create({
      data: {
        businessId: user.businessId,
        userId: user.id,
        listId: input.mode === "manual" ? null : input.listId,
        mode: input.mode,
        browserSessionId: input.browserSessionId,
        countdownSeconds: countdown,
      },
      include: { list: { select: { id: true, name: true, scriptId: true } } },
    });
    await tx.user.update({ where: { id: user.id }, data: { presence: "available", presenceAt: new Date(), lastSeenAt: new Date() } });
    await audit(user.businessId, user.id, "session", s.id, "session.started", { mode: input.mode, listId: input.listId }, tx);
    return s;
  });
}

async function ownedSession(user: SessionUser, sessionId: string, browserSessionId: string, db: Prisma.TransactionClient = prisma) {
  const s = await db.dialerSession.findFirst({ where: { id: sessionId, userId: user.id } });
  if (!s) throw new ApiError("סשן לא נמצא", 404, "not_found");
  if (s.status === "ended") throw new ApiError("הסשן הסתיים", 409, "session_ended");
  if (s.browserSessionId !== browserSessionId) throw new ApiError("החיוג פעיל בלשונית אחרת", 409, "session_taken");
  return s;
}

export async function pauseSession(user: SessionUser, sessionId: string, browserSessionId: string) {
  return prisma.$transaction(async (tx) => {
    await lockAgent(tx, user.id);
    await ownedSession(user, sessionId, browserSessionId, tx);
    await tx.dialerSession.update({ where: { id: sessionId }, data: { status: "paused" } });
    await tx.user.updateMany({ where: { id: user.id, presence: { in: ["available"] } }, data: { presence: "paused", presenceAt: new Date() } });
  });
}

export async function resumeSession(user: SessionUser, sessionId: string, browserSessionId: string) {
  return prisma.$transaction(async (tx) => {
    await lockAgent(tx, user.id);
    await ownedSession(user, sessionId, browserSessionId, tx);
    await tx.dialerSession.update({ where: { id: sessionId }, data: { status: "active" } });
    await tx.user.updateMany({ where: { id: user.id, presence: "paused" }, data: { presence: "available", presenceAt: new Date() } });
  });
}

export async function endSession(user: SessionUser, sessionId: string, browserSessionId: string) {
  return prisma.$transaction(async (tx) => {
    await lockAgent(tx, user.id);
    const s = await ownedSession(user, sessionId, browserSessionId, tx);
    const live = await tx.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
    if (live) throw new ApiError("יש שיחה פעילה – נתק לפני סיום הסשן", 409, "call_active", { callId: live.id });
    const lead = await currentLockedLead(user.id, tx);
    if (lead && lead.status === "locked") await releaseLead(user.id, lead.id, "session_ended", tx);
    await tx.dialerSession.update({ where: { id: s.id }, data: { status: "ended", endedAt: new Date() } });
    await tx.user.update({ where: { id: user.id }, data: { presence: "offline", presenceAt: new Date() } });
    await audit(user.businessId, user.id, "session", s.id, "session.ended", undefined, tx);
  });
}

/** Called every HEARTBEAT_INTERVAL_MS by the owning tab. */
export async function heartbeat(user: SessionUser, sessionId: string | null, browserSessionId: string) {
  const settings = await getBusinessSettings(user.businessId);
  await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
  if (sessionId) {
    const s = await prisma.dialerSession.findFirst({ where: { id: sessionId, userId: user.id } });
    if (!s || s.status === "ended") return { sessionOk: false, reason: "session_ended" as const };
    if (s.browserSessionId !== browserSessionId) return { sessionOk: false, reason: "session_taken" as const };
    await prisma.dialerSession.update({ where: { id: s.id }, data: { lastHeartbeatAt: new Date() } });
  }
  // Renew the lock on whatever lead this agent holds.
  const lead = await currentLockedLead(user.id);
  if (lead && lead.status === "locked") {
    await prisma.listLead.update({ where: { id: lead.id }, data: { lockExpiresAt: new Date(Date.now() + settings.lockTtlSeconds * 1000) } });
  }
  return { sessionOk: true as const };
}

/**
 * Housekeeping (run opportunistically from polls): end sessions whose tab went
 * away, mark their agents offline, and release leads they held (never while a
 * call may still be alive – those are handled by call reconciliation).
 */
export async function reapStaleSessions(businessId: string) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await prisma.dialerSession.findMany({
    where: { businessId, status: { in: ["active", "paused"] }, lastHeartbeatAt: { lt: cutoff } },
    select: { id: true, userId: true },
  });
  for (const s of stale) {
    const live = await prisma.call.findUnique({ where: { activeForUser: s.userId }, select: { id: true } });
    if (live) continue; // keep the session until the call is reconciled
    await prisma.dialerSession.update({ where: { id: s.id }, data: { status: "ended", endedAt: new Date() } });
    await prisma.user.update({ where: { id: s.userId }, data: { presence: "offline", presenceAt: new Date() } });
    const lead = await currentLockedLead(s.userId);
    if (lead && lead.status === "locked" && lead.lockExpiresAt && lead.lockExpiresAt < new Date()) {
      await releaseLead(s.userId, lead.id, "session_stale");
    }
  }
  return stale.length;
}
