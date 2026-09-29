/**
 * Zadarma backup account of a business (owner only). Secrets are sealed and write-only; changing the account resets
 * its check and live test. A caller ID is used only after the owner approves it and states where it comes from
 * (bought at Zadarma, or an external number Zadarma verified) – a Telnyx number is never presented through Zadarma
 * without that. The live test calls ONLY an owner-approved test number.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { sealSecret, encryptionConfigured } from "@/lib/crypto";
import { normalizePhone } from "@/lib/phone";
import type { SessionUser } from "@/lib/auth";
import { zadarmaAdapter, zadarmaAccount } from "@/lib/telephony/zadarma";
import { dialWithAttempt } from "@/lib/telephony/attempts";
import { TelephonyRequestTimeout } from "@/lib/telephony/types";

export const ZADARMA_CAPABILITIES = [
  { key: "outbound", status: "partial", note: "callback: rings the agent's Zadarma extension first, then the customer" },
  { key: "agent_audio", status: "partial", note: "Zadarma's own WebRTC widget (not our phone UI)" },
  { key: "server_hangup", status: "unsupported", note: "no API – the agent hangs up in the Zadarma widget" },
  { key: "dtmf", status: "unsupported", note: "from the agent's widget only" },
  { key: "conference", status: "unsupported", note: "no API (000 code from the phone only)" },
  { key: "supervisor_listen_whisper", status: "unsupported", note: "no API (007 code from a supervisor's own phone)" },
  { key: "recording", status: "supported", note: "PBX recording, NOTIFY_RECORD, 180-second download links" },
  { key: "call_events", status: "unverified", note: "not documented for callback calls – proven by the live test" },
  { key: "reconciliation_after_timeout", status: "partial", note: "statistics lookup (3 requests/min, no request id)" },
  { key: "inbound", status: "not_implemented", note: "only for numbers hosted at Zadarma; not routed by UltraCRM" },
] as const;

export async function zadarmaOverview(businessId: string) {
  const cred = await prisma.telephonyProviderCredential.findUnique({ where: { businessId_provider: { businessId, provider: "zadarma" } } });
  const acc = cred ? await zadarmaAccount(businessId) : null;
  const endpoints = await prisma.telephonyAgentEndpoint.findMany({ where: { businessId, provider: "zadarma" }, select: { userId: true, extension: true } });
  const readiness = await zadarmaAdapter.businessReadiness!(businessId);
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const lastTest = cred?.liveTestCallId ? await prisma.call.findUnique({ where: { id: cred.liveTestCallId }, select: { id: true, createdAt: true, endedAt: true, telephonyResult: true, failureReason: true } }) : null;
  const runningTest = cred ? await prisma.call.findFirst({ where: { businessId, provider: "zadarma", routingNote: "zadarma_live_test" }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, endedAt: true, telephonyResult: true, failureReason: true } }) : null;
  return {
    encryption: encryptionConfigured(),
    configured: Boolean(acc),
    keyHint: acc ? `…${acc.apiKey.slice(-4)}` : null,
    sandbox: cred?.sandbox ?? false,
    webhookUrl: cred ? `${base}/api/webhooks/zadarma/${cred.id}` : null,
    callerId: cred ? { e164: cred.callerIdE164, source: cred.callerIdSource, approvedAt: cred.callerIdApprovedAt } : null,
    testNumbers: cred?.testNumbers ?? [],
    maxConcurrent: cred?.maxConcurrent ?? null,
    lastCheck: cred?.lastCheckAt ? { at: cred.lastCheckAt, ok: cred.lastCheckOk, checks: cred.lastCheckDetail } : null,
    liveTest: { passedAt: cred?.liveTestPassedAt ?? null, last: runningTest ?? lastTest },
    endpoints, readiness, capabilities: ZADARMA_CAPABILITIES,
  };
}

export interface ZadarmaAccountInput {
  apiKey?: string; apiSecret?: string; sandbox?: boolean;
  callerIdE164?: string | null; callerIdSource?: "zadarma_number" | "verified_external" | null; approveCallerId?: boolean;
  testNumbers?: string[]; maxConcurrent?: number | null;
}

export async function saveZadarmaAccount(businessId: string, actorId: string, input: ZadarmaAccountInput) {
  if (!encryptionConfigured()) throw new ApiError("ENCRYPTION_KEY אינו מוגדר בשרת – לא ניתן לשמור מפתחות", 500, "encryption_missing");
  const current = await prisma.telephonyProviderCredential.findUnique({ where: { businessId_provider: { businessId, provider: "zadarma" } } });
  const newSecrets = input.apiKey !== undefined || input.apiSecret !== undefined;
  const existing = current ? await zadarmaAccount(businessId) : null;
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  const apiSecret = input.apiSecret?.trim() || existing?.apiSecret;
  if (!apiKey || !apiSecret) throw new ApiError("נדרשים מפתח API וסוד (Settings → Integrations and API ב-Zadarma)", 400, "credentials_required");
  const callerId = input.callerIdE164 === undefined ? current?.callerIdE164 ?? null : input.callerIdE164 ? normalizePhone(input.callerIdE164) : null;
  if (input.callerIdE164 && !callerId) throw new ApiError("מספר יוצא לא תקין", 400, "invalid_phone");
  const callerChanged = callerId !== (current?.callerIdE164 ?? null) || (input.callerIdSource !== undefined && input.callerIdSource !== current?.callerIdSource);
  if (input.approveCallerId && (!callerId || !(input.callerIdSource ?? current?.callerIdSource))) throw new ApiError("לאישור מספר יוצא יש לבחור מספר ואת מקורו (נרכש ב-Zadarma / אומת ב-Zadarma)", 400, "caller_id_source_required");
  const testNumbers = input.testNumbers === undefined ? current?.testNumbers ?? [] : input.testNumbers.map((n) => normalizePhone(n)).filter((n): n is string => Boolean(n));
  const accountChanged = newSecrets || (input.sandbox !== undefined && input.sandbox !== current?.sandbox);
  const data = {
    secrets: sealSecret(JSON.stringify({ apiKey, apiSecret })),
    sandbox: input.sandbox ?? current?.sandbox ?? false,
    callerIdE164: callerId,
    callerIdSource: input.callerIdSource === undefined ? current?.callerIdSource ?? null : input.callerIdSource,
    ...(input.approveCallerId ? { callerIdApprovedAt: new Date(), callerIdApprovedById: actorId } : callerChanged ? { callerIdApprovedAt: null, callerIdApprovedById: null } : {}),
    testNumbers,
    maxConcurrent: input.maxConcurrent === undefined ? current?.maxConcurrent ?? null : input.maxConcurrent,
    ...(accountChanged ? { lastCheckAt: null, lastCheckOk: null, lastCheckDetail: undefined, liveTestPassedAt: null, liveTestCallId: null } : {}),
    updatedById: actorId,
  };
  await prisma.telephonyProviderCredential.upsert({ where: { businessId_provider: { businessId, provider: "zadarma" } }, create: { businessId, provider: "zadarma", ...data }, update: data });
  const { audit } = await import("@/lib/audit");
  await audit(businessId, actorId, "settings", businessId, "telephony.zadarma_account_saved", { secretsChanged: newSecrets, callerIdApproved: Boolean(input.approveCallerId), accountChanged });
  return zadarmaOverview(businessId);
}

export async function setZadarmaExtensions(businessId: string, actorId: string, items: Array<{ userId: string; extension: string | null }>) {
  for (const it of items) {
    const u = await prisma.user.findFirst({ where: { id: it.userId, businessId }, select: { id: true } });
    if (!u) throw new ApiError("משתמש לא נמצא בעסק", 404, "not_found");
    if (!it.extension) { await prisma.telephonyAgentEndpoint.deleteMany({ where: { userId: it.userId, provider: "zadarma", businessId } }); continue; }
    if (!/^\d{2,8}$/.test(it.extension)) throw new ApiError(`שלוחה לא תקינה: ${it.extension}`, 400, "invalid_extension");
    await prisma.telephonyAgentEndpoint.upsert({ where: { userId_provider: { userId: it.userId, provider: "zadarma" } }, create: { businessId, userId: it.userId, provider: "zadarma", extension: it.extension }, update: { extension: it.extension } });
  }
  const { audit } = await import("@/lib/audit");
  await audit(businessId, actorId, "settings", businessId, "telephony.zadarma_extensions_saved", { count: items.length });
  return zadarmaOverview(businessId);
}

/** Read-only account check (balance, extensions, caller ID). Never dials or changes anything at Zadarma. */
export async function checkZadarma(businessId: string) {
  const checks = await zadarmaAdapter.verifyConfig(businessId);
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  await prisma.telephonyProviderCredential.updateMany({ where: { businessId, provider: "zadarma" }, data: { lastCheckAt: new Date(), lastCheckOk: ok, lastCheckDetail: checks as unknown as object } });
  return { ok, checks };
}

