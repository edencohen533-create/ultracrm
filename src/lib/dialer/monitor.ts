/**
 * Supervisor listen / whisper on a live call.
 *
 * Provider model (Telnyx): both call legs live in a conference; the supervisor's
 * browser leg is dialed straight into that conference with supervisor_role=monitor
 * (hears everyone, heard by nobody – enforced by Telnyx, not by a browser mute).
 * Whisper = switch_supervisor_role("whisper") with the agent leg pre-registered as
 * the only whisper target, so the customer never hears the supervisor.
 *
 * State machine: connecting → listening ⇄ whispering → ended | failed.
 * "listening" is only set after the provider confirms the supervisor leg joined
 * the conference (conference.participant.joined) – an API 200 is not enough.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { adapterFor } from "@/lib/telephony";
import { dialWithAttempt } from "@/lib/telephony/attempts";
import { TelephonyUnsupportedError } from "@/lib/telephony/types";
import { assertCanSeeUser, type SessionUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

const SUPERVISOR_RING_SECONDS = 20;
const MOCK_JOIN_MS = 1000;

export async function activeMonitorFor(managerId: string) {
  return prisma.callMonitor.findUnique({ where: { activeForManager: managerId }, include: { call: { select: { id: true, userId: true, endedAt: true, answeredAt: true, contactId: true, toE164: true, direction: true, contact: { select: { fullName: true } }, user: { select: { fullName: true } } } } } });
}

/** Permission + liveness checks shared by start / switch. */
async function authorize(user: SessionUser, callId: string) {
  if (user.role === "agent") throw new ApiError("רק מנהלים יכולים להאזין לשיחות", 403, "forbidden");
  const call = await prisma.call.findFirst({ where: { id: callId, businessId: user.businessId }, include: { user: { select: { id: true, fullName: true, sipUsername: true } } } });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  await assertCanSeeUser(user, call.userId); // manager's team scope
  if (call.userId === user.id) throw new ApiError("לא ניתן להאזין לשיחה של עצמך", 400, "self_monitor");
  return call;
}

export async function startMonitor(user: SessionUser, callId: string) {
  const call = await authorize(user, callId);
  if (call.endedAt) throw new ApiError("השיחה הסתיימה", 409, "call_ended");
  if (!call.answeredAt) throw new ApiError("ניתן להצטרף רק אחרי שהלקוח ענה", 409, "call_not_answered");
  // The supervisor joins the conference of the provider that carries the call.
  const telephony = adapterFor(call.provider);
  // Zadarma has no listen / whisper API (only the 007 code dialled from a supervisor's own phone).
  if (!telephony.capabilities.supervisorMonitor) throw new TelephonyUnsupportedError("האזנה ולחישה אינן זמינות בשיחה שעוברת דרך ספק הגיבוי Zadarma", "supervisor");
  if (!telephony.simulation && !call.conferenceId) throw new ApiError("השיחה אינה ב-Conference – לא ניתן להצטרף", 409, "no_conference");

  const sipUsername = await telephony.agentAddress(user.id);
  if (!sipUsername) throw new ApiError("הדפדפן שלך לא מחובר לטלפוניה", 409, "browser_not_registered");

  // Double-click / second call: one active monitor per manager (unique index).
  const existing = await activeMonitorFor(user.id);
  if (existing) {
    if (existing.callId === callId && existing.status !== "failed") return existing;
    throw new ApiError("אתה כבר מחובר לשיחה אחרת – צא ממנה קודם", 409, "monitor_active", { monitorId: existing.id, callId: existing.callId });
  }

  let monitor;
  try {
    monitor = await prisma.callMonitor.create({ data: { businessId: user.businessId, callId, managerId: user.id, activeForManager: user.id, mode: "listen", status: "connecting" } });
  } catch {
    const again = await activeMonitorFor(user.id);
    if (again?.callId === callId && again.status !== "failed") return again;
    throw new ApiError("לא ניתן להתחיל האזנה", 409, "monitor_active");
  }
  await audit(user.businessId, user.id, "monitor", monitor.id, "monitor.started", { callId, agentId: call.userId, mode: "listen" });

  let legId: string;
  try {
    const monitorId = monitor.id;
    const r = await dialWithAttempt({ businessId: call.businessId, callId, leg: "supervisor", provider: call.provider, commandKey: `${monitorId}-supervisor`, fromE164: call.fromE164 }, () => telephony.dialSupervisor({
      monitorId,
      callId,
      sipUsername,
      fromE164: call.fromE164,
      conferenceId: call.conferenceId ?? `mock-conf-${callId}`,
      whisperToLegId: call.agentLegId ?? `mock-agent-${callId}`,
      timeoutSeconds: SUPERVISOR_RING_SECONDS,
    }));
    legId = r.legId;
  } catch (err) {
    monitor = await prisma.callMonitor.update({ where: { id: monitor.id }, data: { status: "failed", error: String((err as Error).message).slice(0, 300), endedAt: new Date(), activeForManager: null } });
    await audit(user.businessId, user.id, "monitor", monitor.id, "monitor.failed", { reason: monitor.error });
    throw new ApiError("החיבור לספק נכשל: " + monitor.error, 502, "monitor_failed");
  }
  // Cancellation / call completion can occur while the provider request is in flight.
  // Persist the returned leg even then, so cleanup targets the actual media resource.
  monitor = await prisma.callMonitor.update({ where: { id: monitor.id }, data: { legId, lastEventAt: new Date() } });
  const currentCall = await prisma.call.findUnique({ where: { id: callId }, select: { endedAt: true } });
  if (monitor.endedAt || currentCall?.endedAt) {
    await telephony.hangupLeg(legId, `${monitor.id}-hangup-supervisor`);
    await markMonitorEnded(monitor.id, "call_ended_during_connect");
    return prisma.callMonitor.findUniqueOrThrow({ where: { id: monitor.id } });
  }
  return monitor;
}

