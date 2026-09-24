/**
 * Inbound calls: a customer calls one of the business numbers.
 *  1. identify the business by the dialed number and the contact by normalized caller number
 *  2. pick an available agent (contact owner first), respecting pause/session state
 *  3. answer the customer leg and dial the agent's browser leg linked to it (bridge on answer)
 *  4. no agent → log a missed call, hang up, optionally create a callback task
 * Queues, IVR and voicemail are NOT implemented (Telnyx supports queues/voicemail via
 * separate features that require product decisions – see CAPABILITIES.md).
 */
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { getTelephony } from "@/lib/telephony";
import type { ProviderEvent } from "@/lib/telephony/types";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import { audit } from "@/lib/audit";

const AGENT_RING_SECONDS = 25;

export async function handleInboundInitiated(ev: ProviderEvent) {
  const toE164 = normalizePhone(ev.to ?? "") ?? ev.to ?? "";
  const numbers = await prisma.phoneNumber.findMany({ where: { e164: toE164, isActive: true }, include: { business: { select: { id: true, name: true } } }, take: 2 });
  // Never pick an arbitrary tenant when legacy data contains an ambiguous number.
  if (numbers.length > 1) {
    await getTelephony().hangupLeg(ev.legId, `ambiguous-number-${ev.legId}`);
    return null;
  }
  const number = numbers[0];
  if (!number) {
    console.warn("[inbound] unknown destination number", ev.to);
    return null;
  }
  const businessId = number.businessId;
  const telephony = getTelephony();
  const settings = await getBusinessSettings(businessId);
  const fromE164 = normalizePhone(ev.from ?? "") ?? null;
  const idempotencyKey = `inbound-${ev.provider}-${ev.legId}`;

  const existing = await prisma.call.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  // Contact (unknown numbers get a placeholder card so the history is kept)
  let contact = fromE164 ? await prisma.contact.findUnique({ where: { businessId_phoneE164: { businessId, phoneE164: fromE164 } } }) : null;
  if (!contact && fromE164) {
    contact = await prisma.contact.create({ data: { businessId, fullName: "מתקשר לא מזוהה", phoneE164: fromE164, phoneRaw: ev.from ?? fromE164, source: "inbound" } });
  }

  // Business hours
  if (settings.inbound.respectDialWindow && !isWithinDialWindow(settings.dialWindow)) {
    return missed(businessId, number.e164, fromE164, contact?.id ?? null, ev, "outside_business_hours", settings.inbound.createCallbackTask);
  }

  // Agent selection: owner first (if available), then any available agent of the business.
  const candidates = await prisma.user.findMany({
    where: { businessId, isActive: true, presence: "available", lastSeenAt: { gte: new Date(Date.now() - 75_000) }, role: { in: ["agent", "manager"] }, sipUsername: { not: null } },
    select: { id: true, sipUsername: true, fullName: true, role: true },
  });
  const liveUsers = new Set((await prisma.call.findMany({ where: { businessId, endedAt: null }, select: { userId: true } })).map((c) => c.userId));
  // "Available for work" = has a live (not paused) dialer session and no call. Presence alone is not enough:
  // a manager who merely ended a manual call must not receive customers' inbound calls.
  const working = new Set((await prisma.dialerSession.findMany({ where: { businessId, status: "active", lastHeartbeatAt: { gte: new Date(Date.now() - 75_000) } }, select: { userId: true } })).map((s) => s.userId));
  const wrapping = new Set((await prisma.call.findMany({ where: { businessId, endedAt: { not: null }, outcomeSavedAt: null }, select: { userId: true } })).map(c => c.userId));
  const free = candidates.filter((u) => working.has(u.id) && !liveUsers.has(u.id) && !wrapping.has(u.id));
  const owner = settings.inbound.preferOwner && contact?.ownerUserId ? free.find((u) => u.id === contact!.ownerUserId) : undefined;
  // Agents before managers; managers only take inbound calls when no agent is free.
  const agent = owner ?? free.find((u) => u.role === "agent") ?? free[0];
  if (!agent) {
    return missed(businessId, number.e164, fromE164, contact?.id ?? null, ev, "no_agent_available", settings.inbound.createCallbackTask);
  }

  // Create the call record; activeForUser guarantees the agent has no other live call (race-safe).
  let call;
  try {
    call = await prisma.call.create({
      data: {
        businessId,
        userId: agent.id,
        contactId: contact?.id,
        mode: "manual",
        direction: "inbound",
        provider: ev.provider,
        idempotencyKey,
        activeForUser: agent.id,
        toE164: fromE164 ?? (ev.from ?? "unknown"),
        fromE164: number.e164,
        phoneNumberId: number.id,
        status: "ringing",
        leadLegId: ev.legId,
        ringingAt: new Date(),
        leadDialedAt: new Date(),
        routingNote: owner ? "routed_to_owner" : "routed_to_available_agent",
        lastEventAt: new Date(),
      },
    });
  } catch {
    // Lost a race for this agent – treat as missed for now (queues are a separate feature).
    return missed(businessId, number.e164, fromE164, contact?.id ?? null, ev, "agent_became_busy", settings.inbound.createCallbackTask);
  }
  await prisma.user.update({ where: { id: agent.id }, data: { presence: "in_call", presenceAt: new Date() } });

  try {
    // Answer the customer leg. The conference + agent leg are set up when the provider
    // confirms the answer (call.answered webhook) – see setupInboundBridge().
    await telephony.answerLeg(ev.legId, `${call.id}-answer-inbound`);
  } catch (err) {
    console.error("[inbound] answer failed", err);
    await prisma.call.update({ where: { id: call.id }, data: { status: "failed", endedAt: new Date(), telephonyResult: "failed", failureReason: String((err as Error).message).slice(0, 200), activeForUser: null, talkSeconds: 0 } });
    await prisma.user.updateMany({ where: { id: agent.id, presence: "in_call" }, data: { presence: "available" } });
    try {
      await telephony.hangupLeg(ev.legId, `${call.id}-hangup-inbound`);
    } catch {
      /* ignore */
    }
  }
  await audit(businessId, null, "call", call.id, "inbound.routed", { to: agent.id, owner: Boolean(owner), from: fromE164 });
  return call;
}

