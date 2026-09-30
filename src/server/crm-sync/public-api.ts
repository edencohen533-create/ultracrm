/**
 * /api/v1/crm – the general integration API (version 1). An external system (or Make / Zapier / n8n) upserts
 * contacts and opportunities by ITS ids, changes assignment / status / follow-up, sends block requests and reads our
 * events. Every write goes through the same pipeline as a connector (ingest.applyChange): identity by external id,
 * dedupe by Idempotency-Key / X-Event-Id, stale protection by updatedAt / version, review queue for ambiguity.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { ApiError, handleError, ok } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { authenticateIntegrationKey, type IntegrationScope } from "@/server/services/integrations";
import { connForIngest } from "./connections";
import { applyChange } from "./ingest";

const str = (n: number) => z.string().trim().max(n);
const fields = z.record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional();
export const contactBody = z.object({
  name: str(120).optional(), phones: z.array(str(40)).max(10).optional(), email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal("")),
  ownerExternalId: str(120).nullable().optional(), source: str(100).optional(), campaign: str(160).optional(), product: str(160).optional(), tags: z.array(str(60)).max(50).optional(), customFields: fields,
  isCustomer: z.boolean().optional(), purchases: z.array(z.object({ externalId: str(120), amount: z.number().min(0).max(1e9), currency: str(3).optional(), at: z.string().datetime({ offset: true }) })).max(100).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(), version: str(60).optional(),
});
export const leadBody = z.object({
  contactExternalId: str(120), title: str(160).optional(), status: str(120).optional(), ownerExternalId: str(120).nullable().optional(),
  followUpAt: z.string().datetime({ offset: true }).nullable().optional(), timezone: str(60).optional(), product: str(160).optional(), source: str(100).optional(), campaign: str(160).optional(), list: str(120).optional(), team: str(120).optional(),
  tags: z.array(str(60)).max(50).optional(), customFields: fields, updatedAt: z.string().datetime({ offset: true }).optional(), version: str(60).optional(),
});
const EXT_ID = /^[A-Za-z0-9._:@\-]{1,120}$/;

export async function withIntegration<T>(req: Request, scope: IntegrationScope, fn: (a: Awaited<ReturnType<typeof authenticateIntegrationKey>>) => Promise<T>, status = 200) {
  try {
    const a = await authenticateIntegrationKey(req, scope);
    const res = ok(await withBusiness(a.business.id, () => fn(a), a.session), status);
    res.headers.set("X-RateLimit-Limit", String(a.rateLimit.limit)); res.headers.set("X-RateLimit-Remaining", String(a.rateLimit.remaining)); res.headers.set("X-API-Version", "1");
    return res;
  } catch (e) { return handleError(e); }
}

/** Event id: the caller's Idempotency-Key / X-Event-Id, else a hash of the request (identical retries = one change). */
export function eventIdFor(req: Request, type: string, externalId: string, body: unknown) {
  const k = req.headers.get("idempotency-key") ?? req.headers.get("x-event-id");
  if (k && k.length <= 200) return `api:${k}`;
  return `api:${type}:${externalId}:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`;
}

export async function upsertRecord(req: Request, type: "contact" | "lead", externalId: string, deleted = false) {
  const scope: IntegrationScope = type === "contact" ? "contacts:write" : "leads:write";
  return withIntegration(req, scope, async (a) => {
    if (!EXT_ID.test(externalId)) throw new ApiError("מזהה חיצוני לא תקין (עד 120 תווים: אותיות, ספרות ._:@-)", 400, "validation");
    let raw: unknown = {};
    if (!deleted) { try { raw = await req.json(); } catch { throw new ApiError("גוף הבקשה אינו JSON תקין", 400, "invalid_json"); } }
    const parsed = deleted ? { success: true as const, data: {} } : (type === "contact" ? contactBody : leadBody).safeParse(raw);
    if (!parsed.success) throw new ApiError("נתונים לא תקינים", 400, "validation", parsed.error.flatten());
    const record = { ...parsed.data, externalId, ...(deleted ? { deleted: true, contactExternalId: "" } : {}) };
    const r = await applyChange(connForIngest(a.connection), { eventId: eventIdFor(req, type, externalId, deleted ? { deleted: true, at: req.headers.get("x-event-id") } : raw), occurredAt: (parsed.data as { updatedAt?: string }).updatedAt ?? null, recordType: type, record: record as never }, { kind: "api", correlationId: req.headers.get("x-correlation-id") });
    if (r.status === "failed") throw new ApiError(r.message ?? "העדכון נכשל", 422, "not_applied");
    return { status: r.status, localId: r.localId ?? null, reviewIds: r.reviewIds ?? [], message: r.message ?? null };
  });
}
