/**
 * Zadarma adapter – BACKUP provider, callback model. Checked against zadarma.com/en/support/api/ on 2026-09-29.
 *
 * What Zadarma offers (documented):
 *   GET  /v1/request/callback/      from=<agent PBX extension> to=<customer> sip=<extension>: rings the agent first, then
 *                                   dials the customer. Returns {status, from, to, time} – NO call id.
 *   GET  /v1/webrtc/get_key/        sip=<extension> → widget key, valid 72 h (official widget, not a headless SDK).
 *   GET  /v1/pbx/record/request/    call_id (call_id_with_rec) + lifetime 180…5184000 s → temporary link.
 *   GET  /v1/statistics/pbx/        start, end, version=2, call_type=out – max 3 requests / minute.
 *   GET  /v1/info/balance/, GET /v1/pbx/internal/  (read-only checks)
 *   Auth: "Authorization: <key>:<base64(hex(hmac_sha1(method + params + md5(params), secret)))>", params ksorted,
 *   RFC1738 query. Limit 100 requests / minute (429).
 *   Webhooks: NOTIFY_OUT_START / NOTIFY_OUT_END / NOTIFY_RECORD, form-encoded, header Signature =
 *   base64(hex(hmac_sha1(internal + destination + call_start))) or (pbx_call_id + call_id_with_rec), API secret.
 * What it does not offer through the API: hangup / transfer / hold / DTMF / conference / listen-whisper on a live
 * call, and any id that ties a callback request to its events. Those actions are refused here with a reason.
 * Not documented (needs the provider's answer, see docs/TELEPHONY_ZADARMA.md): whether callback calls emit
 * NOTIFY_OUT_* at all, webhook retries / ordering – hence the live test that must pass before real traffic.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { openSecret } from "@/lib/crypto";
import type { DialAgentInput, DialResult, ProviderCheck, TelephonyAdapter } from "./types";
import { TelephonyProviderError, TelephonyRequestTimeout, TelephonyUnsupportedError, type FailureClass } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
const WIDGET_KEY_TTL_MS = 72 * 3600_000;

/** PHP urlencode (RFC1738): space → '+', everything but [A-Za-z0-9-_.] percent-encoded upper-case. */
export function phpUrlencode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

export function zadarmaParamsString(params: Record<string, string | number>) {
  return Object.keys(params).sort().map((k) => `${phpUrlencode(k)}=${phpUrlencode(String(params[k]))}`).join("&");
}

/** API request signature exactly as the documented PHP sample (hash_hmac returns hex, which is then base64-encoded). */
export function zadarmaSignature(method: string, params: Record<string, string | number>, secret: string) {
  const p = zadarmaParamsString(params);
  const md5 = crypto.createHash("md5").update(p).digest("hex");
  const hex = crypto.createHmac("sha1", secret).update(method + p + md5).digest("hex");
  return Buffer.from(hex).toString("base64");
}

/** Webhook signature input per event (docs, 2026-09-29). */
export function zadarmaWebhookSigned(f: Record<string, string>): string | null {
  switch (f.event) {
    case "NOTIFY_OUT_START": case "NOTIFY_OUT_END": return `${f.internal ?? ""}${f.destination ?? ""}${f.call_start ?? ""}`;
    case "NOTIFY_RECORD": return `${f.pbx_call_id ?? ""}${f.call_id_with_rec ?? ""}`;
    case "NOTIFY_START": case "NOTIFY_INTERNAL": case "NOTIFY_END": case "NOTIFY_IVR": return `${f.caller_id ?? ""}${f.called_did ?? ""}${f.call_start ?? ""}`;
    case "NOTIFY_ANSWER": return `${f.caller_id ?? ""}${f.destination ?? ""}${f.call_start ?? ""}`;
    default: return null;
  }
}

