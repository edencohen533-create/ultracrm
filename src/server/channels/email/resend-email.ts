/**
 * Resend (email) – verified against the public API reference (resend.com/docs):
 *   POST /emails            { from: "Name <a@b>", to: [], subject, html, text, reply_to, headers, tags }  → { id }
 *                           `Idempotency-Key` header de-duplicates retries (24h).
 *   POST /domains {name}    → { id, name, status, records: [{ record: "SPF"|"DKIM", type, name, value, ttl, status, priority? }] }
 *   GET  /domains/{id}      → same; status: not_started | pending | verified | failed | temporary_failure
 *   POST /domains/{id}/verify
 * Webhooks are signed by Svix: `svix-id`, `svix-timestamp`, `svix-signature` ("v1,<b64> ...");
 *   signed content = `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 part of `whsec_…`.
 *   Event types: email.sent | email.delivered | email.delivery_delayed | email.complained |
 *   email.bounced (data.bounce.type Permanent|Transient|Undetermined) | email.opened | email.clicked (data.click.link) | email.failed
 * Resend has no block-list API for us to push suppressions → suppressionSync=false.
 * DMARC is not required by Resend but recommended; we surface a suggested `_dmarc` record.
 */
import crypto from "node:crypto";
import type { ChannelCapabilities, ChannelSendResult, ConnectionReport, DnsRecord, DomainInfo, EmailProvider, EmailSendInput, ProviderEvent } from "../types";
import { ChannelProviderError, ChannelRequestTimeout } from "../types";

export interface ResendConfig {
  apiKey: string;
  /** whsec_… from the Resend webhook settings. */
  webhookSecret?: string;
}

const BASE = "https://api.resend.com";
const TIMEOUT_MS = 15_000;

export const RESEND_CAPABILITIES: ChannelCapabilities = {
  inbound: false, deliveryReports: true, opens: true, clicks: true, bounces: true, complaints: true,
  suppressionSync: false, cancelQueued: false, alphanumericSender: false, unicode: true, cost: false,
};

interface ResendDomain { id: string; name: string; status: string; records?: Array<{ record: string; name: string; type: string; value: string; ttl?: string; status?: string; priority?: number }> }

export function dmarcSuggestion(domain: string): DnsRecord {
  return { record: "DMARC", type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain, required: false, status: "recommended" };
}

