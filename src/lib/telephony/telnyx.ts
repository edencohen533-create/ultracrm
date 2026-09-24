/**
 * Telnyx adapter – Call Control API v2 + WebRTC credential tokens.
 *
 * Verified against the official OpenAPI spec (api.telnyx.com/v2):
 *   POST /calls                                   (Dial; command_id de-duplicates within 60s)
 *   POST /calls/{ccid}/actions/hangup
 *   POST /calls/{ccid}/actions/send_dtmf
 *   GET  /calls/{ccid}                            (is_alive)
 *   POST /telephony_credentials                   (create per-agent SIP credential)
 *   POST /telephony_credentials/{id}/token        (text/plain JWT, 24h)
 *   GET  /recordings/{id}                         (download_urls.mp3 / .wav)
 * Webhooks are signed with Ed25519: message = `${telnyx-timestamp}|${rawBody}`.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { DialAgentInput, DialLeadInput, DialResult, ProviderEvent, TelephonyAdapter } from "./types";
import { TelephonyRequestTimeout } from "./types";

const BASE = "https://api.telnyx.com/v2";
const REQUEST_TIMEOUT_MS = 10_000;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ApiError(`חסר משתנה סביבה ${name} – ראה הגדרות Telnyx`, 500, "telnyx_not_configured");
  return v;
}

export function telnyxConfigStatus() {
  const keys = ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "TELNYX_CALL_CONTROL_APP_ID", "TELNYX_CREDENTIAL_CONNECTION_ID"];
  const missing = keys.filter((k) => !process.env[k]);
  return { configured: missing.length === 0, missing };
}

async function telnyxFetch<T>(path: string, init: RequestInit & { rawText?: boolean } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env("TELNYX_API_KEY")}`,
        "Content-Type": "application/json",
        Accept: init.rawText ? "text/plain" : "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.errors?.map((e: { title?: string; detail?: string }) => `${e.title ?? ""} ${e.detail ?? ""}`).join("; ") ?? text;
      } catch {
        /* keep text */
      }
      throw new ApiError(`Telnyx ${res.status}: ${detail}`.slice(0, 500), 502, "telnyx_error");
    }
    if (init.rawText) return text as unknown as T;
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new TelephonyRequestTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function encodeClientState(obj: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeClientState(s?: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

interface DialResponse {
  data: { call_control_id: string; call_leg_id: string; call_session_id: string; is_alive: boolean; recording_id?: string };
}

export const telnyxAdapter: TelephonyAdapter = {
  name: "telnyx",
  simulation: false,

  async dialAgent(input: DialAgentInput): Promise<DialResult> {
    const body: Record<string, unknown> = {
      connection_id: env("TELNYX_CALL_CONTROL_APP_ID"),
      to: `sip:${input.sipUsername}@sip.telnyx.com`,
      from: input.fromE164,
      from_display_name: (input.callerDisplay ?? "Dialer").slice(0, 60),
      timeout_secs: input.timeoutSeconds,
      client_state: encodeClientState({ callId: input.callId, leg: "agent" }),
      command_id: `${input.callId}-agent`,
    };
    if (input.conferenceId) {
      body.conference_config = { id: input.conferenceId, start_conference_on_enter: true, end_conference_on_exit: true, beep_enabled: "never" };
    }
    const r = await telnyxFetch<DialResponse>("/calls", { method: "POST", body: JSON.stringify(body) });
    return { legId: r.data.call_control_id, providerSessionId: r.data.call_session_id };
  },

  async answerLeg(legId, commandId) {
    await telnyxFetch(`/calls/${encodeURIComponent(legId)}/actions/answer`, { method: "POST", body: JSON.stringify({ command_id: commandId }) });
  },

  async createConference(legId, name, commandId) {
    const r = await telnyxFetch<{ data: { id: string } }>("/conferences", {
      method: "POST",
      body: JSON.stringify({ call_control_id: legId, name, start_conference_on_create: true, beep_enabled: "never", comfort_noise: true, command_id: commandId }),
    });
    return r.data.id;
  },

  async dialSupervisor(input) {
    const r = await telnyxFetch<DialResponse>("/calls", {
      method: "POST",
      body: JSON.stringify({
        connection_id: env("TELNYX_CALL_CONTROL_APP_ID"),
        to: `sip:${input.sipUsername}@sip.telnyx.com`,
        from: input.fromE164,
        from_display_name: "Supervisor",
        timeout_secs: input.timeoutSeconds,
        client_state: encodeClientState({ callId: input.callId, leg: "supervisor", monitorId: input.monitorId }),
        command_id: `${input.monitorId}-supervisor`,
        // Joins as a monitoring supervisor: hears everyone, is heard by no one. Whisper target pre-registered.
        conference_config: { id: input.conferenceId, supervisor_role: "monitor", whisper_call_control_ids: [input.whisperToLegId], beep_enabled: "never", end_conference_on_exit: false, soft_end_conference_on_exit: false },
      }),
    });
    return { legId: r.data.call_control_id, providerSessionId: r.data.call_session_id };
  },

  async switchSupervisorRole(legId, role) {
    await telnyxFetch(`/calls/${encodeURIComponent(legId)}/actions/switch_supervisor_role`, { method: "POST", body: JSON.stringify({ role }) });
  },

  async dialLead(input: DialLeadInput): Promise<DialResult> {
    const body: Record<string, unknown> = {
      connection_id: env("TELNYX_CALL_CONTROL_APP_ID"),
      to: input.toE164,
      from: input.fromE164,
      timeout_secs: input.timeoutSeconds,
      // The agent leg already sits in a conference; the lead joins it on answer (supervisors can join the same conference).
      conference_config: { id: input.conferenceId, start_conference_on_enter: true, end_conference_on_exit: true, beep_enabled: "never" },
      client_state: encodeClientState({ callId: input.callId, leg: "lead" }),
      command_id: `${input.callId}-lead`,
    };
    if (input.record) {
      body.record = "record-from-answer";
      body.record_channels = "dual";
      body.record_format = "mp3";
    }
    if (input.amd) body.answering_machine_detection = "detect";
    const r = await telnyxFetch<DialResponse>("/calls", { method: "POST", body: JSON.stringify(body) });
    return { legId: r.data.call_control_id, providerSessionId: r.data.call_session_id, recordingId: r.data.recording_id };
  },

  async hangupLeg(legId, commandId) {
    try {
      await telnyxFetch(`/calls/${encodeURIComponent(legId)}/actions/hangup`, {
        method: "POST",
        body: JSON.stringify({ command_id: commandId }),
      });
    } catch (err) {
      // A leg that already ended returns 422 – that's fine for a hangup.
      if (err instanceof ApiError && /422|not found|invalid/i.test(err.message)) return;
      throw err;
    }
  },

  async sendDtmf(legId, digits, commandId) {
    await telnyxFetch(`/calls/${encodeURIComponent(legId)}/actions/send_dtmf`, {
      method: "POST",
      body: JSON.stringify({ digits, command_id: commandId }),
    });
  },

  async isLegAlive(legId) {
    try {
      const r = await telnyxFetch<{ data: { is_alive: boolean } }>(`/calls/${encodeURIComponent(legId)}`);
      return Boolean(r.data?.is_alive);
    } catch (err) {
      if (err instanceof ApiError && /404/.test(err.message)) return false;
      return null;
    }
  },

  async createBrowserToken(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { telnyxCredentialId: true, sipUsername: true, fullName: true, businessId: true } });
    if (!user) throw new ApiError("משתמש לא נמצא", 404);
    let credentialId = user.telnyxCredentialId;
    let sipUsername = user.sipUsername;
    if (!credentialId || !sipUsername) {
      const r = await telnyxFetch<{ data: { id: string; sip_username: string } }>("/telephony_credentials", {
        method: "POST",
        body: JSON.stringify({
          connection_id: env("TELNYX_CREDENTIAL_CONNECTION_ID"),
          name: `dialer-${userId}`,
          tag: `business-${user.businessId}`,
        }),
      });
      credentialId = r.data.id;
      sipUsername = r.data.sip_username;
      await prisma.user.update({ where: { id: userId }, data: { telnyxCredentialId: credentialId, sipUsername } });
    }
    const token = await telnyxFetch<string>(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`, {
      method: "POST",
      rawText: true,
    });
    // Telnyx tokens are valid for 24h; we re-fetch well before that.
    return { token: token.trim(), sipUsername, expiresAt: new Date(Date.now() + 23 * 3600 * 1000) };
  },

  async getRecordingDownloadUrl(recordingId) {
    const r = await telnyxFetch<{ data: { download_urls?: { mp3?: string; wav?: string }; status?: string } }>(
      `/recordings/${encodeURIComponent(recordingId)}`,
    );
    const urls = r.data?.download_urls ?? {};
    if (urls.mp3) return { url: urls.mp3, contentType: "audio/mpeg" };
    if (urls.wav) return { url: urls.wav, contentType: "audio/wav" };
    return null;
  },
};

// ─── Webhook verification & parsing ─────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyTelnyxSignature(rawBody: string, signatureB64: string | null, timestamp: string | null, toleranceSeconds = 300): boolean {
  if (!signatureB64 || !timestamp) return false;
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKeyB64) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    const keyDer = raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
    const key = crypto.createPublicKey({ key: keyDer, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

interface TelnyxWebhook {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: {
      conference_id?: string;
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      client_state?: string;
      hangup_cause?: string;
      hangup_source?: string;
      direction?: "incoming" | "outgoing";
      from?: string;
      to?: string;
      result?: string;
      recording_id?: string;
      recording_started_at?: string;
      recording_ended_at?: string;
      state?: string;
    };
  };
}

export function parseTelnyxWebhook(body: TelnyxWebhook): ProviderEvent | null {
  const d = body?.data;
  const p = d?.payload;
  if (!d?.id || !d.event_type || !p?.call_control_id) return null;
  const cs = decodeClientState(p.client_state);
  const map: Record<string, ProviderEvent["type"]> = {
    "call.initiated": "leg.initiated",
    "call.answered": "leg.answered",
    "call.bridged": "leg.bridged",
    "call.hangup": "leg.hangup",
    "call.machine.detection.ended": "leg.machine_detection",
    "call.recording.saved": "recording.saved",
    "conference.participant.joined": "conference.joined",
    "conference.participant.left": "conference.left",
  };
  let recordingDurationMs: number | undefined;
  if (p.recording_started_at && p.recording_ended_at) {
    recordingDurationMs = Math.max(0, new Date(p.recording_ended_at).getTime() - new Date(p.recording_started_at).getTime());
  }
  return {
    provider: "telnyx",
    eventId: d.id,
    type: map[d.event_type] ?? "other",
    legId: p.call_control_id,
    callId: typeof cs?.callId === "string" ? cs.callId : undefined,
    leg: cs?.leg === "agent" || cs?.leg === "lead" || cs?.leg === "supervisor" ? cs.leg : undefined,
    monitorId: typeof cs?.monitorId === "string" ? cs.monitorId : undefined,
    conferenceId: p.conference_id,
    direction: p.direction,
    from: p.from,
    to: p.to,
    occurredAt: d.occurred_at ? new Date(d.occurred_at) : undefined,
    hangupCause: p.hangup_cause,
    hangupSource: p.hangup_source,
    amdResult: p.result,
    recordingId: p.recording_id,
    recordingDurationMs,
    raw: body,
  };
}
