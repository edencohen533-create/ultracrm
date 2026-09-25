/**
 * Channel provider layer for SMS and email. Services depend on these shapes only, resolved
 * through `registry.ts`, so a provider can be swapped without touching callers.
 * Secrets live in the (sealed) credential config and never leave the server.
 */
export type SmsProviderKey = "telnyx_sms" | "mock_sms";
export type EmailProviderKey = "resend" | "mock_email";

export interface ChannelCapabilities {
  /** Contact replies reach us (STOP / הסר handled from inbound). */
  inbound: boolean;
  deliveryReports: boolean;
  opens: boolean;
  clicks: boolean;
  bounces: boolean;
  complaints: boolean;
  /** Provider-side block list can be updated by us. */
  suppressionSync: boolean;
  /** A queued message can be cancelled at the provider. */
  cancelQueued: boolean;
  alphanumericSender: boolean;
  unicode: boolean;
  /** Provider reports per-message cost. */
  cost: boolean;
}

export interface SmsSender {
  id: string;
  type: "number" | "alphanumeric";
  value: string;
  /** Replies can be received on this sender. */
  inbound: boolean;
  label?: string;
}

export interface SmsSendInput {
  to: string;          // E.164
  from: string;        // sender value
  body: string;
  idempotencyKey: string;
}
export interface EmailSendInput {
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  idempotencyKey: string;
  tags?: Record<string, string>;
}

export interface ChannelSendResult {
  providerMessageId: string;
  status: "ACCEPTED" | "SENT" | "FAILED";
  error?: string;
  /** Permanent failure (do not retry this identifier). */
  permanent?: boolean;
  segments?: number | null;
  encoding?: string | null;
  cost?: { amount: number; currency: string } | null;
}

export interface ConnectionReport {
  ok: boolean;
  /** Human-readable checks performed (Hebrew). */
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
  error?: string;
  capabilities: ChannelCapabilities;
  senders?: SmsSender[];
}

export type ProviderStatus = "SENT" | "DELIVERED" | "FAILED" | "BOUNCED" | "COMPLAINED" | "OPENED" | "CLICKED";

export type ProviderEvent =
  | { kind: "status"; eventId: string; providerMessageId: string; status: ProviderStatus; at: Date; detail?: string; permanent?: boolean; bounceType?: "hard" | "soft"; segments?: number | null; cost?: { amount: number; currency: string } | null; link?: string }
  | { kind: "inbound"; eventId: string; providerMessageId: string; from: string; to: string; body: string; at: Date }
  | { kind: "ignored"; eventId: string; type: string };

export interface DnsRecord {
  record: "SPF" | "DKIM" | "DMARC" | "MX" | "TXT" | "CNAME";
  type: string;
  name: string;
  value: string;
  status?: string;
  ttl?: string;
  priority?: number;
  /** Required by the provider (false = recommended, e.g. DMARC). */
  required: boolean;
}
export interface DomainInfo {
  id: string;
  name: string;
  /** not_started | pending | verified | failed | temporary_failure */
  status: string;
  records: DnsRecord[];
}

export interface SmsProvider {
  readonly key: SmsProviderKey;
  readonly capabilities: ChannelCapabilities;
  send(input: SmsSendInput): Promise<ChannelSendResult>;
  check(): Promise<ConnectionReport>;
  verifyWebhook(headers: Headers, rawBody: string): boolean;
  parseWebhook(rawBody: string): ProviderEvent[];
  syncSuppression?(identifier: string): Promise<"synced" | "unsupported">;
}

export interface EmailProvider {
  readonly key: EmailProviderKey;
  readonly capabilities: ChannelCapabilities;
  send(input: EmailSendInput): Promise<ChannelSendResult>;
  check(): Promise<ConnectionReport>;
  verifyWebhook(headers: Headers, rawBody: string): boolean;
  parseWebhook(rawBody: string): ProviderEvent[];
  domains: { create(name: string): Promise<DomainInfo>; get(id: string): Promise<DomainInfo>; verify(id: string): Promise<DomainInfo> } | null;
  syncSuppression?(identifier: string): Promise<"synced" | "unsupported">;
}

export class ChannelProviderError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly permanent = false) { super(message); this.name = "ChannelProviderError"; }
}
export class ChannelRequestTimeout extends Error { constructor() { super("provider timeout"); this.name = "ChannelRequestTimeout"; } }