export class ResendEmailProvider implements EmailProvider {
  readonly key = "resend" as const;
  readonly capabilities = RESEND_CAPABILITIES;
  constructor(private readonly config: ResendConfig) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new ChannelRequestTimeout();
      throw new ChannelProviderError(`Resend unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const j = json as { message?: string; name?: string };
      throw new ChannelProviderError(`Resend: ${j.name ?? res.status} ${j.message ?? ""}`.trim().slice(0, 500), res.status, [400, 403, 422].includes(res.status));
    }
    return json as T;
  }

  async send(input: EmailSendInput): Promise<ChannelSendResult> {
    const r = await this.api<{ id: string }>("/emails", {
      method: "POST", headers: { "Idempotency-Key": input.idempotencyKey.slice(0, 256) },
      body: JSON.stringify({
        from: `${input.fromName.replace(/[<>"]/g, "")} <${input.fromEmail}>`, to: [input.to], subject: input.subject, html: input.html, text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}), ...(input.headers ? { headers: input.headers } : {}),
        ...(input.tags ? { tags: Object.entries(input.tags).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })) } : {}),
      }),
    });
    return { providerMessageId: r.id, status: "ACCEPTED", cost: null };
  }

  async check(): Promise<ConnectionReport> {
    const checks: ConnectionReport["checks"] = [];
    try {
      const d = await this.api<{ data: ResendDomain[] }>("/domains");
      checks.push({ label: "מפתח API", ok: true, detail: `${d.data.length} דומיינים בחשבון` });
      checks.push({ label: "סוד Webhook (Svix)", ok: /^whsec_/.test(this.config.webhookSecret ?? ""), detail: this.config.webhookSecret ? undefined : "חסר – אירועי מסירה/הקפצות/תלונות לא יאומתו" });
      return { ok: checks.every((c) => c.ok), checks, capabilities: this.capabilities };
    } catch (err) {
      const message = err instanceof ChannelRequestTimeout ? "Resend לא ענה בזמן" : (err as Error).message;
      checks.push({ label: "גישה ל-Resend", ok: false, detail: message });
      return { ok: false, checks, error: message, capabilities: this.capabilities };
    }
  }

  private mapDomain(d: ResendDomain): DomainInfo {
    const records: DnsRecord[] = (d.records ?? []).map((r) => ({ record: (r.record?.toUpperCase() as DnsRecord["record"]) || "TXT", type: r.type, name: r.name, value: r.value, ttl: r.ttl, status: r.status, priority: r.priority, required: true }));
    records.push(dmarcSuggestion(d.name));
    return { id: d.id, name: d.name, status: d.status, records };
  }

  domains = {
    create: async (name: string) => this.mapDomain(await this.api<ResendDomain>("/domains", { method: "POST", body: JSON.stringify({ name }) })),
    get: async (id: string) => this.mapDomain(await this.api<ResendDomain>(`/domains/${encodeURIComponent(id)}`)),
    verify: async (id: string) => { await this.api(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" }); return this.mapDomain(await this.api<ResendDomain>(`/domains/${encodeURIComponent(id)}`)); },
  };

  verifyWebhook(headers: Headers, rawBody: string): boolean {
    const id = headers.get("svix-id");
    const ts = headers.get("svix-timestamp");
    const sigs = headers.get("svix-signature");
    const secret = this.config.webhookSecret;
    if (!id || !ts || !sigs || !secret) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
    for (const part of sigs.split(" ")) {
      const [version, value] = part.split(",");
      if (version !== "v1" || !value) continue;
      const given = Buffer.from(value, "base64");
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
    }
    return false;
  }

  parseWebhook(rawBody: string): ProviderEvent[] {
    const b = JSON.parse(rawBody) as { type?: string; created_at?: string; data?: { email_id?: string; created_at?: string; bounce?: { type?: string; subType?: string; message?: string }; click?: { link?: string }; failed?: { reason?: string } } };
    const id = b.data?.email_id;
    if (!b.type || !id) return [];
    const at = b.created_at ? new Date(b.created_at) : new Date();
    const eventId = `${b.type}:${id}:${b.created_at ?? ""}`; // svix-id (header) is preferred by the route; this is the in-body fallback
    switch (b.type) {
      case "email.sent": return [{ kind: "status", eventId, providerMessageId: id, status: "SENT", at }];
      case "email.delivered": return [{ kind: "status", eventId, providerMessageId: id, status: "DELIVERED", at }];
      case "email.delivery_delayed": return [{ kind: "status", eventId, providerMessageId: id, status: "SENT", at, detail: "delivery delayed" }];
      case "email.bounced": {
        const type = (b.data?.bounce?.type ?? "").toLowerCase();
        const hard = type === "permanent";
        return [{ kind: "status", eventId, providerMessageId: id, status: "BOUNCED", at, bounceType: hard ? "hard" : "soft", permanent: hard, detail: [b.data?.bounce?.subType, b.data?.bounce?.message].filter(Boolean).join(": ") || type }];
      }
      case "email.complained": return [{ kind: "status", eventId, providerMessageId: id, status: "COMPLAINED", at }];
      case "email.opened": return [{ kind: "status", eventId, providerMessageId: id, status: "OPENED", at }];
      case "email.clicked": return [{ kind: "status", eventId, providerMessageId: id, status: "CLICKED", at, link: b.data?.click?.link }];
      case "email.failed": return [{ kind: "status", eventId, providerMessageId: id, status: "FAILED", at, detail: b.data?.failed?.reason ?? "failed", permanent: false }];
      default: return [{ kind: "ignored", eventId, type: b.type }];
    }
  }
}
