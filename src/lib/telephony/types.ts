import type { TelephonyProvider as ProviderName } from "@/generated/prisma/enums";

/** Normalized provider event, independent of vendor payload shape. */
export interface ProviderEvent {
  provider: ProviderName;
  /** Vendor event id – used for de-duplication. */
  eventId: string;
  type:
    | "leg.initiated"
    | "leg.answered"
    | "leg.bridged"
    | "leg.hangup"
    | "leg.machine_detection"
    | "recording.saved"
    | "conference.joined"
    | "conference.left"
    | "other";
  legId: string;
  /** Our call id, when the vendor echoed it back (client_state). */
  callId?: string;
  leg?: "agent" | "lead" | "supervisor";
  /** Set on supervisor-leg events (client_state). */
  monitorId?: string;
  conferenceId?: string;
  /** Provider-reported direction of the leg (inbound routing uses "incoming"). */
  direction?: "incoming" | "outgoing";
  from?: string;
  to?: string;
  occurredAt?: Date;
  hangupCause?: string;
  hangupSource?: string;
  amdResult?: string;
  recordingId?: string;
  recordingDurationMs?: number;
  raw: unknown;
}

export interface DialAgentInput {
  callId: string;
  sipUsername: string;
  fromE164: string;
  timeoutSeconds: number;
  /** Inbound: join this provider conference on answer (customer leg already inside). */
  conferenceId?: string;
  /** Shown on the agent's device for inbound calls. */
  callerDisplay?: string;
}

export interface DialLeadInput {
  callId: string;
  agentLegId: string;
  /** Conference hosting the agent leg; the lead joins it on answer. */
  conferenceId: string;
  toE164: string;
  fromE164: string;
  timeoutSeconds: number;
  record: boolean;
  amd: boolean;
}

export interface DialResult {
  legId: string;
  providerSessionId?: string;
  recordingId?: string;
}

export interface TelephonyAdapter {
  name: ProviderName;
  /** True when this adapter only simulates calls (must be shown clearly in the UI). */
  simulation: boolean;
  dialAgent(input: DialAgentInput): Promise<DialResult>;
  dialLead(input: DialLeadInput): Promise<DialResult>;
  hangupLeg(legId: string, commandId: string): Promise<void>;
  /** Answer an inbound leg (needed before bridging). */
  answerLeg(legId: string, commandId: string): Promise<void>;
  /** Create a provider conference with this (answered) leg as first participant. Returns the conference id. */
  createConference(legId: string, name: string, commandId: string): Promise<string>;
  /** Dial a supervisor's browser leg straight into the conference as a listen-only participant able to whisper to `whisperToLegId`. */
  dialSupervisor(input: { monitorId: string; callId: string; sipUsername: string; fromE164: string; conferenceId: string; whisperToLegId: string; timeoutSeconds: number }): Promise<DialResult>;
  /** Switch the supervisor leg between listen-only and whisper (enforced at the provider). */
  switchSupervisorRole(legId: string, role: "monitor" | "whisper"): Promise<void>;
  sendDtmf(legId: string, digits: string, commandId: string): Promise<void>;
  /** Is the leg still alive at the provider? `null` = unknown (provider unreachable). */
  isLegAlive(legId: string): Promise<boolean | null>;
  /** Short-lived browser login token for the WebRTC SDK. */
  createBrowserToken(userId: string): Promise<{ token: string; sipUsername: string; expiresAt: Date }>;
  /** Resolve a temporary download URL for a saved recording. */
  getRecordingDownloadUrl(recordingId: string): Promise<{ url: string; contentType: string } | null>;
}

export class TelephonyRequestTimeout extends Error {
  constructor(message = "telephony request timed out") {
    super(message);
    this.name = "TelephonyRequestTimeout";
  }
}
