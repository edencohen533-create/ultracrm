/**
 * External CRM connections of a business – setup wizard, real connection test, discovery (users / statuses / lists),
 * mapping and selection, preview, initial sync, status, review queue, reprocessing, disconnect / reconnect.
 * Managed by the owner or a manager with business-wide data scope (it moves business data in and out) – with or
 * without the CRM module (a business may keep its own CRM and use only the dialer / WhatsApp).
 * Secrets are sealed and never returned; "active" is set only by a passing connection test.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { effectiveAccess } from "@/lib/access/engine";
import { openConfig, sealConfig } from "@/server/channels/registry";
import { assertPublicHttpsUrl } from "@/lib/safe-url";
import { appBase } from "@/lib/store-urls";
import { connectorFor, visibleConnectors } from "./registry";
import { crmSettingsSchema, parseSettings, type CrmSettings } from "./settings";
import { CAPABILITIES, ConnectorError, type ConnectorCtx, type InboundChange } from "./types";
import { applyChange } from "./ingest";

export async function assertIntegrationAdmin(user: SessionUser) {
  const a = await effectiveAccess(user.businessId, user.id);
  if (!a.isOwner && !(user.role === "manager" && a.scope === "business")) throw new ApiError("ניהול חיבור CRM חיצוני מוגבל לבעל העסק או למנהל עם הרשאה לכל נתוני העסק", 403, "forbidden");
}

export function connectorCatalog() {
  return visibleConnectors().map((c) => ({ key: c.key, name: c.name, description: c.description, availability: c.availability, internal: Boolean(c.internal), authFields: c.authFields, capabilities: c.capabilities.map((k) => ({ key: k, label: CAPABILITIES[k] })) }));
}

async function load(user: SessionUser, id: string) {
  const c = await prisma.crmConnection.findFirst({ where: { id, businessId: user.businessId } });
  if (!c) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  const def = connectorFor(c.connectorKey);
  if (!def) throw new ApiError("המחבר אינו זמין", 409, "connector_unavailable");
  return { c, def, ctx: { connectionId: c.id, businessId: c.businessId, auth: openConfig(c.authConfig) as Record<string, string>, settings: parseSettings(c.settings) } as ConnectorCtx };
}
export const connForIngest = (c: { id: string; businessId: string; name: string; priority: number; createdById: string | null; settings: unknown }) => ({ id: c.id, businessId: c.businessId, name: c.name, priority: c.priority, createdById: c.createdById, settings: parseSettings(c.settings) });

const view = (c: Awaited<ReturnType<typeof prisma.crmConnection.findFirstOrThrow>>) => {
  const def = connectorFor(c.connectorKey);
  const auth = (c.authConfig ?? {}) as Record<string, unknown>;
  return {
    id: c.id, connectorKey: c.connectorKey, connectorName: def?.name ?? c.connectorKey, name: c.name, status: c.status, priority: c.priority,
    verifiedAt: c.verifiedAt, lastTestAt: c.lastTestAt, lastTestResult: c.lastTestResult, lastSyncAt: c.lastSyncAt, lastSyncStatus: c.lastSyncStatus, lastError: c.lastError, syncState: c.syncState, disconnectedAt: c.disconnectedAt,
    settings: parseSettings(c.settings), capabilities: def?.capabilities ?? [],
    // Which credentials are set – never their values.
    authSet: Object.fromEntries((def?.authFields ?? []).map((f) => [f.key, Boolean(auth[f.key])])), authPublic: Object.fromEntries((def?.authFields ?? []).filter((f) => !f.secret).map((f) => [f.key, typeof auth[f.key] === "string" ? auth[f.key] : null])),
    webhookUrl: def?.capabilities.includes("webhooks") ? `${appBase()}/api/crm-webhooks/${c.id}` : null,
  };
};

const createSchema = z.object({ connectorKey: z.string().max(40), name: z.string().trim().min(2).max(80), auth: z.record(z.string().max(60), z.string().max(4000)).default({}) });
export async function createConnection(user: SessionUser, input: unknown) {
  await assertIntegrationAdmin(user);
  const b = createSchema.parse(input);
  const def = connectorFor(b.connectorKey);
  if (!def) throw new ApiError("המחבר אינו זמין", 400, "connector_unavailable");
  const auth = cleanAuth(def, b.auth);
  const secrets: Record<string, string> = {};
  // Secrets we generate: the webhook signing secret, and for the general integration the callback signing secret (shown once).
  if (def.capabilities.includes("webhooks")) secrets.webhookSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  if (def.key === "generic_api") secrets.callbackSecret = `cbsec_${crypto.randomBytes(24).toString("base64url")}`;
  const c = await prisma.crmConnection.create({ data: { businessId: user.businessId, connectorKey: def.key, name: b.name, authConfig: sealConfig({ ...auth, ...secrets }, [...def.authFields.filter((f) => f.secret).map((f) => f.key), "webhookSecret", "callbackSecret"]) as Prisma.InputJsonValue, settings: crmSettingsSchema.parse({}) as unknown as Prisma.InputJsonValue, createdById: user.id } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.connection_created", { connectionId: c.id, connector: def.key });
  return { connection: view(c), secretsOnce: secrets };
}

function cleanAuth(def: NonNullable<ReturnType<typeof connectorFor>>, raw: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of def.authFields) {
    const v = raw[f.key]?.trim();
    if (!v) { if (f.required) throw new ApiError(`חסר: ${f.label}`, 400, "validation"); continue; }
    // A URL the business enters must be public HTTPS (no internal hosts / infrastructure services).
    out[f.key] = /url/i.test(f.key) ? assertPublicHttpsUrl(v, f.label).toString() : v;
  }
  return out;
}

export async function updateAuth(user: SessionUser, id: string, input: unknown) {
  await assertIntegrationAdmin(user);
  const { c, def } = await load(user, id);
  const b = z.object({ auth: z.record(z.string().max(60), z.string().max(4000)) }).parse(input);
  const current = openConfig(c.authConfig) as Record<string, string>;
  const next = { ...current, ...cleanAuth(def, { ...Object.fromEntries(def.authFields.map((f) => [f.key, current[f.key] ?? ""])), ...b.auth }) };
  await prisma.crmConnection.update({ where: { id }, data: { authConfig: sealConfig(next, [...def.authFields.filter((f) => f.secret).map((f) => f.key), "webhookSecret", "callbackSecret"]) as Prisma.InputJsonValue, status: "setup", verifiedAt: null } });
  return getConnection(user, id);
}

/** A real call to the external system. Only a pass makes the connection active. */
export async function testConnection(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const { c, def, ctx } = await load(user, id);
  let r: { ok: boolean; message: string; permissions?: string[] };
  try { r = await def.test(ctx); } catch (e) { r = { ok: false, message: (e as Error).message.slice(0, 300) }; }
  await prisma.crmConnection.update({ where: { id }, data: { lastTestAt: new Date(), lastTestResult: r as unknown as Prisma.InputJsonValue, ...(r.ok ? { verifiedAt: new Date(), status: c.status === "disconnected" ? "disconnected" : "active", lastError: null } : { status: c.status === "active" ? "error" : c.status, lastError: r.message }) } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.connection_tested", { connectionId: id, ok: r.ok });
  return { ...r, connection: await getConnection(user, id) };
}

/** Users / statuses / lists from the source (when supported) plus values already seen in synced records. */
export async function discovery(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const { def, ctx } = await load(user, id);
  const safe = async <T,>(f?: () => Promise<T>) => { if (!f) return null; try { return await f(); } catch (e) { return { error: (e as Error).message } as unknown as T; } };
  const snaps = await prisma.externalRecordLink.findMany({ where: { businessId: user.businessId, connectionId: id, recordType: { in: ["contact", "lead"] } }, select: { snapshot: true }, take: 5000 });
  const seen = { owners: new Set<string>(), statuses: new Set<string>(), lists: new Set<string>(), teams: new Set<string>() };
  for (const s of snaps) { const x = (s.snapshot ?? {}) as Record<string, unknown>; if (typeof x.ownerExternalId === "string") seen.owners.add(x.ownerExternalId); if (typeof x.status === "string") seen.statuses.add(x.status); if (typeof x.list === "string") seen.lists.add(x.list); if (typeof x.team === "string") seen.teams.add(x.team); }
  const localUsers = await prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, isSupport: false }, select: { id: true, fullName: true, email: true, role: true } });
  return {
    users: await safe(def.listUsers ? () => def.listUsers!(ctx) : undefined), statuses: await safe(def.listStatuses ? () => def.listStatuses!(ctx) : undefined), lists: await safe(def.listLists ? () => def.listLists!(ctx) : undefined),
    seen: { owners: [...seen.owners], statuses: [...seen.statuses], lists: [...seen.lists], teams: [...seen.teams] }, localUsers,
  };
}