/**
 * Live (paid) test to an owner-approved test number – never a customer. Proves that Zadarma's call events reach us
 * for a callback call; the webhook marks the account as tested when the end event arrives.
 */
export async function startZadarmaLiveTest(user: SessionUser, toRaw: string) {
  const to = normalizePhone(toRaw);
  const cred = await prisma.telephonyProviderCredential.findUnique({ where: { businessId_provider: { businessId: user.businessId, provider: "zadarma" } } });
  if (!cred) throw new ApiError("חשבון Zadarma אינו מוגדר", 409, "not_configured");
  if (!to || !cred.testNumbers.includes(to)) throw new ApiError("בדיקה חיה מותרת רק למספר בדיקה שאושר מראש", 403, "test_number_not_approved");
  if (!cred.callerIdE164 || !cred.callerIdApprovedAt) throw new ApiError("יש לאשר מספר יוצא לפני בדיקה", 409, "caller_id_not_approved");
  if (!cred.lastCheckOk) throw new ApiError("יש להריץ בדיקת הגדרות שעוברת לפני בדיקה חיה", 409, "not_verified");
  const ext = await zadarmaAdapter.agentAddress(user.id);
  if (!ext) throw new ApiError("למשתמש שלך אין שלוחת Zadarma – הגדר שלוחה", 409, "agent_extension_missing");
  if (await prisma.call.findUnique({ where: { activeForUser: user.id } })) throw new ApiError("יש לך שיחה פעילה", 409, "call_active");
  const call = await prisma.call.create({ data: { businessId: user.businessId, userId: user.id, mode: "manual", provider: "zadarma", idempotencyKey: `zadarma-test-${crypto.randomUUID()}`, activeForUser: user.id, toE164: to, fromE164: cred.callerIdE164, numberSelectionReason: "provider_account_caller_id", routingNote: "zadarma_live_test", status: "created" } });
  try {
    const r = await dialWithAttempt({ businessId: user.businessId, callId: call.id, leg: "agent", provider: "zadarma", commandKey: `${call.id}-agent`, fromE164: cred.callerIdE164, toE164: to },
      () => zadarmaAdapter.dialAgent({ callId: call.id, businessId: user.businessId, toE164: to, sipUsername: ext, fromE164: cred.callerIdE164!, timeoutSeconds: 20 }));
    await prisma.call.update({ where: { id: call.id }, data: { agentLegId: r.legId, status: "dialing_agent" } });
  } catch (err) {
    if (err instanceof TelephonyRequestTimeout) { await prisma.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date() } }); }
    else { await prisma.call.update({ where: { id: call.id }, data: { status: "failed", endedAt: new Date(), telephonyResult: "failed", failureReason: String((err as Error).message).slice(0, 300), activeForUser: null, outcomeSavedAt: new Date() } }); throw err; }
  }
  await prisma.telephonyProviderCredential.update({ where: { id: cred.id }, data: { liveTestCallId: call.id } });
  return { callId: call.id };
}
