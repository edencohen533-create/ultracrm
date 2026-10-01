/**
 * Integrations for Make / Zapier / n8n / custom code:
 *  • Public API keys (Bearer) for /api/v1 – only a SHA-256 hash is stored, the key is shown once.
 *  • Outgoing webhooks: subscribe a URL to CRM events; every domain event of those types becomes one signed
 *    delivery per endpoint (unique per endpoint + event → no duplicates), retried with backoff.
 * Signature: header `X-UltraCRM-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`, plus X-UltraCRM-Event / -Delivery.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { db, dbSchema, prisma } from "@/lib/db";
import { Prisma, type DomainEvent, type WebhookEndpoint } from "@/generated/prisma/client";
import { ApiError } from "@/lib/response";
import { openConfig, sealConfig } from "@/server/channels/registry";
import { assertPublicHttpsUrl, safeFetch } from "@/lib/safe-url";
import type { SessionUser } from "@/lib/auth";

// ─── Events ────────────────────────────────────────────────────────────────────────────────────────────────────
export const WEBHOOK_EVENTS = {
  "lead.created": "ליד חדש נוצר",
  "lead.status_changed": "סטטוס ליד השתנה",
  "deal.created": "עסקה נוצרה",
  "deal.won": "עסקה נסגרה (זכייה)",
  "deal.lost": "עסקה אבדה",
  "call.outcome_saved": "שיחה תועדה (תוצאת שיחה)",
  "call.summary_ready": "סיכום AI של שיחה מוכן",
  "message.received": "הודעה נכנסת (WhatsApp/SMS)",
  "contact.created": "איש קשר חדש",
  "contact.suppressed": "איש קשר הוסר מדיוור",
  "cart.abandoned": "עגלה ננטשה",
  "task.created": "משימה נוצרה",
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
const EVENT_KEYS = Object.keys(WEBHOOK_EVENTS) as WebhookEvent[];

// ─── API keys ──────────────────────────────────────────────────────────────────────────────────────────────────
export const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

export async function createApiKey(user: SessionUser, name: string) {
  const key = `uk_live_${crypto.randomBytes(24).toString("base64url")}`;
  const row = await prisma.apiKey.create({ data: { businessId: user.businessId, name: name.trim().slice(0, 80), prefix: key.slice(0, 14), keyHash: hashKey(key), createdById: user.id } });
  return { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt, key };
}

/**
 * Resolve an API request to a business. Runs before any business context, so it uses the unscoped client and only
 * a hash lookup. The acting user is the key's creator (must still be active) – audits read "via API key".
 */
export async function authenticateApiKey(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const key = (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : req.headers.get("x-api-key") ?? "").trim();
  if (!key.startsWith("uk_live_")) throw new ApiError("חסר מפתח API (Authorization: Bearer uk_live_…)", 401, "unauthorized");
  const row = await db.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) throw new ApiError("מפתח API לא תקין, בוטל או הוחלף", 401, "unauthorized");
  const [business, actor] = await Promise.all([
    db.business.findUnique({ where: { id: row.businessId }, select: { id: true, name: true, isActive: true } }),
    db.user.findFirst({ where: { id: row.createdById, businessId: row.businessId, isActive: true }, select: { id: true, accountId: true, email: true, fullName: true, role: true, teamId: true } }),
  ]);
  if (!business?.isActive) throw new ApiError("העסק אינו פעיל", 403, "forbidden");
  if (!actor || actor.role === "agent") throw new ApiError("המשתמש שיצר את המפתח אינו פעיל – צור מפתח חדש", 401, "unauthorized");
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  const session: SessionUser = { id: actor.id, accountId: actor.accountId, businessId: business.id, email: actor.email, fullName: actor.fullName, role: actor.role, teamId: actor.teamId };
  // Legacy keys (no scopes) are a CRM feature acting as the key's creator. Integration keys carry limited scopes and
  // work without the CRM module (a business may keep its own CRM) – each endpoint checks its scope.
  if (!row.scopes.length) {
    const { assertAccess } = await import("@/lib/access/engine");
    await assertAccess(session, "crm.view");
  }
  return { business, keyId: row.id, keyName: row.name, session, scopes: row.scopes, connectionId: row.connectionId };
}