async function missed(businessId: string, businessNumber: string, fromE164: string | null, contactId: string | null, ev: ProviderEvent, reason: string, createTask: boolean) {
  const telephony = getTelephony();
  // Assign the record to the contact owner or the first manager so it is visible somewhere.
  const owner = contactId ? (await prisma.contact.findUnique({ where: { id: contactId }, select: { ownerUserId: true } }))?.ownerUserId : null;
  const fallback = owner ?? (await prisma.user.findFirst({ where: { businessId, isActive: true, role: { in: ["manager", "admin"] } }, select: { id: true } }))?.id;
  if (!fallback) return null;
  const call = await prisma.call.create({
    data: {
      businessId,
      userId: fallback,
      contactId,
      mode: "manual",
      direction: "inbound",
      provider: ev.provider,
      idempotencyKey: `inbound-${ev.provider}-${ev.legId}`,
      toE164: fromE164 ?? (ev.from ?? "unknown"),
      fromE164: businessNumber,
      status: "ended",
      telephonyResult: "no_answer",
      leadLegId: ev.legId,
      ringingAt: new Date(),
      endedAt: new Date(),
      talkSeconds: 0,
      outcomeSavedAt: new Date(),
      outcomeNote: "שיחה נכנסת שלא נענתה",
      routingNote: reason,
      hangupRequestedAt: new Date(),
    },
  });
  try {
    await telephony.hangupLeg(ev.legId, `${call.id}-hangup-missed`);
  } catch {
    /* ignore */
  }
  if (createTask && contactId) {
    await prisma.task.create({ data: { businessId, userId: fallback, contactId, callId: call.id, type: "callback", dueAt: new Date(Date.now() + 15 * 60_000), note: `חזרה ללקוח שהתקשר ולא נענה (${reason})` } });
  }
  await audit(businessId, null, "call", call.id, "inbound.missed", { reason, from: fromE164, taskCreated: createTask && Boolean(contactId) });
  return call;
}

/**
 * Customer leg confirmed answered → create the conference around it and ring the agent's browser into it.
 * Idempotent per call (conferenceId / agentLegId guard).
 */
export async function setupInboundBridge(callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { user: { select: { sipUsername: true } }, contact: { select: { fullName: true } } } });
  if (!call || call.direction !== "inbound" || call.endedAt || call.agentLegId || !call.leadLegId) return;
  const telephony = getTelephony();
  try {
    const conferenceId = call.conferenceId ?? (await telephony.createConference(call.leadLegId, call.id, `${call.id}-conf`));
    if (!call.conferenceId) await prisma.call.update({ where: { id: call.id }, data: { conferenceId } });
    const sipUsername = call.user.sipUsername ?? (telephony.simulation ? `mock-${call.userId.slice(-6)}` : null);
    if (!sipUsername) throw new Error("agent browser not registered");
    const r = await telephony.dialAgent({
      callId: call.id,
      sipUsername,
      fromE164: call.toE164,
      timeoutSeconds: AGENT_RING_SECONDS,
      conferenceId,
      callerDisplay: call.contact?.fullName ?? call.toE164,
    });
    await prisma.call.update({ where: { id: call.id }, data: { agentLegId: r.legId, providerSessionId: r.providerSessionId ?? call.providerSessionId, lastEventAt: new Date() } });
  } catch (err) {
    console.error("[inbound] bridge setup failed", err);
    await prisma.call.update({ where: { id: call.id }, data: { status: "failed", endedAt: new Date(), telephonyResult: "failed", failureReason: String((err as Error).message).slice(0, 200), activeForUser: null, talkSeconds: 0 } });
    await prisma.user.updateMany({ where: { id: call.userId, presence: "in_call" }, data: { presence: "available" } });
    try {
      await telephony.hangupLeg(call.leadLegId, `${call.id}-hangup-inbound`);
    } catch {
      /* ignore */
    }
  }
}

/** Agent accepted the inbound call in the browser (simulation marks the agent leg answered). */
export async function acceptInbound(userId: string, callId: string) {
  const call = await prisma.call.findFirst({ where: { id: callId, userId, direction: "inbound" } });
  if (!call || call.endedAt) return call;
  if (getTelephony().simulation && !call.agentAnsweredAt) {
    await prisma.call.update({ where: { id: callId }, data: { agentAnsweredAt: new Date(), status: "agent_connected" } });
  }
  await audit(call.businessId, userId, "call", callId, "inbound.accepted");
  return prisma.call.findUnique({ where: { id: callId } });
}
