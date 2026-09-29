import { ApiError } from "@/lib/response";
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
  businessId?: string;
  /** Callback providers need the customer's number in the first (and only) request. */
  toE164?: string;
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

/** What a provider can do. Routing and the UI never assume two providers are interchangeable. */
export interface ProviderCapabilities {
  outboundDial: boolean;
  inboundCalls: boolean;
  /** Conference bridging (agent leg + customer leg + supervisors). */
  conference: boolean;
  supervisorMonitor: boolean;
  recording: boolean;
  answeringMachineDetection: boolean;
  dtmf: boolean;
  /** How the agent's browser gets audio. A provider whose client is not implemented cannot carry real calls. */
  agentClient: "telnyx-webrtc" | "zadarma-widget" | "sip-websocket" | "simulation" | "none";
  /**
   * agent_then_lead: we dial the agent leg, then (on answer) the customer into a conference – full server control.
   * callback: ONE provider request rings the agent's extension, then the provider dials the customer itself; no
   * conference, and the server cannot act on the live call.
   */
  dialModel: "agent_then_lead" | "callback";
  /** Can the server hang up a live call? If not, the agent hangs up in the provider's phone. */
  serverHangup: boolean;
  /** Can we find a leg by our own reference after a dial request timed out (reconciliation)? */
  legLookupByReference: boolean;
}

export interface ProviderConfigStatus {
  configured: boolean;
  missing: string[];
  /** Non-secret account reference (e.g. Call Control App id) stored on attempts. */
  accountRef: string | null;
}

export interface ProviderCheck { name: string; ok: boolean; detail?: string }

export interface TelephonyAdapter {
  name: ProviderName;
  /** True when this adapter only simulates calls (must be shown clearly in the UI). */
  simulation: boolean;
  /** Test-only adapters are never eligible for real routing. */
  testOnly?: boolean;
  capabilities: ProviderCapabilities;
  configStatus(): ProviderConfigStatus;
  /** Read-only configuration check against the provider account (no paid actions). */
  verifyConfig(businessId?: string): Promise<ProviderCheck[]>;
  /** Per-business account (credentials, caller ID, extensions, live test). Absent = platform-level account. */
  businessReadiness?(businessId: string): Promise<{ ready: boolean; reason: string }>;
  /** The agent's address at this provider (SIP username), or null when the agent never registered with it. */
  agentAddress(userId: string): Promise<string | null>;
  /** After a timed-out dial: find a live leg carrying our reference. `null` = could not check. */
  findLegByReference(ref: { callId: string; leg: "agent" | "lead" | "supervisor" }): Promise<{ legId: string } | "none" | null>;
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
  switchSupervisorRole(legId: string, role: "monitor" | "whisper" | "barge"): Promise<void>;
  sendDtmf(legId: string, digits: string, commandId: string): Promise<void>;
  /** Is the leg still alive at the provider? `null` = unknown (provider unreachable). */
  isLegAlive(legId: string): Promise<boolean | null>;
  /** Short-lived browser login token for the WebRTC SDK. */
  createBrowserToken(userId: string): Promise<{ token: string; sipUsername: string; expiresAt: Date }>;
  /** Resolve a temporary download URL for a saved recording. */
  getRecordingDownloadUrl(recordingId: string): Promise<{ url: string; contentType: string } | null>;
  /** Webhooks: signature check on the raw body (timestamp / replay window included) and payload → normalized event. */
  verifyWebhook?(rawBody: string, headers: Headers): boolean;
  parseWebhook?(body: unknown): ProviderEvent | null;
  /** Delete a recording at the provider (retention). True when gone (also when it no longer existed). */
  deleteRecording(recordingId: string): Promise<boolean>;
}

export class TelephonyRequestTimeout extends Error {
  constructor(message = "telephony request timed out") {
    super(message);
    this.name = "TelephonyRequestTimeout";
  }
}

export type FailureClass = "provider_outage" | "account" | "rate_limit" | "auth" | "invalid_request" | "timeout" | "capacity" | "unknown";

/** The provider cannot do this at all – the action is refused with a reason, never reported as done. */
export class TelephonyUnsupportedError extends ApiError {
  constructor(message: string, readonly capability: string) {
    super(message, 409, "provider_capability_missing", { capability });
    this.name = "TelephonyUnsupportedError";
  }
}

/** A provider API error with its classification (status stays 502 for API callers, as before). */
export class TelephonyProviderError extends ApiError {
  constructor(message: string, readonly httpStatus: number | null, readonly failureClass: FailureClass, readonly retryAfterSeconds: number | null = null, code = "telephony_provider_error") {
    super(message, 502, code);
    this.name = "TelephonyProviderError";
  }
}
