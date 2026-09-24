/**
 * Provider event processor. Idempotent (unique provider event id) and
 * order-tolerant: state only moves forward, and a hangup always finalizes.
 */
import { lockAgent } from "@/lib/dialer/locking";
import { Prisma } from "@/generated/prisma/client";
import type { CallStatus, TelephonyResult } from "@/generated/prisma/enums";
import { prisma, dbSchema } from "@/lib/db";
import { getTelephony } from "@/lib/telephony";
import { TelephonyRequestTimeout } from "@/lib/telephony/types";
import type { ProviderEvent } from "@/lib/telephony/types";
import { getBusinessSettings } from "@/lib/settings";
import { handleInboundInitiated, setupInboundBridge } from "@/lib/dialer/inbound";
import { endMonitorsForCall, markMonitorEnded, markMonitorJoined } from "@/lib/dialer/monitor";

const RANK: Record<CallStatus, number> = {
  created: 0,
  dialing_agent: 1,
  agent_connected: 2,
  dialing_lead: 3,
  ringing: 4,
  answered: 5,
  ended: 6,
  failed: 6,
};

function forward(current: CallStatus, next: CallStatus): CallStatus {
  return RANK[next] > RANK[current] ? next : current;
}

export function telephonyResultFromHangup(cause: string | undefined, answered: boolean): TelephonyResult {
  if (answered) return "answered";
  switch (cause) {
    case "user_busy":
      return "busy";
    case "timeout":
    case "no_answer":
      return "no_answer";
    case "originator_cancel":
      return "cancelled";
    case "call_rejected":
      return "rejected";
    default:
      return "failed";
  }
}

export interface ProcessResult {
  duplicate: boolean;
  callId: string | null;
}

