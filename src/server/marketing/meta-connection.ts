/**
 * Meta Ads connection of a business (measurement only). One Meta login per business (OAuth `ads_read`, or a
 * system-user token pasted by an authorized manager), and any number of ad accounts the manager chooses from what
 * that login can see. The token is sealed server-side and never returned; the status shown comes from real Graph
 * answers (debug_token / account reads), never assumed. A WhatsApp connection grants nothing here.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { can, effectiveAccess } from "@/lib/access/engine";
import { sealSecret, openSecret, encryptionConfigured } from "@/lib/crypto";
import { GRAPH_VERSION, graph, metaAppEnv } from "@/lib/meta/graph";
import { appBase } from "@/lib/store-urls";
import { adsGet, AdsApiError } from "./meta-api";

export const ADS_SCOPE = "ads_read";
const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE = "meta_ads_oauth";

export async function assertMarketing(user: SessionUser, action: "view" | "connect") {
  const a = await effectiveAccess(user.businessId, user.id);
  if (!can(a, action === "view" ? "crm.marketing_view" : "crm.marketing_connect")) throw new ApiError(action === "view" ? "אין לך הרשאה לצפות בנתוני שיווק והכנסות" : "אין לך הרשאה לחבר חשבונות פרסום", 403, "action_denied");
  // Revenue and ad spend are business-wide numbers – a team-scoped view would mix team leads with business spend.
  if (!a.isOwner && a.scope !== "business") throw new ApiError("דוח השיווק וההכנסות דורש הרשאה לנתוני כל העסק", 403, "scope_business_required");
  return a;
}

export function oauthReadiness() {
  const env = metaAppEnv();
  const missing: string[] = [];
  if (!env.appId) missing.push("META_APP_ID");
  if (!env.appSecret) missing.push("META_APP_SECRET");
  if (!encryptionConfigured()) missing.push("ENCRYPTION_KEY");
  return { ready: missing.length === 0, missing, redirectUri: `${appBase()}/api/integrations/meta-ads/oauth/callback`, configId: process.env.META_ADS_CONFIG_ID?.trim() || null };
}

const stateSecret = () => { const s = process.env.JWT_SECRET?.trim() || process.env.ENCRYPTION_KEY?.trim(); if (!s) throw new ApiError("השרת לא מוגדר (JWT_SECRET)", 500, "server_config"); return s; };
const hmac = (v: string) => crypto.createHmac("sha256", stateSecret()).update(v).digest("base64url");

/** Signed, expiring state bound to the business, the user and a browser nonce (cookie) – CSRF / mix-up safe. */
export async function oauthStart(user: SessionUser) {
  await assertMarketing(user, "connect");
  const r = oauthReadiness();
  if (!r.ready) throw new ApiError(`חיבור Meta Ads אינו מוגדר בשרת: חסר ${r.missing.join(", ")}`, 409, "meta_ads_not_configured", { missing: r.missing });
  const nonce = crypto.randomBytes(16).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ b: user.businessId, u: user.id, n: nonce, e: Date.now() + STATE_TTL_MS })).toString("base64url");
  const state = `${payload}.${hmac(payload)}`;
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", metaAppEnv().appId!);
  url.searchParams.set("redirect_uri", r.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  // Facebook Login for Business uses a configuration (its permissions are set there); classic login asks ads_read only.
  if (r.configId) url.searchParams.set("config_id", r.configId); else url.searchParams.set("scope", ADS_SCOPE);
  return { url: url.toString(), nonce };
}

export function verifyState(state: string, nonce: string | undefined, user: SessionUser) {
  const [payload, sig] = String(state).split(".");
  if (!payload || !sig || sig.length !== hmac(payload).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(payload)))) throw new ApiError("בקשת החיבור אינה תקפה", 400, "invalid_state");
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as { b: string; u: string; n: string; e: number };
  if (s.e < Date.now()) throw new ApiError("בקשת החיבור פגה – נסו שוב", 400, "state_expired");
  if (!nonce || nonce !== s.n) throw new ApiError("בקשת החיבור לא התחילה בדפדפן הזה", 400, "state_browser_mismatch");
  if (s.b !== user.businessId || s.u !== user.id) throw new ApiError("בקשת החיבור שייכת לעסק או למשתמש אחר", 400, "state_user_mismatch");
}