/** Called by the provider event processor when the supervisor leg joins the conference. */
export async function markMonitorJoined(monitorId: string) {
  const m = await prisma.callMonitor.findUnique({ where: { id: monitorId } });
  if (!m || m.endedAt) return;
  if (m.status === "connecting") {
    const changed = await prisma.callMonitor.updateMany({ where: { id: monitorId, endedAt: null, status: "connecting" }, data: { status: "listening", joinedAt: new Date(), lastEventAt: new Date() } });
    if(changed.count)await prisma.opsRecommendation.updateMany({where:{businessId:m.businessId,kind:"expert_assistance",status:"pending_expert",expiresAt:{gt:new Date()},AND:[{proposal:{path:["callId"],equals:m.callId}},{proposal:{path:["expertId"],equals:m.managerId}}]},data:{status:"completed",result:{reason:"המומחה התחבר לשיחה במצב האזנה; דיבור דורש בחירה מפורשת"}}});
    if (changed.count) await audit(m.businessId, m.managerId, "monitor", monitorId, "monitor.joined", { callId: m.callId });
  }
}

/** Provider says the supervisor leg is gone (hangup / left). */
export async function markMonitorEnded(monitorId: string, reason: string) {
  const m = await prisma.callMonitor.findUnique({ where: { id: monitorId } });
  if (!m || m.endedAt) return;
  await prisma.callMonitor.update({ where: { id: monitorId }, data: { status: "ended", endedAt: new Date(), activeForManager: null, error: m.error ?? reason, lastEventAt: new Date() } });
  await audit(m.businessId, m.managerId, "monitor", monitorId, "monitor.ended", { callId: m.callId, reason, mode: m.mode });
}

/** When a call ends, every supervisor attached to it is detached. */
export async function endMonitorsForCall(callId: string, reason: string) {
  const ms = await prisma.callMonitor.findMany({ where: { callId, endedAt: null }, include: { call: { select: { provider: true } } } });
  for (const m of ms) {
    if (m.legId) {
      try {
        await adapterFor(m.call.provider).hangupLeg(m.legId, `${m.id}-hangup-supervisor`);
      } catch {
        /* provider tears the leg down with the conference anyway */
      }
    }
    await markMonitorEnded(m.id, reason);
  }
}