export async function processProviderEvent(ev: ProviderEvent): Promise<ProcessResult> {
  // 1. Record the raw event; a unique violation means we've already seen it.
  //    An event that exists but was never marked processed (crash mid-way) is applied again.
  const seen = await prisma.telephonyEvent.findUnique({ where: { provider_providerEventId: { provider: ev.provider, providerEventId: ev.eventId } }, select: { id: true, processedAt: true } });
  if (seen?.processedAt) return { duplicate: true, callId: null };
  if (!seen) {
    try {
      await prisma.telephonyEvent.create({
        data: {
          provider: ev.provider,
          providerEventId: ev.eventId,
          eventType: ev.type,
          legId: ev.legId,
          occurredAt: ev.occurredAt,
          payload: ev.raw as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { duplicate: true, callId: null };
      }
      throw err;
    }
  }

  // 1b. Supervisor (manager) leg events never touch the call's own state machine.
  if (ev.leg === "supervisor" || ev.legId.startsWith("mock-supervisor-")) {
    const monitor = ev.monitorId ? await prisma.callMonitor.findUnique({ where: { id: ev.monitorId } }) : await prisma.callMonitor.findFirst({ where: { legId: ev.legId } });
    if (monitor) {
      // A webhook may be the only evidence of the leg when the dial request times out.
      const fresh = await prisma.callMonitor.update({ where: { id: monitor.id }, data: { legId: ev.legId }, include: { call: { select: { endedAt: true } } } });
      if ((fresh.endedAt || fresh.call.endedAt) && ev.type !== "leg.hangup" && ev.type !== "conference.left") {
        await getTelephony().hangupLeg(ev.legId, `${monitor.id}-hangup-supervisor`);
        await markMonitorEnded(monitor.id, "late_supervisor_leg");
      } else if (ev.type === "conference.joined") await markMonitorJoined(monitor.id);
      else if (ev.type === "leg.hangup" || ev.type === "conference.left") await markMonitorEnded(monitor.id, ev.hangupCause ?? "supervisor_left");
      await prisma.telephonyEvent.update({ where: { provider_providerEventId: { provider: ev.provider, providerEventId: ev.eventId } }, data: { processedAt: new Date(), callId: monitor.callId, businessId: monitor.businessId } });
      return { duplicate: false, callId: monitor.callId };
    }
  }

  // 2. Resolve the call – by echoed client state first, then by leg id.
  const call =
    (ev.callId ? await prisma.call.findUnique({ where: { id: ev.callId } }) : null) ??
    (await prisma.call.findFirst({ where: { OR: [{ agentLegId: ev.legId }, { leadLegId: ev.legId }] } }));
  if (!call) {
    // A brand-new incoming leg with no client_state = a customer calling one of our numbers.
    let routed: { id: string; businessId: string } | null = null;
    if (ev.type === "leg.initiated" && ev.direction === "incoming" && !ev.callId) {
      try {
        routed = await handleInboundInitiated(ev);
      } catch (err) {
        console.error("[events] inbound routing failed", err);
        throw err;
      }
    }
    await prisma.telephonyEvent.update({
      where: { provider_providerEventId: { provider: ev.provider, providerEventId: ev.eventId } },
      data: { processedAt: new Date(), callId: routed?.id ?? undefined, businessId: routed?.businessId ?? undefined },
    });
    return { duplicate: false, callId: routed?.id ?? null };
  }
  const leg: "agent" | "lead" | undefined = ev.leg === "agent" || ev.leg === "lead" ? ev.leg : call.agentLegId === ev.legId ? "agent" : call.leadLegId === ev.legId ? "lead" : undefined;

  await prisma.telephonyEvent.update({
    where: { provider_providerEventId: { provider: ev.provider, providerEventId: ev.eventId } },
    data: { callId: call.id, businessId: call.businessId },
  });

  // 3. Apply under a row lock so concurrent webhooks for the same call serialize.
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${dbSchema()}"."calls"`)} WHERE id = ${call.id} FOR UPDATE`);
    if (rows.length === 0) return null;
    const c = (await tx.call.findUnique({ where: { id: call.id } }))!;
    if (c.endedAt && ev.type !== "recording.saved") return { c, action: "finalized" as const };

    const now = ev.occurredAt ?? new Date();
    const data: Prisma.CallUpdateInput = { lastEventAt: new Date() };
    // Webhooks can arrive before the HTTP dial response (or be the only response).
    if (leg === "agent" && !c.agentLegId) data.agentLegId = ev.legId;
    if (leg === "lead" && !c.leadLegId) data.leadLegId = ev.legId;
    let action: "none" | "dial_lead" | "hangup_lead" | "hangup_agent" | "finalized" | "setup_inbound" = "none";

    if (leg === "agent") {
      if (ev.type === "conference.joined") {
        if (ev.conferenceId && !c.conferenceId) data.conferenceId = ev.conferenceId;
        if (c.direction === "inbound") {
          if (!c.agentAnsweredAt) data.agentAnsweredAt = now;
          if (!c.answeredAt) data.answeredAt = now; // agent is in the conference with the customer
          data.status = forward(c.status, "answered");
        }
      } else if (ev.type === "leg.answered") {
        if (!c.agentAnsweredAt) data.agentAnsweredAt = now;
        if (c.direction === "inbound") {
          if (!c.answeredAt) data.answeredAt = now;
          data.status = forward(c.status, "answered");
        } else {
          data.status = forward(c.status, "agent_connected");
          if (!c.leadLegId && !c.hangupRequestedAt) action = "dial_lead";
        }
      } else if (ev.type === "leg.hangup") {
        if (c.leadLegId && !c.endedAt) {
          // Agent dropped (or hung up) – make sure the lead leg is torn down.
          if (c.answeredAt || c.hangupRequestedAt) {
            // Bridged call: the provider ends the other leg too, but be explicit.
            action = "hangup_lead";
          } else {
            action = "hangup_lead";
          }
          if (!c.hangupRequestedAt) data.hangupRequestedAt = new Date();
        } else if (!c.leadLegId) {
          // Agent leg never answered / failed before we dialed the lead.
          data.status = "failed";
          data.endedAt = now;
          data.telephonyResult = "failed";
          data.failureReason = `agent_leg_${ev.hangupCause ?? "hangup"}`;
          data.hangupCause = ev.hangupCause;
          data.hangupSource = ev.hangupSource;
          data.activeForUser = null;
          data.talkSeconds = 0;
          action = "finalized";
        }
      }
    } else if (leg === "lead") {
      switch (ev.type) {
        case "leg.initiated":
          if (!c.ringingAt) data.ringingAt = now;
          data.status = forward(c.status, "ringing");
          break;
        case "leg.answered":
        case "leg.bridged":
          if (c.direction === "inbound" && ev.type === "leg.answered") {
            // We answered the customer leg ourselves; now build the conference and ring the agent.
            data.status = forward(c.status, "ringing");
            if (!c.agentLegId) action = "setup_inbound";
            break;
          }
          if (!c.answeredAt) data.answeredAt = now;
          data.status = forward(c.status, "answered");
          if (c.recordingId && c.recordingStatus === "none") data.recordingStatus = "recording";
          break;
        case "leg.machine_detection":
          data.amdResult = ev.amdResult;
          break;
        case "leg.hangup": {
          const answered = Boolean(c.answeredAt);
          const endedAt = now;
          data.endedAt = endedAt;
          data.status = answered || ev.hangupCause === "normal_clearing" || ev.hangupCause === "timeout" || ev.hangupCause === "user_busy" || ev.hangupCause === "originator_cancel" || ev.hangupCause === "call_rejected" || ev.hangupCause === "no_answer" ? "ended" : "failed";
          data.telephonyResult = telephonyResultFromHangup(ev.hangupCause, answered);
          data.hangupCause = ev.hangupCause;
          data.hangupSource = ev.hangupSource;
          data.talkSeconds = answered && c.answeredAt ? Math.max(0, Math.round((endedAt.getTime() - c.answeredAt.getTime()) / 1000)) : 0;
          data.activeForUser = null;
          if (c.recordingStatus === "recording" && !answered) data.recordingStatus = "none";
          action = "finalized";
          break;
        }
        case "recording.saved":
          data.recordingStatus = "saved";
          if (ev.recordingId) data.recordingId = ev.recordingId;
          if (ev.recordingDurationMs !== undefined) data.recordingDurationMs = ev.recordingDurationMs;
          break;
        case "conference.joined":
          if (ev.conferenceId && !c.conferenceId) data.conferenceId = ev.conferenceId;
          if (c.direction === "inbound") {
            // Customer sits alone in the conference until the agent joins – not "talking" yet.
            data.status = forward(c.status, "ringing");
            break;
          }
          if (!c.answeredAt) data.answeredAt = now; // lead is in the conference with the agent = talking
          data.status = forward(c.status, "answered");
          break;
      }
    }

    const updated = await tx.call.update({ where: { id: c.id }, data });
    return { c: updated, action };
  });

  if (!outcome) return { duplicate: false, callId: call.id };

  // 4. Side effects outside the transaction.
  const telephony = getTelephony();
  if (outcome.action === "dial_lead") {
    await dialLeadLeg(outcome.c.id);
  } else if (outcome.action === "setup_inbound") {
    await setupInboundBridge(outcome.c.id);
  } else if (outcome.action === "hangup_lead" && outcome.c.leadLegId) {
    try {
      await telephony.hangupLeg(outcome.c.leadLegId, `${outcome.c.id}-hangup-lead`);
    } catch (err) {
      console.error("[events] hangup lead leg failed", err);
    }
  } else if (outcome.action === "finalized") {
    await afterCallFinalized(outcome.c.id);
  }
  if (outcome.c.hangupRequestedAt && !outcome.c.endedAt && ev.type !== "leg.hangup" && (leg === "agent" || leg === "lead")) {
    await telephony.hangupLeg(ev.legId, `${call.id}-hangup-${leg}`);
  }
  await prisma.telephonyEvent.update({
    where: { provider_providerEventId: { provider: ev.provider, providerEventId: ev.eventId } },
    data: { processedAt: new Date() },
  });

  return { duplicate: false, callId: call.id };
}