interface DebugToken { data?: { is_valid?: boolean; user_id?: string; scopes?: string[]; expires_at?: number; data_access_expires_at?: number; error?: { message?: string } } }

/** Real token facts from Meta (validity, scopes, expiry, user) – with the app token. */
export async function debugToken(token: string) {
  const env = metaAppEnv();
  const d = await adsGet<DebugToken>("debug_token", `${env.appId}|${env.appSecret}`, { input_token: token });
  return { valid: Boolean(d.data?.is_valid), userId: d.data?.user_id ?? null, scopes: d.data?.scopes ?? [], expiresAt: d.data?.expires_at ? new Date(d.data.expires_at * 1000) : null };
}

export async function oauthCallback(user: SessionUser, input: { code?: string | null; state?: string | null; error?: string | null; nonce?: string }) {
  await assertMarketing(user, "connect");
  verifyState(input.state ?? "", input.nonce, user);
  if (input.error || !input.code) throw new ApiError("החיבור בוטל או נדחה ב-Meta", 400, "oauth_denied");
  const env = metaAppEnv(); const r = oauthReadiness();
  if (!r.ready) throw new ApiError("חיבור Meta Ads אינו מוגדר בשרת", 409, "meta_ads_not_configured");
  const short = await adsGet<{ access_token?: string }>("oauth/access_token", "", { client_id: env.appId!, client_secret: env.appSecret!, redirect_uri: r.redirectUri, code: input.code }).catch((e: AdsApiError) => { throw new ApiError(`Meta לא אישרה את קוד החיבור: ${e.message}`, 400, "oauth_exchange"); });
  if (!short.access_token) throw new ApiError("Meta לא החזירה אסימון", 400, "oauth_exchange");
  // Long-lived user token (about 60 days); Meta returns the expiry, which is stored and shown.
  const long = await adsGet<{ access_token?: string }>("oauth/access_token", "", { grant_type: "fb_exchange_token", client_id: env.appId!, client_secret: env.appSecret!, fb_exchange_token: short.access_token }).catch(() => ({ access_token: short.access_token }));
  const token = long.access_token ?? short.access_token;
  const facts = await debugToken(token);
  if (!facts.valid) throw new ApiError("האסימון שהתקבל אינו תקף", 400, "token_invalid");
  if (!facts.scopes.includes(ADS_SCOPE)) throw new ApiError("לא ניתנה הרשאת ads_read – בלי הרשאה זו אין גישה לנתוני פרסום. חברו מחדש ואשרו את ההרשאה.", 400, "scope_missing", { scopes: facts.scopes });
  const me = await adsGet<{ id: string; name?: string }>("me", token, { fields: "id,name" });
  await saveConnection(user, { kind: "oauth", token, metaUserId: me.id, metaUserName: me.name ?? null, scopes: facts.scopes, expiresAt: facts.expiresAt });
  return { connected: true };
}

async function saveConnection(user: SessionUser, c: { kind: "oauth" | "manual_token"; token: string; metaUserId: string | null; metaUserName: string | null; scopes: string[]; expiresAt: Date | null; legacyAccount?: { id: string; name: string } }) {
  if (!encryptionConfigured()) throw new ApiError("יש להגדיר הצפנת חיבורים בשרת לפני חיבור חשבון", 409, "encryption_missing");
  const data = { kind: c.kind, tokenSealed: sealSecret(c.token), metaUserId: c.metaUserId, metaUserName: c.metaUserName, scopes: c.scopes, tokenExpiresAt: c.expiresAt, status: "active", lastError: null, lastCheckedAt: new Date(), verifiedAt: new Date(), connectedById: user.id, ...(c.legacyAccount ? { accountId: c.legacyAccount.id, accountName: c.legacyAccount.name } : {}) };
  const conn = await prisma.metaAdConnection.upsert({ where: { businessId: user.businessId }, create: { businessId: user.businessId, ...data }, update: data });
  // Accounts that failed on the old login get another chance with the new one.
  await prisma.metaAdAccount.updateMany({ where: { businessId: user.businessId, status: { in: ["auth_error", "no_access"] } }, data: { status: "active", connectionId: conn.id, nextSyncAt: null, failures: 0 } });
  await audit(user.businessId, user.id, "business", user.businessId, "marketing.meta_connected", { kind: c.kind, metaUserId: c.metaUserId, scopes: c.scopes, expiresAt: c.expiresAt });
  return conn;
}