export async function saveSettings(user: SessionUser, id: string, input: unknown) {
  await assertIntegrationAdmin(user);
  await load(user, id);
  const settings = crmSettingsSchema.parse(input);
  // Mapped users must be active users of THIS business; the queue list must be one of its dial lists.
  const ids = [...new Set(Object.values(settings.userMap))];
  if (ids.length && (await prisma.user.count({ where: { businessId: user.businessId, id: { in: ids }, isActive: true, isSupport: false } })) !== ids.length) throw new ApiError("מיפוי משתמשים כולל משתמש שאינו פעיל בעסק", 400, "invalid_user_map");
  if (settings.queue.enabled && (!settings.queue.listId || !(await prisma.dialList.findFirst({ where: { id: settings.queue.listId, businessId: user.businessId }, select: { id: true } })))) throw new ApiError("יש לבחור רשימת חיוג של העסק", 400, "invalid_list");
  await prisma.crmConnection.update({ where: { id }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.settings_saved", { connectionId: id, queue: settings.queue, writeback: settings.writeback, directions: settings.directions });
  return getConnection(user, id);
}

/** Before importing: counts, duplicates inside the source, matches with existing cards, unmapped agents / statuses. */
export async function preview(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const { def, ctx } = await load(user, id);
  if (!def.pull) return { supported: false, message: "במחבר הזה הרשומות נשלחות אלינו מהמערכת החיצונית (API) – אין שלב ייבוא מראש. רשומות עמומות יופיעו בתור הבירור." };
  const sample: InboundChange[] = [];
  try {
    for (const type of ["contact", "lead"] as const) { let cursor: string | null = null; for (let i = 0; i < 20; i++) { const p = await def.pull(ctx, type, cursor, null); sample.push(...p.items); cursor = p.nextCursor; if (!cursor || sample.length > 1000) break; } }
  } catch (e) {
    if (e instanceof ConnectorError) throw new ApiError(e.kind === "rate_limit" ? `המערכת החיצונית ביקשה להאט – נסו את התצוגה המקדימה שוב בעוד ${e.retryAfterSec ?? 60} שניות` : `קריאת הנתונים נכשלה: ${e.message}`, e.kind === "rate_limit" ? 429 : 502, `source_${e.kind}`);
    throw e;
  }
  const contacts = sample.filter((x) => x.recordType === "contact").map((x) => x.record as import("./types").ExtContact);
  const leads = sample.filter((x) => x.recordType === "lead").map((x) => x.record as import("./types").ExtLead);
  const { normalizePhone } = await import("@/lib/phone");
  const phones = contacts.flatMap((c) => (c.phones ?? []).map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)));
  const dupPhones = phones.filter((p, i) => phones.indexOf(p) !== i);
  const existing = await prisma.contact.count({ where: { businessId: user.businessId, phoneE164: { in: [...new Set(phones)] } } });
  const owners = [...new Set([...contacts.map((c) => c.ownerExternalId), ...leads.map((l) => l.ownerExternalId)].filter((x): x is string => Boolean(x)))];
  const statuses = [...new Set(leads.map((l) => l.status).filter((x): x is string => Boolean(x)))];
  return { supported: true, contacts: contacts.length, leads: leads.length, duplicatePhonesInSource: [...new Set(dupPhones)].length, matchingExistingCards: existing, unmappedOwners: owners.filter((o) => !ctx.settings.userMap[o]), unmappedStatuses: statuses.filter((s) => !ctx.settings.statusMap[s]), selectedLeads: leads.filter((l) => (ctx.settings.selection.statuses.length || ctx.settings.selection.lists.length || ctx.settings.selection.owners.length || ctx.settings.selection.teams.length) && (!ctx.settings.selection.statuses.length || ctx.settings.selection.statuses.includes(l.status ?? "")) && (!ctx.settings.selection.lists.length || ctx.settings.selection.lists.includes(l.list ?? ""))).length, note: "היסטוריה מיובאת כהיסטוריה: לא מפעילה אוטומציות של ליד חדש, לא מחייגת ולא שולחת הודעות." };
}

