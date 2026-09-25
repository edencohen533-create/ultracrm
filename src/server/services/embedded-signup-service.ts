/**
 * Meta WhatsApp Embedded Signup (Tech Provider flow, Cloud API).
 *
 * Browser: FB.login({ config_id, response_type: "code" }) → `WA_EMBEDDED_SIGNUP` message
 * with { phone_number_id, waba_id, business_id } → exchangeable code (TTL 30 s).
 * Server (this file):
 *   1. session bound to business+user (`state`) – CSRF / cross-business protection,
 *      single use (status CAS), one active session per business (double-click guard).
 *   2. GET /oauth/access_token (client_id, client_secret, code) → business token.
 *   3. GET /debug_token – both WhatsApp scopes + granular access to the WABA.
 *   4. GET /{waba_id}, GET /{waba_id}/phone_numbers, GET /{phone_number_id} – the assets
 *      really belong to the granted WABA.
 *   5. POST /{waba_id}/subscribed_apps – webhooks for this WABA reach our app.
 *   6. POST /{phone_number_id}/register { messaging_product, pin } – Cloud API registration.
 *   7. Persist ProviderCredential (token sealed at rest) with a *real* status.
 * Partial failures keep the token and set `needs_action`; `retrySetup` re-runs 5–6 idempotently.
 */