export function verifyZadarmaWebhook(fields: Record<string, string>, signature: string | null, secret: string): boolean {
  const signed = zadarmaWebhookSigned(fields);
  if (!signed || !signature) return false;
  const expected = Buffer.from(crypto.createHmac("sha1", secret).update(signed).digest("hex")).toString("base64");
  const a = Buffer.from(expected), b = Buffer.from(signature.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** NOTIFY_OUT_END disposition → our hangup cause, and whether it is a provider/account failure (never busy / no answer). */
export function mapDisposition(d: string): { hangupCause: string; answered: boolean; failure: FailureClass | null } {
  switch (d.trim().toLowerCase()) {
    case "answered": return { hangupCause: "normal_clearing", answered: true, failure: null };
    case "busy": return { hangupCause: "user_busy", answered: false, failure: null };
    case "no answer": return { hangupCause: "no_answer", answered: false, failure: null };
    case "cancel": return { hangupCause: "originator_cancel", answered: false, failure: null };
    case "unallocated number": return { hangupCause: "not_found", answered: false, failure: null }; // wrong number – never a reason to switch
    case "no money": return { hangupCause: "provider_no_money", answered: false, failure: "account" };
    case "line limit": case "no limit": case "no day limit": case "no money, no limit": return { hangupCause: `provider_${d.trim().replace(/\W+/g, "_")}`, answered: false, failure: "capacity" };
    case "failed": case "call failed": return { hangupCause: "provider_failed", answered: false, failure: "provider_outage" };
    default: return { hangupCause: `provider_${d.trim().replace(/\W+/g, "_") || "unknown"}`, answered: false, failure: "unknown" };
  }
}

/** Zadarma dials without "+": 972501234567. */
export const zadarmaNumber = (e164: string) => e164.replace(/[^\d]/g, "");

export interface ZadarmaAccount { id: string; businessId: string; apiKey: string; apiSecret: string; sandbox: boolean; callerIdE164: string | null; callerIdApproved: boolean; maxConcurrent: number | null; liveTestPassedAt: Date | null }

export async function zadarmaAccount(businessId: string): Promise<ZadarmaAccount | null> {
  const c = await prisma.telephonyProviderCredential.findUnique({ where: { businessId_provider: { businessId, provider: "zadarma" } } });
  if (!c) return null;
  let secrets: { apiKey?: string; apiSecret?: string } = {};
  try { secrets = JSON.parse(openSecret(c.secrets) ?? "{}"); } catch { secrets = {}; }
  if (!secrets.apiKey || !secrets.apiSecret) return null;
  return { id: c.id, businessId, apiKey: secrets.apiKey, apiSecret: secrets.apiSecret, sandbox: c.sandbox, callerIdE164: c.callerIdE164, callerIdApproved: Boolean(c.callerIdApprovedAt && c.callerIdE164), maxConcurrent: c.maxConcurrent, liveTestPassedAt: c.liveTestPassedAt };
}

function classifyZadarmaError(status: number, message: string): FailureClass {
  if (status === 429 || /rate limit/i.test(message)) return "rate_limit";
  if (status === 401 || status === 403 || /not authori|wrong key|signature|api key/i.test(message)) return "auth";
  if (/money|balance|funds/i.test(message)) return "account";
  if (/limit/i.test(message)) return "capacity";
  if (status >= 500) return "provider_outage";
  return "invalid_request";
}

export async function zadarmaRequest<T>(acc: ZadarmaAccount, httpMethod: "GET" | "POST" | "PUT" | "DELETE", method: string, params: Record<string, string | number> = {}): Promise<T> {
  const base = acc.sandbox ? "https://api-sandbox.zadarma.com" : "https://api.zadarma.com";
  const query = zadarmaParamsString(params);
  const auth = `${acc.apiKey}:${zadarmaSignature(method, params, acc.apiSecret)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const isBody = httpMethod === "POST" || httpMethod === "PUT";
    const res = await fetch(`${base}${method}${!isBody && query ? `?${query}` : ""}`, {
      method: httpMethod, signal: controller.signal,
      headers: { Authorization: auth, ...(isBody ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: isBody ? query : undefined,
    });
    const text = await res.text();
    let json: { status?: string; message?: string } & Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* non-JSON error */ }
    if (!res.ok || json.status !== "success") {
      const message = String(json.message ?? text ?? res.statusText).slice(0, 300);
      throw new TelephonyProviderError(`Zadarma ${res.status}: ${message}`, res.status, classifyZadarmaError(res.status, message), Number(res.headers.get("x-ratelimit-reset")) || null, "zadarma_error");
    }
    return json as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new TelephonyRequestTimeout();
    throw err;
  } finally { clearTimeout(timer); }
}

const unsupported = (what: string, capability: string) => new TelephonyUnsupportedError(`${what} אינו נתמך בספק Zadarma דרך ה-API – ${capability === "hangup" ? "יש לנתק בחלון הטלפון של Zadarma" : "הפעולה זמינה רק מהטלפון של הנציג (קודי מרכזייה)"}`, capability);

async function callOfLeg(legId: string) {
  return prisma.call.findFirst({ where: { provider: "zadarma", OR: [{ agentLegId: legId }, { leadLegId: legId }] }, select: { id: true, businessId: true } });
}

/** Statistics lookups are limited to 3 / minute per account – at most one every 25 s per business. */
const lastStatsLookup = new Map<string, number>();
/** Tests only. */
export function __resetZadarmaThrottle() { if (process.env.NODE_ENV === "test") lastStatsLookup.clear(); }

export const zadarmaAdapter: TelephonyAdapter = {
  name: "zadarma",
  simulation: false,
  capabilities: {
    outboundDial: true, inboundCalls: false, conference: false, supervisorMonitor: false, recording: true,
    answeringMachineDetection: false, dtmf: false, agentClient: "zadarma-widget", legLookupByReference: true,
    dialModel: "callback", serverHangup: false,
  },
  // Accounts are per business (TelephonyProviderCredential); platform-wide it only needs ENCRYPTION_KEY to open them.
  configStatus: () => ({ configured: Boolean(process.env.ENCRYPTION_KEY), missing: process.env.ENCRYPTION_KEY ? [] : ["ENCRYPTION_KEY"], accountRef: "per-business" }),

  async businessReadiness(businessId) {
    const acc = await zadarmaAccount(businessId);
    if (!acc) return { ready: false, reason: "not_configured" };
    if (!acc.callerIdApproved) return { ready: false, reason: "caller_id_not_approved" };
    if (!(await prisma.telephonyAgentEndpoint.count({ where: { businessId, provider: "zadarma" } }))) return { ready: false, reason: "no_agent_extensions" };
    const cred = await prisma.telephonyProviderCredential.findUniqueOrThrow({ where: { id: acc.id } });
    if (!cred.lastCheckOk) return { ready: false, reason: "not_verified" };
    if (!acc.liveTestPassedAt) return { ready: false, reason: "live_test_required" };
    return { ready: true, reason: "verified" };
  },

  /** Read-only: balance, extensions exist, webhook URL. Never dials or changes the account. */
  async verifyConfig(businessId) {
    if (!businessId) return [{ name: "account", ok: false, detail: "per-business account" }];
    const acc = await zadarmaAccount(businessId);
    if (!acc) return [{ name: "credentials", ok: false, detail: "API key / secret not set" }];
    const checks: ProviderCheck[] = [{ name: "credentials", ok: true, detail: `key …${acc.apiKey.slice(-4)}${acc.sandbox ? " (sandbox)" : ""}` }];
    try {
      const b = await zadarmaRequest<{ balance?: number | string; currency?: string }>(acc, "GET", "/v1/info/balance/");
      checks.push({ name: "balance", ok: Number(b.balance ?? 0) > 0, detail: `${b.balance ?? "?"} ${b.currency ?? ""}`.trim() });
    } catch (err) { checks.push({ name: "balance", ok: false, detail: (err as Error).message.slice(0, 200) }); }
    try {
      const r = await zadarmaRequest<{ numbers?: Array<string | number>; pbx_id?: string | number }>(acc, "GET", "/v1/pbx/internal/");
      const existing = new Set((r.numbers ?? []).map((n) => String(n)));
      const mapped = await prisma.telephonyAgentEndpoint.findMany({ where: { businessId, provider: "zadarma" }, select: { extension: true } });
      const missing = mapped.filter((m) => !existing.has(m.extension)).map((m) => m.extension);
      checks.push({ name: "extensions", ok: mapped.length > 0 && missing.length === 0, detail: mapped.length ? (missing.length ? `missing at Zadarma: ${missing.join(", ")}` : `${mapped.length} mapped`) : "no agent extensions mapped" });
    } catch (err) { checks.push({ name: "extensions", ok: false, detail: (err as Error).message.slice(0, 200) }); }
    checks.push({ name: "caller_id", ok: acc.callerIdApproved, detail: acc.callerIdE164 ? (acc.callerIdApproved ? `${acc.callerIdE164} approved` : `${acc.callerIdE164} not approved`) : "not set" });
    return checks;
  },

  async agentAddress(userId) {
    const e = await prisma.telephonyAgentEndpoint.findUnique({ where: { userId_provider: { userId, provider: "zadarma" } } });
    return e?.extension ?? null;
  },

  /** One request: Zadarma rings the agent's extension, then dials the customer. There is no call id to return. */
  async dialAgent(input: DialAgentInput): Promise<DialResult> {
    if (!input.businessId || !input.toE164) throw new ApiError("Zadarma callback requires the business and the destination", 500, "zadarma_bad_request");
    const acc = await zadarmaAccount(input.businessId);
    if (!acc) throw new TelephonyProviderError("Zadarma account is not configured", null, "account");
    await zadarmaRequest(acc, "GET", "/v1/request/callback/", { from: input.sipUsername, to: zadarmaNumber(input.toE164), sip: input.sipUsername });
    // Synthetic leg id: the provider's pbx_call_id arrives only with NOTIFY_OUT_START.
    return { legId: `zd-cb-${input.callId}` };
  },
  async dialLead() { throw unsupported("חיוג נפרד ללקוח", "dial_lead"); },
  async hangupLeg() { throw unsupported("ניתוק", "hangup"); },
  async answerLeg() { throw unsupported("מענה לשיחה נכנסת", "answer"); },
  async createConference() { throw unsupported("ועידה", "conference"); },
  async dialSupervisor() { throw unsupported("האזנת מנהל", "supervisor"); },
  async switchSupervisorRole() { throw unsupported("לחישה / התפרצות", "supervisor"); },
  async sendDtmf() { throw unsupported("DTMF מהשרת", "dtmf"); },
  async isLegAlive() { return null; },

  /**
   * After a timed-out callback request: look for an outgoing PBX call from the agent's extension to the customer in
   * the statistics. Only a single unclaimed match counts; anything else is "cannot tell" (null) – never "none",
   * because statistics may lag and times carry no time zone.
   */
  async findLegByReference(ref) {
    const call = await prisma.call.findUnique({ where: { id: ref.callId }, select: { businessId: true, userId: true, toE164: true, createdAt: true } });
    if (!call || ref.leg === "supervisor") return null;
    const last = lastStatsLookup.get(call.businessId) ?? 0;
    if (Date.now() - last < 25_000) return null;
    lastStatsLookup.set(call.businessId, Date.now());
    const acc = await zadarmaAccount(call.businessId);
    const ext = await zadarmaAdapter.agentAddress(call.userId);
    if (!acc || !ext) return null;
    const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    try {
      const r = await zadarmaRequest<{ stats?: Array<{ sip?: string | number; destination?: string | number; pbx_call_id?: string }> }>(acc, "GET", "/v1/statistics/pbx/", {
        start: fmt(new Date(call.createdAt.getTime() - 24 * 3600_000)), end: fmt(new Date(Date.now() + 24 * 3600_000)), version: 2, call_type: "out",
      });
      const to = zadarmaNumber(call.toE164);
      const hits = (r.stats ?? []).filter((s) => String(s.sip) === ext && zadarmaNumber(String(s.destination ?? "")).endsWith(to.slice(-9)) && s.pbx_call_id);
      const claimed = new Set((await prisma.call.findMany({ where: { provider: "zadarma", leadLegId: { in: hits.map((h) => h.pbx_call_id!) } }, select: { leadLegId: true } })).map((c) => c.leadLegId));
      const free = hits.filter((h) => !claimed.has(h.pbx_call_id!));
      return free.length === 1 ? { legId: free[0].pbx_call_id! } : null;
    } catch { return null; }
  },

  async createBrowserToken(userId) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { businessId: true } });
    const acc = await zadarmaAccount(user.businessId);
    const ext = await zadarmaAdapter.agentAddress(userId);
    if (!acc || !ext) throw new ApiError("לנציג אין שלוחת Zadarma מוגדרת", 409, "agent_extension_missing");
    const r = await zadarmaRequest<{ key: string }>(acc, "GET", "/v1/webrtc/get_key/", { sip: ext });
    return { token: r.key, sipUsername: ext, expiresAt: new Date(Date.now() + WIDGET_KEY_TTL_MS - 3600_000) };
  },

  async getRecordingDownloadUrl(recordingId) {
    const call = await prisma.call.findFirst({ where: { provider: "zadarma", recordingId }, select: { businessId: true } });
    const acc = call ? await zadarmaAccount(call.businessId) : null;
    if (!acc) return null;
    const r = await zadarmaRequest<{ link?: string; links?: string[] }>(acc, "GET", "/v1/pbx/record/request/", { call_id: recordingId, lifetime: 180 });
    const url = r.link ?? r.links?.[0];
    return url ? { url, contentType: "audio/mpeg" } : null;
  },

  async deleteRecording(recordingId) {
    const call = await prisma.call.findFirst({ where: { provider: "zadarma", recordingId }, select: { businessId: true } });
    const acc = call ? await zadarmaAccount(call.businessId) : null;
    if (!acc) return false;
    try { await zadarmaRequest(acc, "DELETE", "/v1/pbx/record/request/", { call_id: recordingId }); return true; } catch { return false; }
  },
};

export { callOfLeg as zadarmaCallOfLeg };
