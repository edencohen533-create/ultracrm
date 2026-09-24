/**
 * Simulation adapter. No audio, no real calls. Every screen that shows a
 * simulated call must display the "מצב הדמיה" badge (see /api/telephony/status).
 *
 * The simulation is *time-driven*, not timer-driven, so it also works on
 * serverless hosts: `advanceMockCall()` is invoked by the call-state poll and
 * emits whichever events are due based on elapsed time. Events carry stable ids
 * so re-emitting them is harmless (the event processor de-duplicates).
 *
 * Outcome is chosen from the last digit of the dialed number, so QA can force
 * scenarios:  …0 → no answer,  …1 → busy,  …2 → rejected,  otherwise → answered.
 */
import { prisma } from "@/lib/db";
import type { DialAgentInput, DialLeadInput, DialResult, ProviderEvent, TelephonyAdapter } from "./types";

export const MOCK_TIMELINE = {
  inboundRingTimeoutMs: 25_000,
  agentAnswerMs: 700,
  leadInitiatedMs: 1_200,
  leadAnswerMs: 4_500,
  noAnswerHangupMs: 12_000,
  busyHangupMs: 2_500,
  rejectedHangupMs: 3_000,
};

export const mockAdapter: TelephonyAdapter = {
  name: "mock",
  simulation: true,

  async dialAgent(input: DialAgentInput): Promise<DialResult> {
    return { legId: `mock-agent-${input.callId}`, providerSessionId: `mock-session-${input.callId}` };
  },
  async dialLead(input: DialLeadInput): Promise<DialResult> {
    return {
      legId: `mock-lead-${input.callId}`,
      providerSessionId: `mock-session-${input.callId}`,
      recordingId: input.record ? `mock-rec-${input.callId}` : undefined,
    };
  },
  async hangupLeg(legId) {
    if (legId.startsWith("mock-supervisor-")) return; // the monitor service records the end (and audits it)
    // Record an explicit hangup request; advanceMockCall() turns it into a hangup event.
    const callId = legId.replace(/^mock-(agent|lead)-/, "");
    await prisma.call.updateMany({ where: { id: callId, endedAt: null, hangupRequestedAt: null }, data: { hangupRequestedAt: new Date() } });
  },
  async answerLeg() {
    /* no-op in simulation */
  },
  async createConference(legId, name) {
    return `mock-conf-${name}`;
  },
  async dialSupervisor(input) {
    return { legId: `mock-supervisor-${input.monitorId}`, providerSessionId: `mock-session-${input.callId}` };
  },
  async switchSupervisorRole() {
    /* no-op in simulation – role is tracked in the DB */
  },
  async sendDtmf() {
    /* no-op in simulation */
  },
  async isLegAlive(legId) {
    const callId = legId.replace(/^mock-(agent|lead)-/, "");
    const c = await prisma.call.findUnique({ where: { id: callId }, select: { endedAt: true } });
    return c ? c.endedAt === null : false;
  },
  async createBrowserToken(userId) {
    return { token: `mock-token-${userId}`, sipUsername: `mock-${userId.slice(-6)}`, expiresAt: new Date(Date.now() + 3600_000) };
  },
  async getRecordingDownloadUrl() {
    return null;
  },
};