/**
 * The general API (/api/v1/leads, /orders, /orders/receipts) – a general API key only. An integration key of a CRM
 * connection is limited to its scopes, rate limit and connection, and works only on its own endpoints (/api/v1/crm/*).
 */
export async function authenticateGeneralApiKey(req: Request) {
  const a = await authenticateApiKey(req);
  if (a.scopes.length || a.connectionId) throw new ApiError("מפתח אינטגרציה של חיבור CRM מוגבל להרשאות שלו – לנקודה זו נדרש מפתח API כללי", 403, "general_key_required");
  return a;
}

// ─── Integration keys (scoped, rate limited, rotatable) ─────────────────────────────────────────────────────────
export const INTEGRATION_SCOPES = { "contacts:write": "יצירה ועדכון אנשי קשר", "leads:write": "יצירה ועדכון פניות, שיוך, סטטוס ופולואפ", "blocks:write": "העברת בקשות חסימה", "events:read": "קריאת אירועי שיחות, הודעות ותוצאות" } as const;
export type IntegrationScope = keyof typeof INTEGRATION_SCOPES;
export const RATE_LIMIT_PER_MINUTE = 120;

/** An integration key authenticated for one scope, bound to a CRM connection, within its rate limit. */
export async function authenticateIntegrationKey(req: Request, scope: IntegrationScope) {
  const a = await authenticateApiKey(req);
  if (!a.scopes.length || !a.connectionId) throw new ApiError("נדרש מפתח אינטגרציה של חיבור CRM (מפתח API כללי אינו מתאים)", 403, "integration_key_required");
  if (!a.scopes.includes(scope)) throw new ApiError(`למפתח אין הרשאה: ${scope}`, 403, "scope_missing", { scope });
  // Fixed one-minute window, atomic across server instances.
  const rows = await db.$queryRaw<Array<{ window_count: number; window_start: Date }>>`UPDATE ${Prisma.raw(`"${dbSchema()}"."api_keys"`)}
    SET window_count = CASE WHEN window_start IS NOT NULL AND window_start > timezone('UTC', now()) - interval '1 minute' THEN window_count + 1 ELSE 1 END,
        window_start = CASE WHEN window_start IS NOT NULL AND window_start > timezone('UTC', now()) - interval '1 minute' THEN window_start ELSE timezone('UTC', now()) END
    WHERE id = ${a.keyId} RETURNING window_count, window_start`;
  const used = rows[0]?.window_count ?? 0;
  if (used > RATE_LIMIT_PER_MINUTE) throw new ApiError("חריגה ממגבלת הקצב – נסו שוב בעוד דקה", 429, "rate_limited", { limit: RATE_LIMIT_PER_MINUTE, retryAfterSec: Math.max(1, 60 - Math.floor((Date.now() - new Date(rows[0].window_start).getTime()) / 1000)) });
  const conn = await db.crmConnection.findFirst({ where: { id: a.connectionId, businessId: a.business.id } });
  if (!conn) throw new ApiError("החיבור של המפתח לא נמצא", 403, "connection_missing");
  if (conn.status === "disconnected") throw new ApiError("החיבור מנותק ב-UltraCRM – הנתונים לא נקלטים עד חיבור מחדש", 409, "connection_disconnected");
  // Push integrations: any authenticated call is a heartbeat – "no changes lately" is not stale data (pre-dial freshness).
  if (conn.status === "active" && (!conn.lastSyncAt || Date.now() - conn.lastSyncAt.getTime() > 60_000)) await db.crmConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date() } }).catch(() => undefined);
  return { ...a, connection: conn, rateLimit: { limit: RATE_LIMIT_PER_MINUTE, remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - used) } };
}

