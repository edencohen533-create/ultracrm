/**
 * Telnyx Messaging (SMS) – verified against the public API reference (api.telnyx.com/v2):
 *   POST /messages                       { from | messaging_profile_id, to, text, type: "SMS" }
 *                                        → data.id, data.parts, data.encoding, data.cost{amount,currency}
 *   GET  /messaging_profiles/{id}        (connection check)
 *   GET  /messaging_profiles/{id}/phone_numbers  (numbers attached to the profile)
 * Webhooks (JSON, signed Ed25519): headers `telnyx-signature-ed25519`, `telnyx-timestamp`,
 *   message = `${timestamp}|${rawBody}`, public key from the Telnyx portal (per account).
 *   data.event_type: message.sent | message.finalized | message.received
 *   data.payload.to[].status: queued | sending | sent | delivered | sending_failed | delivery_failed | delivery_unconfirmed
 * Alphanumeric senders are supported in Israel (no replies possible on them).
 * Telnyx keeps its own opt-out list (STOP) for some countries; we treat every inbound
 * "STOP"/"הסר" ourselves as well. There is no API to push our block list → suppressionSync=false.
 */
import crypto from "node:crypto";
import type { ChannelCapabilities, ChannelSendResult, ConnectionReport, ProviderEvent, SmsProvider, SmsSendInput, SmsSender } from "../types";
import { ChannelProviderError, ChannelRequestTimeout } from "../types";

export interface TelnyxSmsConfig {
  apiKey: string;
  messagingProfileId: string;
  /** Ed25519 public key (base64) from Telnyx → Account → Public key. */
  publicKey: string;
  senders?: SmsSender[];
}

const BASE = "https://api.telnyx.com/v2";
const TIMEOUT_MS = 15_000;

export const TELNYX_SMS_CAPABILITIES: ChannelCapabilities = {
  inbound: true, deliveryReports: true, opens: false, clicks: false, bounces: false, complaints: false,
  suppressionSync: false, cancelQueued: false, alphanumericSender: true, unicode: true, cost: true,
};

interface TelnyxMessage { id: string; parts?: number; encoding?: string; cost?: { amount: string; currency: string } | null; to?: Array<{ phone_number: string; status?: string }>; from?: { phone_number?: string }; text?: string; errors?: Array<{ code?: string; title?: string; detail?: string }>; received_at?: string; sent_at?: string; completed_at?: string; direction?: string }

