/**
 * Direct WhatsApp Cloud API connection for a single business that owns the Meta app (Solina, internal use).
 *
 * The System User token, WABA ID and Phone Number ID come from the deployment environment
 * (lib/meta/graph.ts → directWhatsAppEnv). The credential row stores IDs only (`tokenSource: "env"`).
 * Webhooks are verified with the app-level App Secret (META_APP_SECRET) like every other connection.
 *
 * Nothing here re-registers or moves a number implicitly: connecting only reads the number's state at Meta and
 * subscribes the app to the WABA's webhooks. Registration (POST /{phone}/register) is a separate, explicit owner
 * action with the business's own two-step PIN, offered only when Meta reports the number is not on any API yet.
 * The Embedded Signup (Tech Provider) flow is untouched and stays available for onboarding other businesses later.
 */
import { Prisma } from "@/generated/prisma/client";
import type { WaConnectionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { directWhatsAppEnv, graph, GraphError } from "@/lib/meta/graph";
import type { SessionUser } from "@/lib/auth";
import { assetsTakenElsewhere, deriveReadiness, isAppSubscribed, readAssets, registerPhone, SignupError, subscribeApp, verifyToken } from "./embedded-signup-service";

export type PhoneAssessment = {
  /** cloud_api = registered on Cloud API (ready); not_registered = in the WABA but not on any API yet; on_premise = served by the On-Premises API (another provider/server); unknown = Meta did not say. */
  kind: "cloud_api" | "not_registered" | "on_premise" | "unknown";
  platformType: string | null;
  status: string | null;
  canRegister: boolean;
  note: string;
};

/**
 * What Meta reports about the number → what we may (and may not) do. Never assumes a re-registration is harmless.
 * Fields per Meta's Phone Number reference: platform_type, status ("CONNECTED" to send), is_on_biz_app (coexistence).
 */
export function assessPhone(phone: { platform_type?: string; status?: string; is_on_biz_app?: boolean; health_status?: { can_send_message?: string } }): PhoneAssessment {
  const platformType = phone.platform_type?.toUpperCase() ?? null;
  const status = phone.status?.toUpperCase() ?? null;
  if (platformType === "CLOUD_API") {
    const coexist = phone.is_on_biz_app ? "המספר פעיל במקביל גם באפליקציית WhatsApp Business (Coexistence). " : "";
    const health = phone.health_status?.can_send_message && phone.health_status.can_send_message !== "AVAILABLE" ? ` Meta מדווחת שהשליחה ${phone.health_status.can_send_message === "BLOCKED" ? "חסומה" : "מוגבלת"} – יש לבדוק ב-WhatsApp Manager.` : "";
    const connected = status && status !== "CONNECTED" ? ` מצב המספר אצל Meta: ${status} (לשליחה נדרש CONNECTED).` : "";
    return { kind: "cloud_api", platformType, status, canRegister: false, note: `${coexist}המספר כבר רשום ל-Cloud API – אין צורך ברישום, ולא יבוצע רישום מחדש.${connected}${health}` };
  }
  if (platformType === "ON_PREMISE") return { kind: "on_premise", platformType, status, canRegister: false, note: "המספר מוגדר כרגע ב-On-Premises API (שרת/ספק אחר). רישום ל-Cloud API ינתק אותו מהספק הנוכחי – יש לתאם מעבר מסודר לפני כל פעולה" };
  if (platformType === "NOT_APPLICABLE") return { kind: "not_registered", platformType, status, canRegister: true, note: "המספר נמצא בחשבון ה-WhatsApp Business אך אינו רשום לאף API. רישום יחבר אותו ל-Cloud API" };
  return { kind: "unknown", platformType, status, canRegister: false, note: "Meta לא החזירה את סוג הפלטפורמה של המספר – לא תבוצע פעולה עד לבירור" };
}

/** Fields read separately so an unavailable field never fails the whole check (Graph rejects the request on an unknown field). */
async function optionalPhoneFields(token: string, phoneNumberId: string) {
  try { return await graph<{ is_on_biz_app?: boolean; health_status?: { can_send_message?: string } }>(phoneNumberId, { token, query: { fields: "is_on_biz_app,health_status" } }); }
  catch { return {}; }
}

export function directOverview(businessId: string) {
  const d = directWhatsAppEnv();
  return { mode: d.mode, ready: d.ready, missing: d.missing, forThisBusiness: d.businessId === businessId, configuredForOtherBusiness: Boolean(d.businessId) && d.businessId !== businessId };
}

function requireDirect(user: SessionUser) {
  if (user.role !== "owner") throw new SignupError("רק בעל העסק יכול לחבר את המספר הישיר", 403, "forbidden");
  const d = directWhatsAppEnv();
  if (!d.ready) throw new SignupError(`חסרה הגדרה בשרת: ${d.missing.join(", ")}`, 503, "direct_not_configured", { missing: d.missing });
  if (d.businessId !== user.businessId) throw new SignupError("החיבור הישיר מוגדר בשרת לעסק אחר – אין לחבר אותו כאן", 403, "direct_other_business");
  return d as typeof d & { businessId: string; wabaId: string; phoneNumberId: string; accessToken: string };
}

/** Read-only checks + app subscription to the WABA, then save the connection. Safe to repeat. */
export async function connectDirect(user: SessionUser, options: { label?: string } = {}) {
  const d = requireDirect(user);
  const taken = await assetsTakenElsewhere(user.businessId, { phoneNumberId: d.phoneNumberId, wabaId: d.wabaId });
  if (taken === "phone") throw new SignupError("המספר כבר מחובר לעסק אחר במערכת", 409, "phone_taken");
  if (taken === "waba") throw new SignupError("חשבון ה-WhatsApp Business כבר מחובר לעסק אחר במערכת", 409, "waba_taken");

  let verified: Awaited<ReturnType<typeof verifyToken>>;
  let assets: Awaited<ReturnType<typeof readAssets>>;
  try {
    verified = await verifyToken(d.accessToken, d.wabaId);
    assets = await readAssets(d.accessToken, d.wabaId, d.phoneNumberId);
  } catch (err) {
    if (err instanceof GraphError) throw new SignupError(`Meta דחתה את הבדיקה: ${err.message} (code ${err.code ?? "?"}). בדקו את ה-System User Token, ההרשאות והשיוך לנכסים`, 502, "direct_check_failed");
    throw err;
  }
  const assessment = assessPhone({ ...assets.phone, ...(await optionalPhoneFields(d.accessToken, d.phoneNumberId)) });

  let subscribedAt: Date | null = null;
  let subscribeError: string | null = null;
  try {
    // Subscribing adds our app to the WABA's webhook recipients; it does not affect the number or other subscribed apps.
    if (!(await isAppSubscribed(d.accessToken, d.wabaId))) await subscribeApp(d.accessToken, d.wabaId);
    subscribedAt = new Date();
  } catch (err) { subscribeError = err instanceof GraphError ? `Meta: ${err.message} (code ${err.code ?? "?"})` : String(err); }

  const p = assets.phone as typeof assets.phone & { whatsapp_business_manager_messaging_limit?: string; messaging_limit_tier?: string };
  const fields = {
    wabaName: assets.waba.name ?? null, displayPhoneNumber: p.display_phone_number ?? null, verifiedName: p.verified_name ?? null, nameStatus: p.name_status ?? null,
    qualityRating: p.quality_rating ?? null, codeVerificationStatus: p.code_verification_status ?? null, platformType: p.platform_type ?? null,
    messagingLimitTier: p.whatsapp_business_manager_messaging_limit ?? p.messaging_limit_tier ?? null,
    grantedScopes: verified.scopes as Prisma.InputJsonValue, tokenCheckedAt: new Date(), lastCheckedAt: new Date(),
  };
  const config = { tokenSource: "env", businessId: d.businessId, phoneNumberId: d.phoneNumberId, businessAccountId: d.wabaId } as Prisma.InputJsonValue;

  const credential = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${user.businessId}, 774291))`;
    const other = await tx.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", phoneNumberId: { not: d.phoneNumberId } }, select: { wabaId: true } });
    if (other && other.wabaId !== d.wabaId) throw new SignupError("מספרים פעילים באותו עסק חייבים להשתייך לאותו חשבון WhatsApp Business", 409, "waba_mismatch");
    const existing = await tx.providerCredential.findFirst({ where: { provider: "meta_whatsapp_cloud_api", phoneNumberId: d.phoneNumberId } });
    const isDefault = !other || Boolean(existing?.isDefault);
    if (isDefault) await tx.providerCredential.updateMany({ where: { isDefault: true, channel: "whatsapp" }, data: { isDefault: false } });
    // The mock provider must not stay the active sender next to a real number.
    await tx.providerCredential.updateMany({ where: { channel: "whatsapp", provider: "mock", isActive: true }, data: { isActive: false, isDefault: false } });
    const data = {
      ...fields, phoneNumberId: d.phoneNumberId, wabaId: d.wabaId, config, connectionMethod: "direct", isActive: true, isDefault, sendingBlocked: false,
      status: (subscribeError ? "needs_action" : "connected_not_ready") as WaConnectionStatus, lastConnectionError: subscribeError,
      subscribedAt: subscribedAt ?? existing?.subscribedAt ?? null,
      // Registered only when Meta itself says the number is on Cloud API – never inferred from our own actions.
      registeredAt: assessment.kind === "cloud_api" ? existing?.registeredAt ?? new Date() : null,
      ...(options.label !== undefined ? { label: options.label } : {}),
    };
    return existing
      ? tx.providerCredential.update({ where: { id: existing.id }, data })
      : tx.providerCredential.create({ data: { businessId: user.businessId, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", ...data } });
  });
  const readiness = deriveReadiness(credential);
  if (readiness.status !== credential.status) await prisma.providerCredential.update({ where: { id: credential.id }, data: { status: readiness.status } });
  await audit(user.businessId, user.id, "whatsapp", credential.id, "whatsapp.direct_connected", { wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, platformType: assessment.platformType, phoneStatus: assessment.status, subscribed: Boolean(subscribedAt), scopes: verified.scopes });
  return { credentialId: credential.id, ...readiness, assessment, subscribeError };
}

/**
 * Explicit Cloud API registration of the direct number with the business's own two-step PIN. Allowed only when Meta
 * currently reports the number as not on any API; the PIN is used once and never stored.
 */
export async function registerDirect(user: SessionUser, credentialId: string, pin: string, confirm: boolean) {
  const d = requireDirect(user);
  if (!confirm) throw new SignupError("רישום המספר דורש אישור מפורש", 400, "confirm_required");
  if (!/^\d{6}$/.test(pin)) throw new SignupError("קוד אימות דו-שלבי חייב להיות 6 ספרות", 400, "invalid_pin");
  const c = await prisma.providerCredential.findFirst({ where: { id: credentialId, connectionMethod: "direct", phoneNumberId: d.phoneNumberId, isActive: true } });
  if (!c) throw new SignupError("החיבור הישיר לא נמצא", 404, "not_found");
  const { phone } = await readAssets(d.accessToken, d.wabaId, d.phoneNumberId);
  const assessment = assessPhone({ ...phone, ...(await optionalPhoneFields(d.accessToken, d.phoneNumberId)) });
  if (!assessment.canRegister) throw new SignupError(assessment.note, 409, "register_not_allowed", { assessment });
  let result: "registered" | "pin_required";
  try { result = await registerPhone(d.accessToken, d.phoneNumberId, pin); }
  catch (err) {
    const message = err instanceof GraphError ? `Meta: ${err.message} (code ${err.code ?? "?"})` : String(err);
    await prisma.providerCredential.update({ where: { id: c.id }, data: { lastConnectionError: message, lastCheckedAt: new Date() } });
    throw new SignupError(message, 502, "register_failed");
  }
  if (result === "pin_required") throw new SignupError("Meta דחתה את הקוד: למספר מוגדר קוד אימות דו-שלבי אחר. הזינו את הקוד הקיים (או אפסו אותו ב-WhatsApp Manager)", 422, "pin_mismatch");
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { registeredAt: new Date(), platformType: "CLOUD_API", lastConnectionError: null, lastCheckedAt: new Date() } });
  const readiness = deriveReadiness(updated);
  if (readiness.status !== updated.status) await prisma.providerCredential.update({ where: { id: c.id }, data: { status: readiness.status } });
  await audit(user.businessId, user.id, "whatsapp", c.id, "whatsapp.direct_registered", { phoneNumberId: d.phoneNumberId });
  return readiness;
}
