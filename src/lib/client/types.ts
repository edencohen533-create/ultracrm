export type DialMode = "manual" | "preview" | "power";
export type OutcomeKey = "answered_interested" | "answered_not_interested" | "callback" | "no_answer" | "busy" | "wrong_number" | "sale" | "dnc";

export interface ContactLite {
  id: string;
  fullName: string;
  phoneE164: string;
  phoneRaw?: string;
  email?: string | null;
  company?: string | null;
  city?: string | null;
  source?: string | null;
  notes?: string | null;
  ownerUserId?: string | null;
  customFields?: Record<string, unknown> | null;
  tags?: string[];
  createdAt?: string;
}

export interface LeadDto {
  id: string;
  listId: string;
  contactId: string;
  status: string;
  priority: number;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastOutcome: OutcomeKey | null;
  lastSkipReason: string | null;
  lockToken: string | null;
  lockExpiresAt: string | null;
  claimReason: string | null;
  claimScore: number | null;
  contact: ContactLite;
  list: { id: string; name: string; scriptId: string | null };
}

export interface CallDto {
  id: string;
  mode: DialMode;
  direction: "outbound" | "inbound";
  routingNote: string | null;
  amdResult: string | null;
  provider: "mock" | "telnyx";
  status: "created" | "dialing_agent" | "agent_connected" | "dialing_lead" | "ringing" | "answered" | "ended" | "failed";
  telephonyResult: "answered" | "no_answer" | "busy" | "failed" | "cancelled" | "rejected" | null;
  toE164: string;
  fromE164: string;
  leadId: string | null;
  contactId: string | null;
  createdAt: string;
  agentAnsweredAt: string | null;
  ringingAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  talkSeconds: number | null;
  outcome: OutcomeKey | null;
  outcomeNote: string | null;
  outcomeSavedAt: string | null;
  callbackAt: string | null;
  hangupCause: string | null;
  failureReason: string | null;
  recordingStatus: "none" | "recording" | "saved" | "failed";
  dialPendingSince: string | null;
  contact: { id: string; fullName: string; phoneE164: string; company: string | null } | null;
  lead: { id: string; listId: string; lockToken: string | null; attempts: number; status: string } | null;
  phoneNumber: { id: string; e164: string; label: string | null } | null;
}

export interface SessionDto {
  id: string;
  mode: DialMode;
  status: "active" | "paused" | "ended";
  listId: string | null;
  browserSessionId: string;
  countdownSeconds: number;
  startedAt: string;
  dialsCount: number;
  list: { id: string; name: string; scriptId: string | null } | null;
  ownedByThisTab: boolean | null;
}

export interface TelephonyStatus {
  provider: "mock" | "telnyx";
  simulation: boolean;
  requested: string;
  telnyx: { configured: boolean; missing: string[] };
}

export interface MonitorDto {
  id: string;
  callId: string;
  managerId: string;
  mode: "listen" | "whisper";
  status: "connecting" | "listening" | "whispering" | "ended" | "failed";
  legId: string | null;
  error: string | null;
  startedAt: string;
  joinedAt: string | null;
  endedAt: string | null;
  call?: { id: string; userId: string; endedAt: string | null; answeredAt: string | null; talkSeconds?: number | null; toE164: string; direction: string; contactId: string | null; contact: { fullName: string } | null; user: { fullName: string } };
}

export interface DialerStateDto {
  now: string;
  session: SessionDto | null;
  lead: LeadDto | null;
  activeCall: CallDto | null;
  wrapUpCall: CallDto | null;
  monitor: MonitorDto | null;
  presence: string;
  sipUsername: string | null;
  queue: { byStatus: Record<string, number>; dueNow: number; dueIgnoringWindow: number; total: number; unavailable: { notDueYet: number; inProgress: number; exhausted: number; completed: number; dnc: number; removed: number; outsideDialWindow: boolean; listPaused: boolean; listInactive: boolean } } | null;
  script: { id: string; title: string; body: string } | null;
  draft: string | null;
  settings: { wrapUpSeconds: number; autoDialCountdownSeconds: number; lockTtlSeconds: number; dialWindow: { start: string; end: string; days: number[] } };
  telephony: TelephonyStatus;
}