export class TelnyxSmsProvider implements SmsProvider {
  readonly key = "telnyx_sms" as const;
  readonly capabilities = TELNYX_SMS_CAPABILITIES;
  constructor(private readonly config: TelnyxSmsConfig) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json", Accept: "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new ChannelRequestTimeout();
      throw new ChannelProviderError(`Telnyx unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = (json?.errors as Array<{ code?: string; title?: string; detail?: string }> | undefined)?.map((e) => `${e.code ?? ""} ${e.title ?? ""} ${e.detail ?? ""}`.trim()).join("; ") || `HTTP ${res.status}`;
      throw new ChannelProviderError(`Telnyx: ${detail}`.slice(0, 500), res.status, res.status === 400 || res.status === 422);
    }
    return json as T;
  }

  async send(input: SmsSendInput): Promise<ChannelSendResult> {
    const r = await this.api<{ data: TelnyxMessage }>("/messages", { method: "POST", body: JSON.stringify({ from: input.from, messaging_profile_id: this.config.messagingProfileId, to: input.to, text: input.body, type: "SMS" }) });
    const d = r.data;
    const failed = d.to?.[0]?.status === "sending_failed" || (d.errors?.length ?? 0) > 0;
    return {
      providerMessageId: d.id, status: failed ? "FAILED" : "ACCEPTED", error: failed ? d.errors?.map((e) => e.detail ?? e.title).join("; ") : undefined,
      segments: d.parts ?? null, encoding: d.encoding ?? null, cost: d.cost ? { amount: Number(d.cost.amount), currency: d.cost.currency } : null,
    };
  }

  async check(): Promise<ConnectionReport> {
    const checks: ConnectionReport["checks"] = [];
    let senders: SmsSender[] = [];
    try {
      const p = await this.api<{ data: { id: string; name?: string; enabled?: boolean; webhook_url?: string | null } }>(`/messaging_profiles/${encodeURIComponent(this.config.messagingProfileId)}`);
      checks.push({ label: "מפתח API ופרופיל הודעות", ok: true, detail: `${p.data.name ?? p.data.id}${p.data.enabled === false ? " (מושבת!)" : ""}` });
      if (p.data.enabled === false) checks.push({ label: "הפרופיל פעיל", ok: false, detail: "הפרופיל מושבת ב-Telnyx" });
      const numbers = await this.api<{ data: Array<{ phone_number: string; messaging_profile_id?: string }> }>(`/messaging_profiles/${encodeURIComponent(this.config.messagingProfileId)}/phone_numbers?page[size]=50`);
      senders = numbers.data.map((n) => ({ id: n.phone_number, type: "number", value: n.phone_number, inbound: true }));
      for (const s of this.config.senders ?? []) if (s.type === "alphanumeric" && !senders.some((x) => x.value === s.value)) senders.push({ ...s, inbound: false });
      checks.push({ label: "מספרים משויכים לפרופיל", ok: senders.length > 0, detail: senders.length ? senders.map((s) => s.value).join(", ") : "אין מספר משויך – יש לשייך מספר או להגדיר שולח אלפאנומרי מאושר" });
      checks.push({ label: "מפתח ציבורי לאימות Webhooks", ok: /^[A-Za-z0-9+/=]{40,}$/.test(this.config.publicKey ?? ""), detail: this.config.publicKey ? undefined : "חסר – אירועי מסירה ותשובות לא יאומתו" });
      return { ok: checks.every((c) => c.ok), checks, capabilities: this.capabilities, senders };
    } catch (err) {
      const message = err instanceof ChannelRequestTimeout ? "Telnyx לא ענה בזמן" : (err as Error).message;
      checks.push({ label: "גישה ל-Telnyx", ok: false, detail: message });
      return { ok: false, checks, error: message, capabilities: this.capabilities, senders };
    }
  }

  verifyWebhook(headers: Headers, rawBody: string): boolean {
    const sig = headers.get("telnyx-signature-ed25519");
    const ts = headers.get("telnyx-timestamp");
    if (!sig || !ts || !this.config.publicKey) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(this.config.publicKey, "base64")]), format: "der", type: "spki" });
      return crypto.verify(null, Buffer.from(`${ts}|${rawBody}`, "utf8"), key, Buffer.from(sig, "base64"));
    } catch { return false; }
  }

  parseWebhook(rawBody: string): ProviderEvent[] {
    const body = JSON.parse(rawBody) as { data?: { id?: string; event_type?: string; occurred_at?: string; payload?: TelnyxMessage } };
    const d = body.data;
    if (!d?.event_type || !d.payload?.id) return [];
    const eventId = d.id ?? `${d.event_type}:${d.payload.id}:${d.occurred_at ?? ""}`;
    const at = d.occurred_at ? new Date(d.occurred_at) : new Date();
    const p = d.payload;
    if (d.event_type === "message.received") {
      return [{ kind: "inbound", eventId, providerMessageId: p.id, from: p.from?.phone_number ?? "", to: p.to?.[0]?.phone_number ?? "", body: p.text ?? "", at }];
    }
    if (d.event_type === "message.sent") return [{ kind: "status", eventId, providerMessageId: p.id, status: "SENT", at, segments: p.parts ?? null, cost: p.cost ? { amount: Number(p.cost.amount), currency: p.cost.currency } : null }];
    if (d.event_type === "message.finalized") {
      const st = p.to?.[0]?.status ?? "";
      const detail = p.errors?.map((e) => `${e.code ?? ""} ${e.title ?? ""}`.trim()).join("; ") || undefined;
      const cost = p.cost ? { amount: Number(p.cost.amount), currency: p.cost.currency } : null;
      if (st === "delivered") return [{ kind: "status", eventId, providerMessageId: p.id, status: "DELIVERED", at, segments: p.parts ?? null, cost }];
      if (st === "sending_failed" || st === "delivery_failed") return [{ kind: "status", eventId, providerMessageId: p.id, status: "FAILED", at, detail: detail ?? st, permanent: /invalid|unallocated|blocked|opt/i.test(detail ?? ""), segments: p.parts ?? null, cost }];
      if (st === "sent" || st === "delivery_unconfirmed") return [{ kind: "status", eventId, providerMessageId: p.id, status: "SENT", at, detail: st, segments: p.parts ?? null, cost }];
      return [{ kind: "ignored", eventId, type: `${d.event_type}:${st}` }];
    }
    return [{ kind: "ignored", eventId, type: d.event_type }];
  }
}
