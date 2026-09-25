/**
 * Simulation providers (no network). Used when no real provider is connected and in tests.
 * They never claim delivery: sends are ACCEPTED only, and the UI marks the channel as "הדמיה".
 * Webhook simulation: signature = HMAC-SHA256(secret, rawBody) in `x-mock-signature`.
 */
import crypto from "node:crypto";
import { smsMetrics } from "@/lib/sms";
import type { ChannelCapabilities, ChannelSendResult, ConnectionReport, EmailProvider, EmailSendInput, ProviderEvent, SmsProvider, SmsSendInput } from "./types";

const CAPS: ChannelCapabilities = { inbound: true, deliveryReports: true, opens: true, clicks: true, bounces: true, complaints: true, suppressionSync: false, cancelQueued: false, alphanumericSender: true, unicode: true, cost: false };

function verify(secret: string | undefined, headers: Headers, rawBody: string) {
  const given = headers.get("x-mock-signature");
  if (!secret || !given) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Test/simulation payload: { eventId, providerMessageId, status | inbound: {from,to,body} } */
function parse(rawBody: string): ProviderEvent[] {
  const b = JSON.parse(rawBody) as { eventId?: string; providerMessageId?: string; status?: ProviderEvent extends { status: infer S } ? S : never; detail?: string; bounceType?: "hard" | "soft"; link?: string; inbound?: { from: string; to: string; body: string }; at?: string };
  if (!b.eventId) return [];
  const at = b.at ? new Date(b.at) : new Date();
  if (b.inbound) return [{ kind: "inbound", eventId: b.eventId, providerMessageId: b.providerMessageId ?? `mock-in-${b.eventId}`, from: b.inbound.from, to: b.inbound.to, body: b.inbound.body, at }];
  if (b.status && b.providerMessageId) return [{ kind: "status", eventId: b.eventId, providerMessageId: b.providerMessageId, status: b.status as never, at, detail: b.detail, bounceType: b.bounceType, permanent: b.bounceType === "hard", link: b.link }];
  return [{ kind: "ignored", eventId: b.eventId, type: "unknown" }];
}

export class MockSmsProvider implements SmsProvider {
  readonly key = "mock_sms" as const;
  readonly capabilities = CAPS;
  constructor(private readonly secret?: string) {}
  async send(input: SmsSendInput): Promise<ChannelSendResult> {
    const m = smsMetrics(input.body);
    return { providerMessageId: `mock-sms-${crypto.randomUUID()}`, status: "ACCEPTED", segments: m.segments, encoding: m.encoding, cost: null };
  }
  async check(): Promise<ConnectionReport> {
    return { ok: true, checks: [{ label: "מצב הדמיה", ok: true, detail: "לא נשלחות הודעות אמיתיות" }], capabilities: CAPS, senders: [{ id: "mock", type: "alphanumeric", value: "DEMO", inbound: true }] };
  }
  verifyWebhook(headers: Headers, rawBody: string) { return verify(this.secret, headers, rawBody); }
  parseWebhook(rawBody: string) { return parse(rawBody); }
}

export class MockEmailProvider implements EmailProvider {
  readonly key = "mock_email" as const;
  readonly capabilities = CAPS;
  domains = null;
  constructor(private readonly secret?: string) {}
  async send(_input: EmailSendInput): Promise<ChannelSendResult> {
    return { providerMessageId: `mock-email-${crypto.randomUUID()}`, status: "ACCEPTED", cost: null };
  }
  async check(): Promise<ConnectionReport> {
    return { ok: true, checks: [{ label: "מצב הדמיה", ok: true, detail: "לא נשלחים אימיילים אמיתיים" }], capabilities: CAPS };
  }
  verifyWebhook(headers: Headers, rawBody: string) { return verify(this.secret, headers, rawBody); }
  parseWebhook(rawBody: string) { return parse(rawBody); }
}