export async function createIntegrationKey(user: SessionUser, input: { name: string; connectionId: string; scopes: string[] }) {
  const scopes = [...new Set(input.scopes)].filter((x): x is IntegrationScope => x in INTEGRATION_SCOPES);
  if (!scopes.length) throw new ApiError("יש לבחור לפחות הרשאה אחת למפתח", 400, "validation");
  const conn = await prisma.crmConnection.findFirst({ where: { id: input.connectionId, businessId: user.businessId }, select: { id: true } });
  if (!conn) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  const key = `uk_live_${crypto.randomBytes(24).toString("base64url")}`;
  const row = await prisma.apiKey.create({ data: { businessId: user.businessId, name: input.name.trim().slice(0, 80) || "מפתח אינטגרציה", prefix: key.slice(0, 14), keyHash: hashKey(key), createdById: user.id, scopes, connectionId: conn.id } });
  return { id: row.id, name: row.name, prefix: row.prefix, scopes, createdAt: row.createdAt, key };
}

/** Rotation: a new key with the same scopes; the old one keeps working for the grace period, then expires. */
export async function rotateApiKey(user: SessionUser, id: string, graceHours = 24) {
  const old = await prisma.apiKey.findFirst({ where: { id, businessId: user.businessId, revokedAt: null } });
  if (!old) throw new ApiError("המפתח לא נמצא", 404, "not_found");
  const key = `uk_live_${crypto.randomBytes(24).toString("base64url")}`;
  const row = await prisma.apiKey.create({ data: { businessId: user.businessId, name: old.name, prefix: key.slice(0, 14), keyHash: hashKey(key), createdById: user.id, scopes: old.scopes, connectionId: old.connectionId, rotatedFromId: old.id } });
  await prisma.apiKey.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() + Math.min(Math.max(graceHours, 0), 168) * 3600_000) } });
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes, key, oldExpiresAt: new Date(Date.now() + graceHours * 3600_000) };
}

// ─── Endpoints ─────────────────────────────────────────────────────────────────────────────────────────────────
export const endpointSchema = z.object({
  url: z.string().trim().min(8).max(1000),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(EVENT_KEYS as [WebhookEvent, ...WebhookEvent[]])).min(1).max(EVENT_KEYS.length),
  isActive: z.boolean().optional(),
});
export const endpointView = (e: WebhookEndpoint, reveal = false) => ({
  id: e.id, url: e.url, description: e.description, events: e.events, isActive: e.isActive, failureCount: e.failureCount, lastSuccessAt: e.lastSuccessAt, lastFailureAt: e.lastFailureAt, createdAt: e.createdAt,
  secret: reveal ? String(openConfig(e.config).secret ?? "") : null,
});

export async function createEndpoint(user: SessionUser, input: z.infer<typeof endpointSchema>) {
  const url = assertPublicHttpsUrl(input.url, "כתובת ה-Webhook").toString();
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  return prisma.webhookEndpoint.create({ data: { businessId: user.businessId, url, description: input.description || null, events: [...new Set(input.events)], isActive: input.isActive ?? true, config: sealConfig({ secret }, ["secret"]) as Prisma.InputJsonValue } });
}

// ─── Deliveries ────────────────────────────────────────────────────────────────────────────────────────────────
async function eventPayload(event: Pick<DomainEvent, "id" | "type" | "occurredAt" | "businessId" | "contactId" | "payload" | "source">) {
  const contact = event.contactId ? await prisma.contact.findFirst({ where: { id: event.contactId, businessId: event.businessId }, select: { id: true, fullName: true, phoneE164: true, email: true, source: true, ownerUserId: true, customFields: true } }) : null;
  return { id: event.id, event: event.type, occurredAt: event.occurredAt, businessId: event.businessId, source: event.source, data: { ...((event.payload ?? {}) as Record<string, unknown>), contact: contact ? { id: contact.id, fullName: contact.fullName, phone: contact.phoneE164, email: contact.email, source: contact.source, ownerUserId: contact.ownerUserId, customFields: contact.customFields } : null } };
}