/** Manual path (system-user token): verified against the account before anything is saved. */
export async function connectManualToken(user: SessionUser, input: unknown) {
  await assertMarketing(user, "connect");
  const b = z.object({ accountId: z.string().regex(/^(act_)?\d{3,30}$/), accessToken: z.string().min(10).max(4096) }).parse(input);
  const accountId = b.accountId.replace(/^act_/, "");
  let acc: { account_id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number };
  try { acc = await graph(`act_${accountId}`, { token: b.accessToken, query: { fields: "account_id,name,currency,timezone_name,account_status" } }); }
  catch { throw new ApiError("Meta לא אישרה גישה לחשבון. בדוק מזהה חשבון, תוקף אסימון והרשאת ads_read.", 400, "meta_access"); }
  if (acc.account_id !== accountId) throw new ApiError("החשבון שהוחזר אינו תואם", 400, "account_mismatch");
  const conn = await saveConnection(user, { kind: "manual_token", token: b.accessToken, metaUserId: null, metaUserName: null, scopes: [ADS_SCOPE], expiresAt: null, legacyAccount: { id: accountId, name: String(acc.name ?? accountId).slice(0, 200) } });
  await upsertAccount(user, conn.id, acc, 90);
  return connectionStatus(user);
}

type GraphAccount = { account_id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number };
async function upsertAccount(user: SessionUser, connectionId: string, a: GraphAccount, days: number) {
  const syncFrom = new Date(Date.now() - days * 86400_000); syncFrom.setUTCHours(0, 0, 0, 0);
  const data = { name: String(a.name ?? a.account_id).slice(0, 200), currency: a.currency ?? null, timezoneName: a.timezone_name ?? null, accountStatus: a.account_status ?? null, connectionId, status: "active" };
  const existing = await prisma.metaAdAccount.findUnique({ where: { businessId_accountId: { businessId: user.businessId, accountId: a.account_id } } });
  if (existing) return prisma.metaAdAccount.update({ where: { id: existing.id }, data: { ...data, nextSyncAt: null, failures: 0, ...(existing.syncFrom && existing.syncFrom <= syncFrom ? {} : { syncFrom, syncedThrough: null }) } });
  return prisma.metaAdAccount.create({ data: { businessId: user.businessId, accountId: a.account_id, syncFrom, ...data } });
}

async function tokenOf(businessId: string) {
  const conn = await prisma.metaAdConnection.findUnique({ where: { businessId } });
  if (!conn || conn.status === "revoked") return null;
  const token = openSecret(conn.tokenSealed);
  return token ? { conn, token } : null;
}

/** Ad accounts the connected Meta login can read (to choose from). */
export async function availableAccounts(user: SessionUser) {
  await assertMarketing(user, "connect");
  const t = await tokenOf(user.businessId);
  if (!t) throw new ApiError("אין חיבור Meta פעיל", 409, "not_connected");
  if (t.conn.kind === "manual_token") {
    const connected = await prisma.metaAdAccount.findMany({ where: { businessId: user.businessId }, select: { accountId: true, name: true, currency: true, timezoneName: true } });
    return { items: connected.map((a) => ({ accountId: a.accountId, name: a.name, currency: a.currency, timezoneName: a.timezoneName, accountStatus: null, connected: true })), manual: true };
  }
  try {
    const { adsGetAll } = await import("./meta-api");
    const rows = await adsGetAll<GraphAccount>("me/adaccounts", t.token, { fields: "account_id,name,currency,timezone_name,account_status", limit: "100" }, 10);
    const connected = new Set((await prisma.metaAdAccount.findMany({ where: { businessId: user.businessId, status: { not: "disconnected" } }, select: { accountId: true } })).map((a) => a.accountId));
    return { items: rows.map((a) => ({ accountId: a.account_id, name: a.name ?? a.account_id, currency: a.currency ?? null, timezoneName: a.timezone_name ?? null, accountStatus: a.account_status ?? null, connected: connected.has(a.account_id) })), manual: false };
  } catch (e) {
    if (e instanceof AdsApiError && e.kind === "auth") await markAuthProblem(user.businessId, e.message);
    throw new ApiError(`לא ניתן לקרוא את חשבונות הפרסום מ-Meta: ${(e as Error).message}`, 502, "meta_read_failed");
  }
}