/** Compute the mock events that are due for a call right now. */
export function dueMockEvents(call: {
  id: string;
  createdAt: Date;
  agentAnsweredAt: Date | null;
  leadLegId: string | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  toE164: string;
  hangupRequestedAt: Date | null;
  leadDialedAt?: Date | null;
  direction?: "outbound" | "inbound";
}): ProviderEvent[] {
  if (call.endedAt) return [];
  if (call.direction === "inbound") return dueInboundMockEvents(call);
  const now = Date.now();
  const t0 = call.createdAt.getTime();
  const events: ProviderEvent[] = [];
  const mk = (suffix: string, type: ProviderEvent["type"], leg: "agent" | "lead", extra: Partial<ProviderEvent> = {}): ProviderEvent => ({
    provider: "mock",
    eventId: `mock:${call.id}:${suffix}`,
    type,
    legId: `mock-${leg}-${call.id}`,
    callId: call.id,
    leg,
    occurredAt: new Date(),
    raw: { simulated: true },
    ...extra,
  });

  if (call.hangupRequestedAt && !call.leadLegId) return [mk("agent-hangup", "leg.hangup", "agent", { hangupCause: "originator_cancel", hangupSource: "caller" })];

  // 1. Agent leg answered (browser auto-answer)
  if (now - t0 >= MOCK_TIMELINE.agentAnswerMs) events.push(mk("agent-answered", "leg.answered", "agent"));

  // 2. Lead leg – only after the server actually "dialed" it (leadLegId set)
  if (call.leadLegId) {
    const tl = (call.leadDialedAt ?? call.createdAt).getTime();
    const last = call.toE164.slice(-1);
    if (now - tl >= MOCK_TIMELINE.leadInitiatedMs) events.push(mk("lead-initiated", "leg.initiated", "lead"));

    const hangupRequested = call.hangupRequestedAt !== null;
    if (hangupRequested) {
      events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: call.answeredAt ? "normal_clearing" : "originator_cancel", hangupSource: "caller" }));
      return events;
    }
    if (last === "0") {
      if (now - tl >= MOCK_TIMELINE.noAnswerHangupMs) events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: "timeout", hangupSource: "unknown" }));
    } else if (last === "1") {
      if (now - tl >= MOCK_TIMELINE.busyHangupMs) events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: "user_busy", hangupSource: "callee" }));
    } else if (last === "2") {
      if (now - tl >= MOCK_TIMELINE.rejectedHangupMs) events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: "call_rejected", hangupSource: "callee" }));
    } else if (now - tl >= MOCK_TIMELINE.leadAnswerMs) {
      events.push(mk("lead-answered", "leg.answered", "lead"));
      events.push(mk("lead-joined", "conference.joined", "lead", { conferenceId: `mock-conf-${call.id}` }));
    }
  }
  return events;
}

/**
 * Inbound simulation: the customer leg is "answered" immediately (we answer to bridge),
 * the agent leg rings in the browser until the agent accepts (agentAnsweredAt set by the
 * accept endpoint) or the ring timeout passes → customer hangs up (missed).
 */
function dueInboundMockEvents(call: { id: string; createdAt: Date; agentAnsweredAt: Date | null; answeredAt: Date | null; hangupRequestedAt: Date | null }): ProviderEvent[] {
  const now = Date.now();
  const mk = (suffix: string, type: ProviderEvent["type"], leg: "agent" | "lead", extra: Partial<ProviderEvent> = {}): ProviderEvent => ({
    provider: "mock", eventId: `mock:${call.id}:${suffix}`, type, legId: `mock-${leg}-${call.id}`, callId: call.id, leg, occurredAt: new Date(), raw: { simulated: true }, ...extra,
  });
  const events: ProviderEvent[] = [];
  // Provider confirms our answer of the customer leg almost immediately.
  if (now - call.createdAt.getTime() >= 300) events.push(mk("lead-answered", "leg.answered", "lead"));
  if (call.hangupRequestedAt) {
    events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: call.answeredAt ? "normal_clearing" : "originator_cancel", hangupSource: "caller" }));
    return events;
  }
  if (call.agentAnsweredAt) {
    events.push(mk("agent-joined", "conference.joined", "agent", { conferenceId: `mock-conf-${call.id}` }));
  } else if (now - call.createdAt.getTime() >= MOCK_TIMELINE.inboundRingTimeoutMs) {
    events.push(mk("lead-hangup", "leg.hangup", "lead", { hangupCause: "originator_cancel", hangupSource: "caller" }));
  }
  return events;
}
