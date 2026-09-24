import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export interface DialWindow {
  start: string; // "09:00"
  end: string; // "20:00"
  days: number[]; // 0 = Sunday … 6 = Saturday
  timezone?: string;
}

/**
 * Transparent lead prioritization. Every weight is visible to the manager and
 * every served lead carries a short explanation of which factors applied.
 * score = Σ(factor × weight); higher = served first.
 */
export interface PrioritizationWeights {
  /** Callback whose time has come (per lead, once). */
  callbackDue: number;
  /** Per point of list-lead priority (0–100). */
  priority: number;
  /** Per hour since creation for leads never attempted, capped at newLeadMaxHours. */
  newLeadPerHour: number;
  newLeadMaxHours: number;
  /** Per hour waiting since the last attempt (or creation) – prevents starvation. */
  agingPerHour: number;
  agingMaxHours: number;
  /** Subtracted per previous attempt. */
  attemptPenalty: number;
  /** Bonus when the contact's owner is the agent pulling. */
  ownerMatch: number;
  /** Per-source bonus, e.g. { facebook: 10 }. */
  sourceWeights: Record<string, number>;
  /** Bonus when the last outcome was "answered_interested" (re-engage). */
  interestedBefore: number;
}

export interface BusinessSettings {
  wrapUpSeconds: number;
  autoDialCountdownSeconds: number;
  maxAttempts: number;
  retryIntervalMinutes: number;
  busyRetryMinutes: number;
  /** Technical failure (provider error before ringing): re-queue after this many minutes, attempt not counted. */
  technicalFailureRetryMinutes: number;
  lockTtlSeconds: number;
  ringTimeoutSeconds: number;
  recordingEnabled: boolean;
  recordingAnnouncement: string;
  /** Days to keep provider recordings; 0 = keep forever. */
  recordingRetentionDays: number;
  /** Answering-machine detection (advisory only – never auto-hangs up). */
  amdEnabled: boolean;
  dialWindow: DialWindow;
  prioritization: PrioritizationWeights;
  /** Keep a lead with the agent who last worked it (retry outcomes). */
  stickyOwner: boolean;
  /** On "sale": close the contact's pending leads in every other list of the business. */
  removeFromOtherListsOnSale: boolean;
  /** Kill switch: no new outbound dials for the whole business. */
  dialingPaused: boolean;
  /** ISO 3166-1 alpha-2 codes allowed as destinations; empty = any. */
  allowedCountries: string[];
  /** Per-agent outbound dial rate limit. 0 = unlimited. */
  maxDialsPerMinute: number;
  inbound: {
    /** Route to the contact's owner first when they are available. */
    preferOwner: boolean;
    /** What to do when no agent is available: hangup | voicemail_unsupported. */
    noAgentAction: "hangup";
    /** Create a callback task for missed inbound calls. */
    createCallbackTask: boolean;
    /** Only accept inbound calls inside the dial window. */
    respectDialWindow: boolean;
  };
}

export const DEFAULT_PRIORITIZATION: PrioritizationWeights = {
  callbackDue: 100,
  priority: 1,
  newLeadPerHour: 1,
  newLeadMaxHours: 48,
  agingPerHour: 0.25,
  agingMaxHours: 240,
  attemptPenalty: 8,
  ownerMatch: 15,
  sourceWeights: {},
  interestedBefore: 20,
};

export const DEFAULT_SETTINGS: BusinessSettings = {
  wrapUpSeconds: 60,
  autoDialCountdownSeconds: 5,
  maxAttempts: 3,
  retryIntervalMinutes: 120,
  busyRetryMinutes: 15,
  technicalFailureRetryMinutes: 10,
  lockTtlSeconds: 90,
  ringTimeoutSeconds: 30,
  recordingEnabled: false,
  recordingAnnouncement: "",
  recordingRetentionDays: 0,
  amdEnabled: false,
  dialWindow: { start: "09:00", end: "20:00", days: [0, 1, 2, 3, 4], timezone: "Asia/Jerusalem" },
  prioritization: DEFAULT_PRIORITIZATION,
  stickyOwner: false,
  removeFromOtherListsOnSale: true,
  dialingPaused: false,
  allowedCountries: ["IL"],
  maxDialsPerMinute: 0,
  inbound: { preferOwner: true, noAgentAction: "hangup", createCallbackTask: true, respectDialWindow: false },
};

export function mergeSettings(raw: unknown): BusinessSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BusinessSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    dialWindow: { ...DEFAULT_SETTINGS.dialWindow, ...(r.dialWindow ?? {}) },
    prioritization: { ...DEFAULT_PRIORITIZATION, ...(r.prioritization ?? {}), sourceWeights: { ...(r.prioritization?.sourceWeights ?? {}) } },
    inbound: { ...DEFAULT_SETTINGS.inbound, ...(r.inbound ?? {}) },
    allowedCountries: Array.isArray(r.allowedCountries) ? r.allowedCountries : DEFAULT_SETTINGS.allowedCountries,
  };
}

export async function getBusinessSettings(businessId: string, db: Prisma.TransactionClient = prisma): Promise<BusinessSettings & { timezone: string }> {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { settings: true, timezone: true } });
  const s = mergeSettings(b?.settings);
  return { ...s, timezone: b?.timezone ?? "Asia/Jerusalem", dialWindow: { ...s.dialWindow, timezone: s.dialWindow.timezone ?? b?.timezone } };
}

/** Is `now` inside the dial window (evaluated in the window's timezone)? */
export function isWithinDialWindow(window: DialWindow, now = new Date()): boolean {
  const tz = window.timezone ?? "Asia/Jerusalem";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  if (!window.days.includes(dayIdx)) return false;
  const cur = hour * 60 + minute;
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  return cur >= sh * 60 + sm && cur < eh * 60 + em;
}

/** Next moment the dial window opens (scans forward minute by minute, up to 8 days). */
export function nextDialWindowOpening(window: DialWindow, from = new Date()): Date | null {
  const step = 60 * 1000;
  const start = Math.floor(from.getTime() / step) * step;
  for (let t = start; t < start + 8 * 24 * 3600 * 1000; t += step) {
    const d = new Date(t);
    if (isWithinDialWindow(window, d)) return d;
  }
  return null;
}