/** Choose which ad accounts belong to this business (and how far back to sync). Unchosen ones stop syncing, data kept. */
export async function setAccounts(user: SessionUser, input: unknown) {
  await assertMarketing(user, "connect");
  const b = z.object({ accountIds: z.array(z.string().regex(/^\d{3,30}$/)).max(50), historyDays: z.number().int().min(7).max(1095).default(90) }).parse(input);
  const t = await tokenOf(user.businessId);
  if (!t) throw new ApiError("אין חיבור Meta פעיל", 409, "not_connected");
  const avail = await availableAccounts(user);
  const byId = new Map(avail.items.map((a) => [a.accountId, a]));
  for (const id of b.accountIds) if (!byId.has(id)) throw new ApiError(`החשבון ${id} אינו זמין בחיבור הזה`, 400, "account_not_available");
  for (const id of b.accountIds) { const a = byId.get(id)!; await upsertAccount(user, t.conn.id, { account_id: id, name: a.name, currency: a.currency ?? undefined, timezone_name: a.timezoneName ?? undefined, account_status: a.accountStatus ?? undefined }, b.historyDays); }
  await prisma.metaAdAccount.updateMany({ where: { businessId: user.businessId, accountId: { notIn: b.accountIds }, status: { not: "disconnected" } }, data: { status: "disconnected" } });
  await audit(user.businessId, user.id, "business", user.businessId, "marketing.meta_accounts_set", { accountIds: b.accountIds, historyDays: b.historyDays });
  return connectionStatus(user);
}

/** Disconnect: the token is deleted; synced history stays (marked disconnected) unless the manager asks to delete it. */
export async function disconnect(user: SessionUser, opts: { deleteData?: boolean } = {}) {
  await assertMarketing(user, "connect");
  await prisma.metaAdConnection.deleteMany({ where: { businessId: user.businessId } });
  if (opts.deleteData) await prisma.metaAdAccount.deleteMany({ where: { businessId: user.businessId } });
  else await prisma.metaAdAccount.updateMany({ where: { businessId: user.businessId }, data: { status: "disconnected" } });
  await audit(user.businessId, user.id, "business", user.businessId, "marketing.meta_disconnected", { deleteData: Boolean(opts.deleteData) });
  return { disconnected: true };
}

export async function markAuthProblem(businessId: string, message: string, status: "expired" | "revoked" | "error" = "expired") {
  await prisma.metaAdConnection.updateMany({ where: { businessId }, data: { status, lastError: message.slice(0, 300), lastCheckedAt: new Date() } });
  await prisma.metaAdAccount.updateMany({ where: { businessId, status: { in: ["active", "throttled", "error"] } }, data: { status: "auth_error", lastSyncStatus: "auth_error", lastSyncError: message.slice(0, 300) } });
}

/** Meta deauthorize callback for a user who connected ads: that login stops working at once. */
export async function revokeByMetaUser(metaUserId: string) {
  const { withBusiness, withoutBusiness } = await import("@/lib/tenant");
  // A Meta user may have connected several businesses – found across businesses, then each one updated in its own context.
  const { db } = await import("@/lib/db");
  const conns = await withoutBusiness(() => db.metaAdConnection.findMany({ where: { metaUserId }, select: { businessId: true } }));
  for (const c of conns) await withBusiness(c.businessId, () => markAuthProblem(c.businessId, "ההרשאה הוסרה ב-Meta", "revoked"));
  return conns.length;
}

export async function connectionStatus(user: SessionUser) {
  const [conn, accounts, access] = await Promise.all([
    prisma.metaAdConnection.findUnique({ where: { businessId: user.businessId }, select: { kind: true, status: true, metaUserName: true, scopes: true, tokenExpiresAt: true, lastError: true, lastCheckedAt: true, verifiedAt: true, accountId: true, accountName: true } }),
    prisma.metaAdAccount.findMany({ where: { businessId: user.businessId }, orderBy: { createdAt: "asc" }, select: { id: true, accountId: true, name: true, currency: true, timezoneName: true, status: true, syncFrom: true, syncedThrough: true, lastSyncAt: true, lastSyncStatus: true, lastSyncError: true, nextSyncAt: true } }),
    effectiveAccess(user.businessId, user.id),
  ]);
  const expiresSoon = Boolean(conn?.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() < 7 * 86400_000);
  return { connection: conn, accounts, expiresSoon, canManage: can(access, "crm.marketing_connect") && (access.isOwner || access.scope === "business"), oauth: oauthReadiness(), encryptionReady: encryptionConfigured() };
}