export async function startInitialSync(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const { c, def } = await load(user, id);
  if (c.status !== "active") throw new ApiError("יש לעבור בדיקת חיבור לפני סנכרון", 409, "not_verified");
  if (!def.pull) throw new ApiError("במחבר הזה הרשומות נדחפות מהמערכת החיצונית – אין סנכרון משיכה", 409, "push_only");
  await prisma.crmConnection.update({ where: { id }, data: { syncState: { phase: "initial", recordType: "contact", cursor: null, processed: 0, startedAt: new Date().toISOString() }, nextSyncAt: null } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.initial_started", { connectionId: id });
  return getConnection(user, id);
}

export async function getConnection(user: SessionUser, id: string) {
  const c = await prisma.crmConnection.findFirst({ where: { id, businessId: user.businessId } });
  if (!c) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  return view(c);
}

export async function listConnections(user: SessionUser) {
  await assertIntegrationAdmin(user);
  return (await prisma.crmConnection.findMany({ where: { businessId: user.businessId }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] })).map(view);
}

/** Status screen: connection, freshness, synced counts, pending / failed write-backs, events and review queue. */
export async function connectionStatus(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const c = await getConnection(user, id);
  const [links, outbox, events, reviews, failedEvents, deadOutbox] = await Promise.all([
    prisma.externalRecordLink.groupBy({ by: ["recordType"], where: { businessId: user.businessId, connectionId: id, deletedAt: null }, _count: { _all: true } }),
    prisma.crmOutbox.groupBy({ by: ["status"], where: { businessId: user.businessId, connectionId: id }, _count: { _all: true } }),
    prisma.crmSyncEvent.groupBy({ by: ["status"], where: { businessId: user.businessId, connectionId: id, createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } }, _count: { _all: true } }),
    prisma.crmReviewItem.findMany({ where: { businessId: user.businessId, connectionId: id, status: "open" }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.crmSyncEvent.findMany({ where: { businessId: user.businessId, connectionId: id, status: "failed" }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, eventId: true, recordType: true, externalId: true, error: true, createdAt: true, attempts: true } }),
    prisma.crmOutbox.findMany({ where: { businessId: user.businessId, connectionId: id, status: { in: ["dead", "failed"] } }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, action: true, localType: true, localId: true, lastError: true, attempts: true, status: true, updatedAt: true } }),
  ]);
  const fresh = Boolean(c.status === "active" && c.lastSyncAt && Date.now() - new Date(c.lastSyncAt).getTime() < c.settings.freshnessMinutes * 60_000);
  return { connection: c, fresh, links: Object.fromEntries(links.map((l) => [l.recordType, l._count._all])), outbox: Object.fromEntries(outbox.map((o) => [o.status, o._count._all])), events7d: Object.fromEntries(events.map((e) => [e.status, e._count._all])), reviews, failedEvents, failedOutbox: deadOutbox };
}

