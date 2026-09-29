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
import type { DialAgentInput, DialLeadInput, DialResult, ProviderCheck, ProviderEvent, TelephonyAdapter } from "./types";
import { TelephonyProviderError, TelephonyRequestTimeout } from "./types";
import { classifyHttpFailure } from "./classify";

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
  return { configured: missing.length === 0, missing, accountRef: process.env.TELNYX_CALL_CONTROL_APP_ID ?? null };
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
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new TelephonyProviderError(`Telnyx ${res.status}: ${detail}`.slice(0, 500), res.status, classifyHttpFailure(res.status, detail), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, "telnyx_error");
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

async function getJson<T>(path: string): Promise<T> { return telnyxFetch<T>(path); }

export const telnyxAdapter: TelephonyAdapter = {
  name: "telnyx",
  simulation: false,
  capabilities: {
    outboundDial: true, inboundCalls: true, conference: true, supervisorMonitor: true, recording: true,
    answeringMachineDetection: true, dtmf: true, agentClient: "telnyx-webrtc", legLookupByReference: true,
    dialModel: "agent_then_lead", serverHangup: true,
  },
  configStatus: telnyxConfigStatus,

  /** Read-only: app + credential connection + outbound profile + webhook settings + balance. Never dials. */
  async verifyConfig(): Promise<ProviderCheck[]> {
    const status = telnyxConfigStatus();
    if (!status.configured) return [{ name: "env", ok: false, detail: `missing ${status.missing.join(", ")}` }];
    const checks: ProviderCheck[] = [];
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    try {
      const app = await getJson<{ data: { active?: boolean; webhook_event_url?: string; webhook_event_failover_url?: string; webhook_api_version?: string; outbound?: { outbound_voice_profile_id?: string | null } } }>(`/call_control_applications/${encodeURIComponent(env("TELNYX_CALL_CONTROL_APP_ID"))}`);
      checks.push({ name: "call_control_app", ok: app.data.active !== false, detail: app.data.active === false ? "inactive" : "found" });
      checks.push({ name: "webhook_url", ok: Boolean(appUrl) && app.data.webhook_event_url === `${appUrl}/api/webhooks/telnyx`, detail: app.data.webhook_event_url ?? "not set" });
      checks.push({ name: "webhook_api_version", ok: app.data.webhook_api_version === "2", detail: app.data.webhook_api_version ?? "unknown" });
      checks.push({ name: "outbound_voice_profile", ok: Boolean(app.data.outbound?.outbound_voice_profile_id), detail: app.data.outbound?.outbound_voice_profile_id ? "assigned" : "not assigned (dials fail with 403 D38)" });
      if (app.data.outbound?.outbound_voice_profile_id) {
        const ovp = await getJson<{ data: { enabled?: boolean; whitelisted_destinations?: string[]; concurrent_call_limit?: number | null } }>(`/outbound_voice_profiles/${encodeURIComponent(app.data.outbound.outbound_voice_profile_id)}`);
        checks.push({ name: "allowed_destinations", ok: (ovp.data.whitelisted_destinations ?? []).includes("IL"), detail: (ovp.data.whitelisted_destinations ?? []).join(",") || "none" });
        checks.push({ name: "concurrent_call_limit", ok: true, detail: ovp.data.concurrent_call_limit == null ? "account default" : String(ovp.data.concurrent_call_limit) });
      }
    } catch (err) { checks.push({ name: "call_control_app", ok: false, detail: (err as Error).message.slice(0, 200) }); }
    try {
      await getJson(`/credential_connections/${encodeURIComponent(env("TELNYX_CREDENTIAL_CONNECTION_ID"))}`);
      checks.push({ name: "credential_connection", ok: true, detail: "found" });
    } catch (err) { checks.push({ name: "credential_connection", ok: false, detail: (err as Error).message.slice(0, 200) }); }
    try {
      const b = await getJson<{ data: { balance?: string; available_credit?: string; currency?: string } }>("/balance");
      checks.push({ name: "balance", ok: Number(b.data.available_credit ?? b.data.balance ?? 0) > 0, detail: `${b.data.available_credit ?? b.data.balance ?? "?"} ${b.data.currency ?? ""}`.trim() });
    } catch (err) { checks.push({ name: "balance", ok: false, detail: (err as Error).message.slice(0, 200) }); }
    return checks;
  },

  async agentAddress(userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { sipUsername: true, telnyxCredentialId: true } });
    return u?.telnyxCredentialId && u.sipUsername ? u.sipUsername : null;
  },

  /** Live legs of the Call Control App, matched by our client_state (callId + leg). Paginated; checks up to 1000 legs. */
  async findLegByReference(ref) {
    try {
      for (let page = 1; page <= 4; page++) {
        const r = await getJson<{ data: Array<{ call_control_id: string; client_state?: string }>; meta?: { total_pages?: number } }>(`/connections/${encodeURIComponent(env("TELNYX_CALL_CONTROL_APP_ID"))}/active_calls?page[number]=${page}&page[size]=250`);
        const hit = r.data.find((c) => { const cs = decodeClientState(c.client_state); return cs?.callId === ref.callId && cs?.leg === ref.leg; });
        if (hit) return { legId: hit.call_control_id };
        if (!r.meta?.total_pages || page >= r.meta.total_pages) return "none";
      }
      return null; // more live legs than we scan – cannot prove absence
    } catch {
      return null;
    }
  },

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

  verifyWebhook(rawBody, headers) {
    return verifyTelnyxSignature(rawBody, headers.get("telnyx-signature-ed25519"), headers.get("telnyx-timestamp"));
  },
  parseWebhook(body) {
    return parseTelnyxWebhook(body as Parameters<typeof parseTelnyxWebhook>[0]);
  },

  async deleteRecording(recordingId) {
    try {
      await telnyxFetch(`/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE" });
      return true;
    } catch (err) {
      return err instanceof TelephonyProviderError && err.httpStatus === 404;
    }
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