import crypto from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { WaConnectionStatus } from "@/generated/prisma/enums";
import { db, prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { appAccessToken, embeddedSignupReadiness, graph, GraphError, metaAppEnv, metaConfigOf, sealMetaConfig, GRAPH_VERSION } from "@/lib/meta/graph";
import { openSecret } from "@/lib/crypto";
import type { SessionUser } from "@/lib/auth";

export const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;
const SESSION_TTL_MS = 15 * 60_000;

export class SignupError extends ApiError {}

// ─── Session (CSRF / replay / parallel) ─────────────────────────────────────

export async function startSignup(user: SessionUser) {
  const readiness = embeddedSignupReadiness();
  if (!readiness.ready) throw new SignupError(`Embedded Signup אינו מוגדר בשרת. חסר: ${readiness.missing.join(", ")}`, 503, "signup_not_configured", { missing: readiness.missing });
  const now = new Date();
  // One in-flight attempt per business: a second click re-uses it instead of opening a parallel flow.
  const active = await prisma.whatsAppSignupSession.findFirst({ where: { businessId: user.businessId, status: "started", expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
  if (active && active.userId === user.id) return { session: active, appId: readiness.appId!, configId: readiness.configId!, version: GRAPH_VERSION, reused: true };
  if (active) throw new SignupError("תהליך חיבור אחר כבר פתוח בעסק על ידי משתמש אחר – יש לחכות לסיומו", 409, "signup_in_progress");
  const session = await prisma.whatsAppSignupSession.create({
    data: { businessId: user.businessId, userId: user.id, state: crypto.randomBytes(32).toString("base64url"), status: "started", expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
  });
  await audit(user.businessId, user.id, "whatsapp", session.id, "whatsapp.signup_started");
  return { session, appId: readiness.appId!, configId: readiness.configId!, version: GRAPH_VERSION, reused: false };
}

export async function cancelSignup(user: SessionUser, state: string, reason: string | undefined, step?: string) {
  const r = await prisma.whatsAppSignupSession.updateMany({ where: { state, businessId: user.businessId, userId: user.id, status: "started" }, data: { status: "cancelled", step: step ?? null, error: reason?.slice(0, 500) ?? null } });
  if (r.count) await audit(user.businessId, user.id, "whatsapp", state.slice(0, 12), "whatsapp.signup_cancelled", { reason, step });
  return { cancelled: r.count > 0 };
}

/** Claim the session for this code exactly once (CAS on status). */
async function claimSession(user: SessionUser, state: string, code: string, assets: { wabaId?: string; phoneNumberId?: string; metaBusinessId?: string }) {
  const session = await prisma.whatsAppSignupSession.findUnique({ where: { state } });
  if (!session || session.businessId !== user.businessId || session.userId !== user.id) throw new SignupError("תהליך החיבור אינו שייך למשתמש/עסק הנוכחי", 403, "signup_state_mismatch");
  if (session.expiresAt < new Date()) throw new SignupError("תהליך החיבור פג תוקף – התחל מחדש", 410, "signup_expired");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  if (session.codeHash && session.codeHash === codeHash) throw new SignupError("קוד ההרשאה כבר נוצל", 409, "code_reused");
  const claimed = await prisma.whatsAppSignupSession.updateMany({
    where: { id: session.id, status: "started" },
    data: { status: "code_received", codeHash, wabaId: assets.wabaId ?? null, phoneNumberId: assets.phoneNumberId ?? null, metaBusinessId: assets.metaBusinessId ?? null },
  });
  if (!claimed.count) throw new SignupError("תהליך החיבור כבר בטיפול (לחיצה כפולה?) – המתן לסיומו", 409, "signup_already_claimed");
  return session;
}

// ─── Meta calls ──────────────────────────────────────────────────────────────

interface DebugToken { data: { app_id?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[]; granular_scopes?: Array<{ scope: string; target_ids?: string[] }>; type?: string } }
interface PhoneInfo { id: string; display_phone_number?: string; verified_name?: string; name_status?: string; code_verification_status?: string; quality_rating?: string; status?: string; platform_type?: string }
interface WabaInfo { id: string; name?: string; account_review_status?: string; business_verification_status?: string; ownership_type?: string }

export async function exchangeCode(code: string) {
  const env = metaAppEnv();
  const r = await graph<{ access_token: string; token_type?: string; expires_in?: number }>("oauth/access_token", { query: { client_id: env.appId!, client_secret: env.appSecret!, code } });
  if (!r.access_token) throw new SignupError("Meta לא החזירה access token", 502, "token_exchange_failed");
  return { accessToken: r.access_token, expiresIn: r.expires_in ?? null };
}

/** Verify what the business granted: both scopes and access to the WABA. */
export async function verifyToken(accessToken: string, wabaId: string) {
  const r = await graph<DebugToken>("debug_token", { query: { input_token: accessToken, access_token: appAccessToken() } });
  const d = r.data ?? {};
  if (d.is_valid === false) throw new SignupError("ה-token שהתקבל אינו תקף", 502, "token_invalid");
  const env = metaAppEnv();
  if (d.app_id && env.appId && d.app_id !== env.appId) throw new SignupError("ה-token שייך לאפליקציה אחרת", 502, "token_app_mismatch");
  const scopes = d.scopes ?? [];
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) throw new SignupError(`ההרשאות הבאות לא אושרו: ${missing.join(", ")}`, 422, "scopes_missing", { missing });
  const granular = d.granular_scopes ?? [];
  const wabaTargets = new Set(granular.filter((g) => REQUIRED_SCOPES.includes(g.scope as (typeof REQUIRED_SCOPES)[number])).flatMap((g) => g.target_ids ?? []));
  // Empty target list = access to all of the business's WABAs; otherwise the WABA must be listed.
  const hasAccess = granular.length === 0 || wabaTargets.size === 0 || wabaTargets.has(wabaId);
  if (!hasAccess) throw new SignupError("ההרשאה שניתנה אינה כוללת את חשבון ה-WhatsApp שנבחר", 422, "waba_not_granted", { wabaId });
  return { scopes, granularScopes: granular, expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null, tokenType: d.type ?? null };
}

export async function readAssets(accessToken: string, wabaId: string, phoneNumberId: string) {
  const waba = await graph<WabaInfo>(wabaId, { token: accessToken, query: { fields: "id,name,account_review_status,business_verification_status,ownership_type" } });
  const phone = await graph<PhoneInfo>(phoneNumberId, { token: accessToken, query: { fields: "id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type" } });
  // The phone must belong to the granted WABA (never trust ids posted from the window alone).
  let belongs = false;
  let after: string | undefined;
  for (let page = 0; page < 10 && !belongs; page++) {
    const list = await graph<{ data: PhoneInfo[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${wabaId}/phone_numbers`, { token: accessToken, query: { fields: "id", limit: "100", after } });
    belongs = (list.data ?? []).some((p) => p.id === phoneNumberId);
    if (!list.paging?.next || !list.paging.cursors?.after) break;
    after = list.paging.cursors.after;
  }
  if (!belongs) throw new SignupError("המספר שנבחר אינו שייך לחשבון ה-WhatsApp שאושר", 422, "phone_not_in_waba");
  return { waba, phone };
}

export async function subscribeApp(accessToken: string, wabaId: string) {
  await graph(`${wabaId}/subscribed_apps`, { method: "POST", token: accessToken });
}

export async function isAppSubscribed(accessToken: string, wabaId: string) {
  const env = metaAppEnv();
  const r = await graph<{ data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }> }>(`${wabaId}/subscribed_apps`, { token: accessToken });
  const apps = r.data ?? [];
  if (!env.appId) return apps.length > 0;
  return apps.some((a) => a.whatsapp_business_api_data?.id === env.appId);
}

export async function unsubscribeApp(accessToken: string, wabaId: string) {
  await graph(`${wabaId}/subscribed_apps`, { method: "DELETE", token: accessToken });
}

/** Register for Cloud API. `pin` = existing 2FA pin or a new one. Returns "pin_required" when Meta needs the customer's existing pin. */
export async function registerPhone(accessToken: string, phoneNumberId: string, pin: string): Promise<"registered" | "pin_required"> {
  try {
    await graph(`${phoneNumberId}/register`, { method: "POST", token: accessToken, body: { messaging_product: "whatsapp", pin } });
    return "registered";
  } catch (err) {
    if (err instanceof GraphError && (err.subcode === 2388093 || /pin|two.step|2fa/i.test(err.message))) return "pin_required";
    throw err;
  }
}

function newPin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// ─── Status derivation ───────────────────────────────────────────────────────

export interface Readiness {
  status: WaConnectionStatus;
  sendReady: boolean;
  receiveReady: boolean;
  /** Human-readable blockers (Hebrew). */
  blockers: string[];
}

export function deriveReadiness(c: { status: WaConnectionStatus; isActive: boolean; sendingBlocked: boolean; subscribedAt: Date | null; registeredAt: Date | null; codeVerificationStatus: string | null; tokenCheckedAt: Date | null; lastWebhookAt: Date | null; grantedScopes: unknown; lastConnectionError?: string | null }): Readiness {
  const blockers: string[] = [];
  if (!c.isActive) return { status: c.status === "revoked" ? "revoked" : "disconnected", sendReady: false, receiveReady: false, blockers: ["החיבור מנותק"] };
  if (c.status === "revoked") return { status: "revoked", sendReady: false, receiveReady: false, blockers: ["ההרשאה בוטלה בצד Meta – נדרש חיבור מחדש"] };
  if (c.status === "error") return { status: "error", sendReady: false, receiveReady: false, blockers: [c.lastConnectionError ?? "תקלה בחיבור"] };
  // A recorded reason for "needs_action" is authoritative until the next successful setup/check clears it.
  if (c.status === "needs_action" && c.lastConnectionError) blockers.push(c.lastConnectionError);
  const scopes = Array.isArray(c.grantedScopes) ? (c.grantedScopes as string[]) : [];
  if (!c.tokenCheckedAt) blockers.push("ההרשאה טרם אומתה מול Meta");
  else for (const s of REQUIRED_SCOPES) if (scopes.length && !scopes.includes(s)) blockers.push(`חסרה הרשאה ${s}`);
  if (!c.subscribedAt) blockers.push("האפליקציה אינה רשומה לאירועי ה-WABA (subscribed_apps)");
  if (!c.registeredAt) blockers.push("המספר אינו רשום ל-Cloud API (register)");
  if (c.codeVerificationStatus && !["VERIFIED", "verified"].includes(c.codeVerificationStatus)) blockers.push(`אימות המספר אצל Meta: ${c.codeVerificationStatus}`);
  if (c.sendingBlocked) blockers.push("Meta דחתה שליחה לאחרונה (token/הרשאות) – יש לבדוק חיבור");
  const sendReady = blockers.length === 0;
  const receiveReady = Boolean(c.subscribedAt) && !c.sendingBlocked;
  const status: WaConnectionStatus = c.status === "in_progress" ? "in_progress" : sendReady && receiveReady ? "connected" : c.status === "needs_action" ? "needs_action" : "connected_not_ready";
  return { status, sendReady, receiveReady, blockers };
}

// ─── Complete / retry ────────────────────────────────────────────────────────

export interface CompleteInput { state: string; code: string; wabaId: string; phoneNumberId: string; metaBusinessId?: string; label?: string; teamId?: string | null }

export async function completeSignup(user: SessionUser, input: CompleteInput) {
  const readiness = embeddedSignupReadiness();
  if (!readiness.ready) throw new SignupError(`Embedded Signup אינו מוגדר בשרת. חסר: ${readiness.missing.join(", ")}`, 503, "signup_not_configured");
  const session = await claimSession(user, input.state, input.code, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, metaBusinessId: input.metaBusinessId });
  const fail = async (err: unknown, step: string) => {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.whatsAppSignupSession.update({ where: { id: session.id }, data: { status: "failed", step, error: message.slice(0, 500) } });
    await audit(user.businessId, user.id, "whatsapp", session.id, "whatsapp.signup_failed", { step, error: message.slice(0, 300) });
  };

  // 2. code → business token (server only; the 30 s TTL means we do this first).
  let accessToken: string;
  try { ({ accessToken } = await exchangeCode(input.code)); }
  catch (err) { await fail(err, "token_exchange"); throw err instanceof SignupError ? err : new SignupError("החלפת קוד ההרשאה מול Meta נכשלה (הקוד תקף ל-30 שניות בלבד) – נסה שוב", 502, "token_exchange_failed"); }

  // 3–4. verify grant + assets before touching any business record.
  let verified: Awaited<ReturnType<typeof verifyToken>>;
  let assets: Awaited<ReturnType<typeof readAssets>>;
  try {
    verified = await verifyToken(accessToken, input.wabaId);
    assets = await readAssets(accessToken, input.wabaId, input.phoneNumberId);
  } catch (err) { await fail(err, "verify_assets"); throw err; }

  // Conflicts: the phone (globally unique) must not belong to another business; one WABA per business.
  const foreign = await db.providerCredential.findFirst({ where: { phoneNumberId: input.phoneNumberId, businessId: { not: user.businessId } }, select: { id: true } });
  if (foreign) { await fail(new Error("phone bound to another business"), "conflict"); throw new SignupError("המספר הזה כבר מחובר לעסק אחר במערכת. יש לנתק אותו שם לפני חיבור כאן", 409, "phone_bound_elsewhere"); }
  const otherWaba = await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", wabaId: { not: input.wabaId } }, select: { id: true, wabaId: true } });
  if (otherWaba) { await fail(new Error("another WABA active"), "conflict"); throw new SignupError("בעסק זה כבר מחובר חשבון WhatsApp אחר. נתק אותו לפני חיבור חשבון חדש", 409, "waba_conflict"); }

  // 7. persist first (token sealed) so a failure in 5–6 can be retried without a new signup.
  const existing = await prisma.providerCredential.findFirst({ where: { provider: "meta_whatsapp_cloud_api", phoneNumberId: input.phoneNumberId } });
  const pin = existing ? (openSecret((existing.config as Record<string, string>).twoStepPin) ?? newPin()) : newPin();
  const env = metaAppEnv();
  const config = sealMetaConfig({ accessToken, phoneNumberId: input.phoneNumberId, businessAccountId: input.wabaId, webhookVerifyToken: env.webhookVerifyToken!, apiVersion: GRAPH_VERSION, twoStepPin: pin });
  const base = {
    wabaId: input.wabaId, wabaName: assets.waba.name ?? null, metaBusinessId: input.metaBusinessId ?? null, phoneNumberId: input.phoneNumberId,
    displayPhoneNumber: assets.phone.display_phone_number ?? null, verifiedName: assets.phone.verified_name ?? null, nameStatus: assets.phone.name_status ?? null,
    qualityRating: assets.phone.quality_rating ?? null, codeVerificationStatus: assets.phone.code_verification_status ?? null, platformType: assets.phone.platform_type ?? null,
    connectionMethod: "embedded_signup", status: "in_progress" as WaConnectionStatus, grantedScopes: verified.scopes as Prisma.InputJsonValue, tokenCheckedAt: new Date(),
    config: config as Prisma.InputJsonValue, isActive: true, sendingBlocked: false, lastConnectionError: null, lastCheckedAt: new Date(),
    ...(input.label !== undefined ? { label: input.label } : {}), ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
  };
  const credential = await prisma.$transaction(async (tx) => {
    const hasDefault = await tx.providerCredential.findFirst({ where: { isActive: true, isDefault: true, channel: "whatsapp", id: { not: existing?.id } }, select: { id: true } });
    const row = existing
      ? await tx.providerCredential.update({ where: { id: existing.id }, data: { ...base, isDefault: existing.isDefault || !hasDefault } })
      : await tx.providerCredential.create({ data: { businessId: user.businessId, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isDefault: !hasDefault, ...base } });
    await tx.whatsAppSignupSession.update({ where: { id: session.id }, data: { credentialId: row.id, step: "assets_verified" } });
    return row;
  });

  // 5–6. subscribe + register (idempotent; failures → needs_action with the reason).
  const result = await runSetupSteps(user, credential.id, accessToken, pin);
  await prisma.whatsAppSignupSession.update({ where: { id: session.id }, data: { status: "completed", step: result.step, error: result.error ?? null } });
  await audit(user.businessId, user.id, "whatsapp", credential.id, "whatsapp.signup_completed", { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, status: result.status, scopes: verified.scopes });
  return { credentialId: credential.id, ...result };
}

/** Steps 5–6. Safe to re-run: checks current state at Meta before acting. */
export async function runSetupSteps(user: SessionUser, credentialId: string, accessToken?: string, pinOverride?: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id: credentialId, provider: "meta_whatsapp_cloud_api" } });
  if (!c || !c.wabaId || !c.phoneNumberId) throw new SignupError("החיבור לא נמצא", 404, "not_found");
  const cfg = metaConfigOf(c.config);
  const token = accessToken ?? cfg.accessToken;
  const pin = pinOverride ?? cfg.twoStepPin ?? newPin();
  let step = "subscribe";
  let error: string | undefined;
  let status: WaConnectionStatus = "connected_not_ready";
  const data: Prisma.ProviderCredentialUncheckedUpdateInput = { lastCheckedAt: new Date() };
  try {
    if (!(await isAppSubscribed(token, c.wabaId))) await subscribeApp(token, c.wabaId);
    data.subscribedAt = c.subscribedAt ?? new Date();
    step = "register";
    const reg = await registerPhone(token, c.phoneNumberId, pin);
    if (reg === "pin_required") {
      status = "needs_action";
      data.registeredAt = null;
      error = "המספר מוגן בקוד אימות דו-שלבי קיים. הזן את הקוד (6 ספרות) ולחץ \"השלם הגדרה\"";
    } else {
      data.registeredAt = new Date();
      if (pinOverride && pinOverride !== cfg.twoStepPin) data.config = sealMetaConfig({ ...cfg, twoStepPin: pinOverride }) as Prisma.InputJsonValue;
      step = "done";
    }
  } catch (err) {
    status = "needs_action";
    if (step === "subscribe") data.subscribedAt = null; else data.registeredAt = null;
    error = err instanceof GraphError ? `Meta: ${err.message} (code ${err.code ?? "?"})` : err instanceof Error ? err.message : String(err);
  }
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { ...data, status, lastConnectionError: error ?? null } });
  const readiness = deriveReadiness(updated);
  if (readiness.status !== updated.status) await prisma.providerCredential.update({ where: { id: c.id }, data: { status: readiness.status } });
  await audit(user.businessId, user.id, "whatsapp", c.id, "whatsapp.setup_steps", { step, status: readiness.status, error });
  return { status: readiness.status, step, error, readiness };
}

/** "בדוק חיבור": re-validate token, scopes, subscription and phone state at Meta. Never fakes success. */
export async function checkConnection(user: SessionUser, credentialId: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id: credentialId, provider: "meta_whatsapp_cloud_api" } });
  if (!c || !c.wabaId || !c.phoneNumberId) throw new SignupError("החיבור לא נמצא", 404, "not_found");
  const cfg = metaConfigOf(c.config);
  const data: Prisma.ProviderCredentialUncheckedUpdateInput = { lastCheckedAt: new Date() };
  let status: WaConnectionStatus = c.status;
  let error: string | null = null;
  try {
    if (c.connectionMethod === "embedded_signup" && metaAppEnv().appSecret) {
      const v = await verifyToken(cfg.accessToken, c.wabaId);
      data.grantedScopes = v.scopes as Prisma.InputJsonValue;
      data.tokenCheckedAt = new Date();
    }
    const assets = await readAssets(cfg.accessToken, c.wabaId, c.phoneNumberId);
    Object.assign(data, { wabaName: assets.waba.name ?? null, displayPhoneNumber: assets.phone.display_phone_number ?? null, verifiedName: assets.phone.verified_name ?? null, nameStatus: assets.phone.name_status ?? null, qualityRating: assets.phone.quality_rating ?? null, codeVerificationStatus: assets.phone.code_verification_status ?? null, platformType: assets.phone.platform_type ?? null });
    data.subscribedAt = (await isAppSubscribed(cfg.accessToken, c.wabaId)) ? (c.subscribedAt ?? new Date()) : null;
    data.sendingBlocked = false;
    status = c.status === "revoked" ? "connected_not_ready" : c.status;
  } catch (err) {
    const revokedCodes = ["token_invalid", "token_app_mismatch", "scopes_missing", "waba_not_granted"];
    if ((err instanceof GraphError && [190, 10, 200].includes(err.code ?? -1)) || (err instanceof SignupError && revokedCodes.includes(err.code))) { status = "revoked"; error = err instanceof SignupError && err.code !== "token_invalid" ? err.message : "ההרשאה בוטלה או פגה בצד Meta – נדרש חיבור מחדש"; data.sendingBlocked = true; }
    else if (err instanceof SignupError) { status = "needs_action"; error = err.message; }
    else { status = "error"; error = err instanceof Error ? err.message : String(err); }
  }
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { ...data, status, lastConnectionError: error } });
  const readiness = deriveReadiness(updated);
  if (readiness.status !== updated.status) await prisma.providerCredential.update({ where: { id: c.id }, data: { status: readiness.status } });
  await audit(user.businessId, user.id, "whatsapp", c.id, "whatsapp.connection_checked", { status: readiness.status, blockers: readiness.blockers, error });
  return { ...readiness, error, checkedAt: new Date().toISOString() };
}

/** Disconnect: stop future sends, unsubscribe our app from the WABA (only if no other active number of this business uses it), keep history. */
export async function disconnectConnection(user: SessionUser, credentialId: string, reason?: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id: credentialId, provider: "meta_whatsapp_cloud_api" } });
  if (!c) throw new SignupError("החיבור לא נמצא", 404, "not_found");
  const cfg = metaConfigOf(c.config);
  let unsubscribed = false;
  let warning: string | null = null;
  if (c.wabaId && cfg.accessToken && c.status !== "revoked") {
    const sibling = await prisma.providerCredential.findFirst({ where: { isActive: true, wabaId: c.wabaId, id: { not: c.id } }, select: { id: true } });
    if (!sibling) {
      try { await unsubscribeApp(cfg.accessToken, c.wabaId); unsubscribed = true; }
      catch (err) { warning = `ביטול הרשמת האירועים ב-Meta נכשל (${err instanceof Error ? err.message : "?"}) – החיבור נותק במערכת בלבד`; }
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.providerCredential.update({ where: { id: c.id }, data: { isActive: false, isDefault: false, status: "disconnected", subscribedAt: unsubscribed ? null : c.subscribedAt, lastConnectionError: warning } });
    if (c.isDefault) {
      const next = await tx.providerCredential.findFirst({ where: { isActive: true, channel: "whatsapp", id: { not: c.id } }, orderBy: { createdAt: "asc" } });
      if (next) await tx.providerCredential.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
  await audit(user.businessId, user.id, "whatsapp", c.id, "whatsapp.disconnected", { reason, unsubscribed, warning });
  return { disconnected: true, unsubscribed, warning };
}

/** Webhook `account_update` for a WABA (e.g. PARTNER_REMOVED / DISABLED_UPDATE) → mark every number of that WABA. */
export async function applyAccountUpdate(wabaId: string, event: string, detail?: Record<string, unknown>) {
  const revoke = ["PARTNER_REMOVED", "DISABLED_UPDATE", "ACCOUNT_DELETED", "PARTNER_APP_UNINSTALLED"].includes(event);
  const rows = await db.providerCredential.findMany({ where: { wabaId, provider: "meta_whatsapp_cloud_api" }, select: { id: true, businessId: true } });
  for (const r of rows) {
    if (revoke) await db.providerCredential.update({ where: { id: r.id }, data: { status: "revoked", sendingBlocked: true, lastConnectionError: `Meta: ${event}` } });
    await audit(r.businessId, null, "whatsapp", r.id, "whatsapp.account_update", { event, ...(detail ?? {}) }, db);
  }
  return rows.length;
}

/** Send the built-in `hello_world` template to an explicitly provided test number (never customers). */
export async function sendTestMessage(user: SessionUser, credentialId: string, toE164: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id: credentialId, provider: "meta_whatsapp_cloud_api", isActive: true } });
  if (!c || !c.phoneNumberId) throw new SignupError("החיבור לא נמצא או אינו פעיל", 404, "not_found");
  const cfg = metaConfigOf(c.config);
  try {
    const r = await graph<{ messages?: Array<{ id: string }> }>(`${c.phoneNumberId}/messages`, { method: "POST", token: cfg.accessToken, body: { messaging_product: "whatsapp", to: toE164.replace(/^\+/, ""), type: "template", template: { name: "hello_world", language: { code: "en_US" } } } });
    await prisma.providerCredential.update({ where: { id: c.id }, data: { lastOutboundTestAt: new Date(), sendingBlocked: false } });
    await audit(user.businessId, user.id, "whatsapp", c.id, "whatsapp.test_sent", { to: toE164, providerMessageId: r.messages?.[0]?.id ?? null });
    return { providerMessageId: r.messages?.[0]?.id ?? null };
  } catch (err) {
    const message = err instanceof GraphError ? `Meta: ${err.message} (code ${err.code ?? "?"})` : err instanceof Error ? err.message : String(err);
    await prisma.providerCredential.update({ where: { id: c.id }, data: { lastConnectionError: message, ...(err instanceof GraphError && [190, 10, 200].includes(err.code ?? -1) ? { sendingBlocked: true, status: "revoked" } : {}) } });
    throw new SignupError(message, 502, "test_send_failed");
  }
}

/** Connection overview for the settings card (no secrets). */
export async function connectionOverview() {
  const rows = await prisma.providerCredential.findMany({ where: { provider: "meta_whatsapp_cloud_api" }, orderBy: [{ isActive: "desc" }, { isDefault: "desc" }, { createdAt: "asc" }], include: { team: { select: { id: true, name: true } } } });
  const pending = await prisma.whatsAppSignupSession.findFirst({ where: { status: "started", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { id: true, userId: true, createdAt: true } });
  const readiness = embeddedSignupReadiness();
  return {
    embeddedSignup: { ready: readiness.ready, missing: readiness.missing, appId: readiness.appId, configId: readiness.configId, version: readiness.version },
    pendingSession: pending,
    connections: rows.map((c) => {
      const r = deriveReadiness(c);
      return {
        id: c.id, label: c.label, method: c.connectionMethod, status: r.status, sendReady: r.sendReady, receiveReady: r.receiveReady, blockers: r.blockers,
        wabaId: c.wabaId, wabaName: c.wabaName, phoneNumberId: c.phoneNumberId, displayPhoneNumber: c.displayPhoneNumber, verifiedName: c.verifiedName, nameStatus: c.nameStatus,
        qualityRating: c.qualityRating, codeVerificationStatus: c.codeVerificationStatus, platformType: c.platformType, grantedScopes: c.grantedScopes, isDefault: c.isDefault, isActive: c.isActive,
        team: c.team, subscribedAt: c.subscribedAt, registeredAt: c.registeredAt, tokenCheckedAt: c.tokenCheckedAt, lastCheckedAt: c.lastCheckedAt, lastWebhookAt: c.lastWebhookAt,
        lastOutboundTestAt: c.lastOutboundTestAt, lastError: c.lastConnectionError, sendingBlocked: c.sendingBlocked, createdAt: c.createdAt,
      };
    }),
  };
}

export const STATUS_LABEL: Record<WaConnectionStatus, string> = {
  disconnected: "לא מחובר",
  in_progress: "חיבור בתהליך",
  needs_action: "נדרשת השלמת פעולה",
  connected_not_ready: "מחובר – לא מוכן לשליחה",
  connected: "מחובר ופעיל",
  revoked: "ההרשאה בוטלה – נדרש חיבור מחדש",
  error: "תקלה",
};
