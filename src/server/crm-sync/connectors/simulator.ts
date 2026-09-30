/**
 * TEST SIMULATOR – an in-memory fake CRM used by automated tests and local QA only. It is not a vendor integration,
 * is hidden from businesses (internal) unless CRM_SIMULATOR=1, and nothing it does reaches a real system.
 * It supports every capability so the shared engine can be exercised end to end: paging, rate limits, webhooks with
 * signatures, write-back with idempotency and "failed after it was done" answers.
 */
import crypto from "node:crypto";
import { ConnectorError, type ConnectorCtx, type ConnectorDef, type ExtContact, type ExtLead, type InboundChange } from "../types";

export interface SimStore {
  users: Array<{ externalId: string; name: string; email?: string }>;
  statuses: string[]; lists: string[];
  contacts: Map<string, ExtContact>; leads: Map<string, ExtLead>;
  activities: Map<string, { correlationId: string; data: Record<string, unknown> }>; tasks: Map<string, { correlationId: string; data: Record<string, unknown> }>;
  statusWrites: Array<{ leadExternalId: string; status: string }>; blocks: Array<{ contactExternalId: string; reason: string }>;
  pageSize: number; rateLimitNext: number; failAfterWriteNext: number; down: boolean; authOk: boolean; seq: number;
}
const g = globalThis as unknown as { __crmSim?: Map<string, SimStore> };
export function simStore(key: string): SimStore {
  g.__crmSim ??= new Map();
  if (!g.__crmSim.has(key)) g.__crmSim.set(key, { users: [], statuses: ["new", "follow_up", "won", "lost"], lists: [], contacts: new Map(), leads: new Map(), activities: new Map(), tasks: new Map(), statusWrites: [], blocks: [], pageSize: 2, rateLimitNext: 0, failAfterWriteNext: 0, down: false, authOk: true, seq: 0 });
  return g.__crmSim.get(key)!;
}
const store = (ctx: ConnectorCtx) => simStore(ctx.auth.account ?? ctx.connectionId);
const guard = (s: SimStore) => { if (s.down) throw new ConnectorError("הסימולטור אינו זמין", "transient"); if (!s.authOk) throw new ConnectorError("הרשאה נדחתה", "auth"); };
export const simSign = (secret: string, ts: string, body: string) => crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

export const simulatorConnector: ConnectorDef = {
  key: "simulator", name: "סימולטור CRM (בדיקות בלבד)", description: "מערכת מדומה לבדיקות אוטומטיות – אינה ספק אמיתי.",
  availability: "tested", internal: true,
  authFields: [{ key: "account", label: "מזהה חשבון מדומה", secret: false, required: true }, { key: "apiKey", label: "מפתח מדומה", secret: true, required: true }],
  capabilities: ["test", "list_users", "list_statuses", "list_lists", "pull_contacts", "pull_leads", "webhooks", "write_call", "update_call", "upsert_task", "update_status", "request_block", "find_by_correlation"],
  async test(ctx) { const s = store(ctx); guard(s); if (ctx.auth.apiKey !== "sim-valid") return { ok: false, message: "המפתח נדחה" }; return { ok: true, message: "החיבור והרשאות הקריאה/כתיבה אושרו (סימולטור)", permissions: ["read", "write"] }; },
  async listUsers(ctx) { const s = store(ctx); guard(s); return s.users; },
  async listStatuses(ctx) { const s = store(ctx); guard(s); return s.statuses; },
  async listLists(ctx) { const s = store(ctx); guard(s); return s.lists; },
  async pull(ctx, recordType, cursor, since) {
    const s = store(ctx); guard(s);
    if (s.rateLimitNext > 0) { s.rateLimitNext--; throw new ConnectorError("מגבלת קצב (סימולטור)", "rate_limit", 1); }
    const all = [...(recordType === "contact" ? s.contacts.values() : s.leads.values())].filter((r) => !since || (r.updatedAt ?? "") > since).sort((a, b) => a.externalId.localeCompare(b.externalId));
    const start = cursor ? Number(cursor) : 0;
    const items: InboundChange[] = all.slice(start, start + s.pageSize).map((r) => ({ eventId: `pull:${recordType}:${r.externalId}:${r.version ?? r.updatedAt}`, occurredAt: r.updatedAt ?? null, ...(recordType === "contact" ? { recordType: "contact" as const, record: r as ExtContact } : { recordType: "lead" as const, record: r as ExtLead }) }));
    return { items, nextCursor: start + s.pageSize < all.length ? String(start + s.pageSize) : null };
  },
  verifyWebhook(ctx, headers, raw) {
    const ts = headers.get("x-sim-timestamp") ?? ""; const sig = headers.get("x-sim-signature") ?? "";
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window 5 min
    const expected = simSign(ctx.auth.webhookSecret ?? "", ts, raw);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  },
  parseWebhook(_ctx, body) {
    const b = body as { events?: Array<{ id: string; type: "contact" | "lead"; at?: string; data: ExtContact | ExtLead }> };
    return (b.events ?? []).map((e) => ({ eventId: e.id, occurredAt: e.at ?? null, ...(e.type === "contact" ? { recordType: "contact" as const, record: e.data as ExtContact } : { recordType: "lead" as const, record: e.data as ExtLead }) }));
  },
  async writeCall(ctx, call) {
    const s = store(ctx); guard(s);
    const existing = [...s.activities.entries()].find(([, a]) => a.correlationId === call.correlationId);
    if (existing) return { externalId: existing[0] }; // the vendor honours the idempotency marker
    const id = `act_${++s.seq}`; s.activities.set(id, { correlationId: call.correlationId, data: { ...call } });
    if (s.failAfterWriteNext > 0) { s.failAfterWriteNext--; throw new ConnectorError("פסק זמן אחרי שהפעולה בוצעה (סימולטור)", "ambiguous"); }
    return { externalId: id };
  },
  async updateCall(ctx, externalId, patch) { const s = store(ctx); guard(s); const a = s.activities.get(externalId); if (!a) throw new ConnectorError("הפעילות לא נמצאה", "invalid"); a.data = { ...a.data, ...patch }; },
  async upsertTask(ctx, task, externalId) {
    const s = store(ctx); guard(s);
    const id = externalId ?? [...s.tasks.entries()].find(([, t]) => t.correlationId === task.correlationId)?.[0] ?? `task_${++s.seq}`;
    s.tasks.set(id, { correlationId: task.correlationId, data: { ...task } });
    return { externalId: id };
  },
  async updateStatus(ctx, leadExternalId, status) { const s = store(ctx); guard(s); s.statusWrites.push({ leadExternalId, status }); const l = s.leads.get(leadExternalId); if (l) l.status = status; },
  async requestBlock(ctx, contactExternalId, reason) { const s = store(ctx); guard(s); s.blocks.push({ contactExternalId, reason }); },
  async findByCorrelation(ctx, kind, correlationId) { const s = store(ctx); const m = kind === "call" ? s.activities : s.tasks; return [...m.entries()].find(([, v]) => v.correlationId === correlationId)?.[0] ?? null; },
};