/** Dial the lead leg once the agent's browser leg is connected. Idempotent per call. */
export async function dialLeadLeg(callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { business: { select: { settings: true } } } });
  if (!call || call.endedAt || call.leadLegId || !call.agentLegId || call.hangupRequestedAt) return;
  const settings = await getBusinessSettings(call.businessId);
  const telephony = getTelephony();
  try {
    // The answered agent leg becomes the first participant of a conference so supervisors can join later.
    let conferenceId = call.conferenceId;
    if (!conferenceId) {
      conferenceId = await telephony.createConference(call.agentLegId, call.id, `${call.id}-conf`);
      await prisma.call.update({ where: { id: call.id }, data: { conferenceId } });
    }
    const r = await telephony.dialLead({
      callId: call.id,
      agentLegId: call.agentLegId,
      conferenceId,
      toE164: call.toE164,
      fromE164: call.fromE164,
      timeoutSeconds: settings.ringTimeoutSeconds,
      record: settings.recordingEnabled,
      amd: settings.amdEnabled,
    });
    await prisma.call.updateMany({ where: { id: call.id, endedAt: null, status: { in: ["created", "dialing_agent", "agent_connected"] } }, data: { status: "dialing_lead" } });
    await prisma.call.update({
      where: { id: call.id },
      data: {
        leadLegId: r.legId,
        leadDialedAt: new Date(),
        providerSessionId: r.providerSessionId ?? call.providerSessionId,
        ...(r.recordingId ? { recordingId: r.recordingId } : {}),
        dialPendingSince: null,
      },
    });
  } catch (err) {
    if (err instanceof TelephonyRequestTimeout) {
      // The provider may or may not have created the leg. Do NOT re-dial blindly:
      // reconciliation waits for a webhook, then retries with the same command_id.
      await prisma.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date() } });
      return;
    }
    console.error("[events] dial lead failed", err);
    await prisma.call.update({
      where: { id: call.id },
      data: { status: "failed", endedAt: new Date(), telephonyResult: "failed", failureReason: String((err as Error).message).slice(0, 300), activeForUser: null, talkSeconds: 0 },
    });
    await afterCallFinalized(call.id);
    try {
      await telephony.hangupLeg(call.agentLegId, `${call.id}-hangup-agent`);
    } catch {
      /* ignore */
    }
  }
}