/** Resolve a review item. fuzzy_match: link to a chosen card or create a new one; others: retry after fixing mapping. */
export async function resolveReview(user: SessionUser, id: string, reviewId: string, input: unknown) {
  await assertIntegrationAdmin(user);
  const { c } = await load(user, id);
  const b = z.object({ action: z.enum(["link", "create_new", "retry", "dismiss"]), contactId: z.string().max(64).optional() }).parse(input);
  const item = await prisma.crmReviewItem.findFirst({ where: { id: reviewId, businessId: user.businessId, connectionId: id } });
  if (!item) throw new ApiError("פריט הבירור לא נמצא", 404, "not_found");
  const link = await prisma.externalRecordLink.findUnique({ where: { businessId_connectionId_recordType_externalId: { businessId: user.businessId, connectionId: id, recordType: item.recordType, externalId: item.externalId } } });
  const conn = connForIngest(c);
  if (b.action === "link" || b.action === "create_new") {
    if (item.kind !== "fuzzy_match" && item.kind !== "conflict") throw new ApiError("פעולה לא מתאימה לפריט הזה", 400, "validation");
    if (b.action === "link") {
      const target = await prisma.contact.findFirst({ where: { id: b.contactId ?? "", businessId: user.businessId }, select: { id: true } });
      if (!target) throw new ApiError("איש הקשר לא נמצא", 404, "not_found");
      const taken = await prisma.externalRecordLink.findFirst({ where: { businessId: user.businessId, connectionId: id, recordType: "contact", localId: target.id, NOT: { externalId: item.externalId } } });
      if (taken) throw new ApiError("הכרטיס כבר מקושר לרשומה אחרת של אותו חיבור", 409, "already_linked");
      await prisma.externalRecordLink.upsert({ where: { businessId_connectionId_recordType_externalId: { businessId: user.businessId, connectionId: id, recordType: "contact", externalId: item.externalId } }, create: { businessId: user.businessId, connectionId: id, recordType: "contact", externalId: item.externalId, localId: target.id, lastSyncedAt: new Date() }, update: { localId: target.id } });
    } else {
      const snap = (link?.snapshot ?? {}) as unknown as import("./types").ExtContact;
      const { normalizePhone } = await import("@/lib/phone");
      const phone = (snap.phones ?? []).map((p) => normalizePhone(p)).find(Boolean);
      if (!phone) throw new ApiError("לרשומה אין טלפון תקין", 400, "validation");
      // A separate card: the phone already belongs to another card, so it is kept on the new card only as its main number.
      const created = await prisma.contact.create({ data: { businessId: user.businessId, fullName: (snap.name ?? phone).slice(0, 120), phoneE164: phone, phoneRaw: phone, email: null, source: `crm:${c.name}`.slice(0, 100) } }).catch(() => { throw new ApiError("לא ניתן ליצור כרטיס נפרד עם אותו מספר ראשי – יש לקשר לכרטיס קיים", 409, "phone_taken"); });
      await prisma.externalRecordLink.update({ where: { id: link!.id }, data: { localId: created.id } });
    }
  }
  if (b.action === "retry" || b.action === "link" || b.action === "create_new") {
    // Re-apply the last snapshot with the new mapping / link (a new event id, so it is not a duplicate).
    const snap = link?.snapshot as Record<string, unknown> | null;
    if (snap && Object.keys(snap).length) {
      await prisma.externalRecordLink.updateMany({ where: { id: link!.id }, data: { sourceUpdatedAt: null, sourceVersion: null } });
      await applyChange(conn, { eventId: `review:${item.id}:${Date.now()}`, recordType: item.recordType as "contact", record: snap as never }, { kind: "reconcile" });
    }
  }
  await prisma.crmReviewItem.update({ where: { id: item.id }, data: { status: b.action === "dismiss" ? "dismissed" : "resolved", resolution: b.action, resolvedById: user.id, resolvedAt: new Date() } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.review_resolved", { connectionId: id, reviewId, action: b.action });
  return connectionStatus(user, id);
}

/** Controlled reprocessing of failed inbound events / write-backs (audited). */
export async function reprocess(user: SessionUser, id: string, input: unknown) {
  await assertIntegrationAdmin(user);
  const { c } = await load(user, id);
  const b = z.object({ kind: z.enum(["events", "outbox"]), ids: z.array(z.string().max(64)).max(200).optional() }).parse(input);
  let n = 0;
  if (b.kind === "outbox") n = (await prisma.crmOutbox.updateMany({ where: { businessId: user.businessId, connectionId: id, status: { in: ["dead", "failed"] }, ...(b.ids ? { id: { in: b.ids } } : {}) }, data: { status: "pending", attempts: 0, nextAttemptAt: new Date() } })).count;
  else {
    const evs = await prisma.crmSyncEvent.findMany({ where: { businessId: user.businessId, connectionId: id, status: "failed", ...(b.ids ? { id: { in: b.ids } } : {}) }, take: 200 });
    for (const e of evs) { const r = await applyChange(connForIngest(c), { eventId: e.eventId, recordType: e.recordType as "contact", occurredAt: e.occurredAt?.toISOString() ?? null, record: e.payload as never }, { kind: e.kind }); if (r.status !== "failed") n++; }
  }
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.reprocessed", { connectionId: id, kind: b.kind, count: n });
  return { reprocessed: n, status: await connectionStatus(user, id) };
}

/** Disconnect: syncing and write-back stop, its records stop automatic dialing (freshness) – nothing is deleted. */
export async function disconnect(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  await load(user, id);
  await prisma.crmConnection.update({ where: { id }, data: { status: "disconnected", disconnectedAt: new Date() } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.disconnected", { connectionId: id });
  return getConnection(user, id);
}
/** Reconnect: a real test first; then pending write-backs resume and a gap fill runs from the disconnection. */
export async function reconnect(user: SessionUser, id: string) {
  await assertIntegrationAdmin(user);
  const { c, def, ctx } = await load(user, id);
  let r: { ok: boolean; message: string };
  try { r = await def.test(ctx); } catch (e) { r = { ok: false, message: (e as Error).message }; }
  if (!r.ok) throw new ApiError(`בדיקת החיבור נכשלה: ${r.message}`, 409, "test_failed");
  const since = c.disconnectedAt ?? c.lastSyncAt;
  await prisma.crmConnection.update({ where: { id }, data: { status: "active", verifiedAt: new Date(), lastError: null, disconnectedAt: null, nextSyncAt: null, syncState: { ...((c.syncState ?? {}) as object), phase: def.pull ? "gap" : "idle", gapSince: since?.toISOString() ?? null, cursor: null, recordType: "contact" } as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "business", user.businessId, "crm_sync.reconnected", { connectionId: id, gapSince: since });
  return { ...(await getConnection(user, id)), gapSince: since, gapNote: def.pull ? "השלמת הפער מתבצעת אוטומטית מהמקור." : "במחבר הזה המערכת החיצונית צריכה לשלוח מחדש את השינויים מתחילת הניתוק; כתיבה חזרה שממתינה תישלח עכשיו." };
}

export { ConnectorError };
export type { CrmSettings };