export async function switchMode(user: SessionUser, monitorId: string, mode: "listen" | "whisper" | "barge") {
  return prisma.$transaction(async tx => {
    // Serialize provider mode changes too; a late whisper request must not undo listen-only.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"monitor-mode:" + monitorId}))`);
    const m = await tx.callMonitor.findFirst({ where: { id: monitorId, managerId: user.id, businessId: user.businessId } });
    if (!m) throw new ApiError("האזנה לא נמצאה", 404, "not_found");
    const call = await authorize(user, m.callId);
    if (m.endedAt || call.endedAt) throw new ApiError("השיחה או ההאזנה הסתיימו", 409, "monitor_ended");
    if (m.status === "connecting" || !m.legId) throw new ApiError("עדיין לא מחובר לשיחה", 409, "not_joined");
    await adapterFor(call.provider).switchSupervisorRole(m.legId, mode === "listen" ? "monitor" : mode);
    const changed = await tx.callMonitor.updateMany({ where: { id: m.id, endedAt: null, call: { endedAt: null } }, data: { mode, status: mode === "barge" ? "speaking" : mode === "whisper" ? "whispering" : "listening", lastEventAt: new Date() } });
    if (!changed.count) throw new ApiError("השיחה או ההאזנה הסתיימו", 409, "monitor_ended");
    await audit(user.businessId, user.id, "monitor", m.id, "monitor.mode_changed", { callId: m.callId, agentId: call.userId, mode }, tx);
    return tx.callMonitor.findUniqueOrThrow({ where: { id: m.id } });
  }, { timeout: 25000 });
}

export async function stopMonitor(user: SessionUser, monitorId: string) {
  const m = await prisma.callMonitor.findFirst({ where: { id: monitorId, managerId: user.id, businessId: user.businessId } });
  if (!m) throw new ApiError("האזנה לא נמצאה", 404, "not_found");
  if (m.endedAt) return m;
  const telephony = adapterFor((await prisma.call.findUniqueOrThrow({ where: { id: m.callId }, select: { provider: true } })).provider);
  if (m.legId) {
    try {
      await telephony.hangupLeg(m.legId, `${m.id}-hangup-supervisor`); // only the supervisor leg – agent and customer stay connected
    } catch {
      // Keep the active record so the manager can retry; a provider failure
      // does not prove that the supervisor audio leg was disconnected.
      throw new ApiError("ניתוק ההאזנה לא אושר על ידי ספק הטלפוניה. יש לנסות שוב.", 502, "monitor_disconnect_failed");
    }
  }
  await markMonitorEnded(m.id, "manager_left");
  return prisma.callMonitor.findUnique({ where: { id: m.id } });
}

/** Poll target: reconcile (simulation joins after ~1s; ended calls end monitors) and return the current record. */
export async function monitorState(user: SessionUser, monitorId: string) {
  const m = await prisma.callMonitor.findFirst({ where: { id: monitorId, managerId: user.id }, include: { call: { select: { id: true, provider: true, endedAt: true, answeredAt: true, talkSeconds: true, userId: true, toE164: true, direction: true, contactId: true, contact: { select: { fullName: true } }, user: { select: { fullName: true } } } } } });
  if (!m) throw new ApiError("האזנה לא נמצאה", 404, "not_found");
  if (!m.endedAt && m.call.endedAt) {
    await endMonitorsForCall(m.callId, "call_ended");
    return monitorState(user, monitorId);
  }
  if (!m.endedAt && adapterFor(m.call.provider).simulation && m.status === "connecting" && Date.now() - m.startedAt.getTime() > MOCK_JOIN_MS) {
    await markMonitorJoined(m.id);
    return monitorState(user, monitorId);
  }
  // Supervisor leg never joined within the ring timeout → failed.
  if (!m.endedAt && m.status === "connecting" && Date.now() - m.startedAt.getTime() > (SUPERVISOR_RING_SECONDS + 10) * 1000) {
    await prisma.callMonitor.update({ where: { id: m.id }, data: { status: "failed", error: "supervisor_leg_timeout", endedAt: new Date(), activeForManager: null } });
    await audit(m.businessId, m.managerId, "monitor", m.id, "monitor.failed", { reason: "supervisor_leg_timeout" });
    return monitorState(user, monitorId);
  }
  return m;
}