/** Runs once a call reached a terminal state: tear down the agent leg, move the lead to wrap-up, update presence. */
export async function afterCallFinalized(callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return;
  await endMonitorsForCall(callId, "call_ended");
  const telephony = getTelephony();
  if (!telephony.simulation) {
    // Tear down whatever may still be alive at the provider (a leg that already ended returns 422 – ignored).
    for (const [leg, tag] of [[call.agentLegId, "agent"], [call.leadLegId, "lead"]] as const) {
      if (!leg) continue;
      try {
        await telephony.hangupLeg(leg, `${call.id}-hangup-${tag}`);
      } catch (err) {
        console.error(`[events] hangup ${tag} leg failed`, err);
      }
    }
  }
  const settings = await getBusinessSettings(call.businessId);
  await prisma.$transaction(async (tx) => {
    await lockAgent(tx, call.userId);
    const fresh = await tx.call.findUniqueOrThrow({ where: { id: callId } });
    if (fresh.outcomeSavedAt || !fresh.endedAt) return;
    const currentCall = fresh;
    // Technical failure policy: provider failed before the lead ever rang → no wrap-up needed,
    // the attempt is not counted and the lead returns to the queue after a short delay.
    const technicalFailure = currentCall.status === "failed" && !currentCall.ringingAt && !currentCall.answeredAt && !currentCall.outcomeSavedAt;
    if (technicalFailure) {
      await tx.call.update({ where: { id: currentCall.id }, data: { outcomeSavedAt: new Date(), outcomeNote: `כשל טכני: ${currentCall.failureReason ?? currentCall.hangupCause ?? "unknown"}` } });
      if (currentCall.leadId) {
        await tx.listLead.updateMany({
          where: { id: currentCall.leadId, lockedByUserId: currentCall.userId },
          data: { status: "pending", attempts: { decrement: 1 }, nextAttemptAt: new Date(Date.now() + settings.technicalFailureRetryMinutes * 60_000), lockedByUserId: null, lockToken: null, lockExpiresAt: null },
        });
      }
      await tx.user.updateMany({ where: { id: currentCall.userId, presence: "in_call" }, data: { presence: "available", presenceAt: new Date() } });
      const { audit } = await import("@/lib/audit");
      await audit(currentCall.businessId, null, "automation", currentCall.id, "automation.technical_failure_requeued", { trigger: "call.failed", leadId: currentCall.leadId, retryMinutes: settings.technicalFailureRetryMinutes, reason: currentCall.failureReason, result: "ok" }, tx);
      return;
    }
    if (currentCall.leadId) {
      // Keep the lead locked for wrap-up; the outcome save releases it.
      await tx.listLead.updateMany({
        where: { id: currentCall.leadId, status: "in_call", lockedByUserId: currentCall.userId },
        data: { status: "locked", lockExpiresAt: new Date(Date.now() + (settings.wrapUpSeconds + settings.lockTtlSeconds) * 1000) },
      });
    }
    await tx.user.updateMany({
      where: { id: currentCall.userId, presence: "in_call" },
      data: { presence: "wrap_up", presenceAt: new Date() },
    });
  });
}