/** Domain-event handler: one pending delivery per subscribed active endpoint (idempotent on endpoint + event). */
export async function enqueueWebhookDeliveries(event: DomainEvent) {
  if (!(EVENT_KEYS as string[]).includes(event.type)) return { queued: 0 };
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { businessId: event.businessId, isActive: true, events: { has: event.type } }, select: { id: true } });
  if (!endpoints.length) return { queued: 0 };
  const payload = (await eventPayload(event)) as unknown as Prisma.InputJsonValue;
  const r = await prisma.webhookDelivery.createMany({ data: endpoints.map((e) => ({ businessId: event.businessId, endpointId: e.id, event: event.type, eventKey: event.id, payload })), skipDuplicates: true });
  return { queued: r.count };
}

const BACKOFF_MIN = [1, 5, 30, 120, 720];
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MIN.length + 1;
export const sign = (secret: string, body: string) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

async function post(endpoint: WebhookEndpoint, deliveryId: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const secret = String(openConfig(endpoint.config).secret ?? "");
  try {
    const res = await safeFetch(endpoint.url, { method: "POST", body, headers: { "Content-Type": "application/json", "User-Agent": "UltraCRM-Webhooks/1", "X-UltraCRM-Event": event, "X-UltraCRM-Delivery": deliveryId, "X-UltraCRM-Signature": sign(secret, body) }, timeoutMs: 10_000 });
    return { ok: res.status >= 200 && res.status < 300, code: res.status, error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}` };
  } catch (e) { return { ok: false, code: null, error: (e as Error).message.slice(0, 300) }; }
}

/** Cron (every minute, per business): send due deliveries; retry with backoff; give up after the last attempt. */
export async function deliverDueWebhooks(businessId: string, deadline = Date.now() + 20_000) {
  // A suspended / cancelled business sends nothing out; deliveries wait (kept) until it is reactivated.
  const { businessEntitlement } = await import("@/lib/access/engine");
  if ((await businessEntitlement(businessId)).suspended) return { processed: 0 };
  const due = await prisma.webhookDelivery.findMany({ where: { businessId, status: "pending", nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 25, include: { endpoint: true } });
  let sent = 0;
  for (const d of due) {
    if (Date.now() > deadline) break;
    // Claim: only one worker sends a given attempt.
    const claim = await prisma.webhookDelivery.updateMany({ where: { id: d.id, status: "pending", attempts: d.attempts }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10 * 60_000) } });
    if (!claim.count) continue;
    if (!d.endpoint.isActive) { await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "failed", error: "ה-Webhook כבוי" } }); continue; }
    const r = await post(d.endpoint, d.id, d.event, d.payload);
    const attempts = d.attempts + 1;
    if (r.ok) {
      sent++;
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "delivered", responseCode: r.code, error: null, deliveredAt: new Date() } });
      await prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
    } else {
      const last = attempts >= MAX_DELIVERY_ATTEMPTS;
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: last ? "failed" : "pending", responseCode: r.code, error: r.error, nextAttemptAt: new Date(Date.now() + (BACKOFF_MIN[attempts - 1] ?? 720) * 60_000) } });
      await prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } });
    }
  }
  return { processed: sent };
}

/** Manual "send test" – a sample lead.created payload, sent now (not queued), result returned to the screen. */
export async function sendTestWebhook(endpoint: WebhookEndpoint) {
  const payload = { id: `test_${Date.now()}`, event: "test", occurredAt: new Date(), businessId: endpoint.businessId, source: "test", data: { message: "בדיקת חיבור מ-UltraCRM", contact: { id: "c_test", fullName: "ליד לדוגמה", phone: "+972501234567", email: "lead@example.com" } } };
  return post(endpoint, `test_${crypto.randomUUID()}`, "test", payload);
}
