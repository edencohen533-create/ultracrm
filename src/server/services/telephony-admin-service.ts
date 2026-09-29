/**
 * Telephony provider administration (owner only): routing policy, provider status, breaker state, switch log,
 * attempts waiting for settlement. Configuration health (read-only account check) is kept apart from an end-to-end
 * test, which needs a real call and is never run automatically.
 */
import type { TelephonyProvider as ProviderName } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { adapterFor, knownProviders, platformDefaultProvider, realCallBlocker } from "@/lib/telephony/registry";
import { loadRouting, peekProviderForNewCall, providerEligibility, routingEnabled, updateRouting } from "@/lib/telephony/routing";

/** Values from the account check that belong to the platform, not to a business (e.g. the balance) are hidden. */
const PLATFORM_ONLY_CHECKS = new Set(["balance"]);

export async function routingOverview(businessId: string) {
  const routing = await loadRouting(businessId);
  const providers = await Promise.all(knownProviders().map(async (name) => {
    const a = adapterFor(name);
    const cfg = a.configStatus();
    const account = await prisma.telephonyProviderAccount.findUnique({ where: { provider_accountRef: { provider: name, accountRef: cfg.accountRef ?? "default" } } });
    const eligibility = await providerEligibility(name);
    const checks = Array.isArray(account?.detail) ? (account!.detail as Array<{ name: string; ok: boolean; detail?: string }>).map((c) => (PLATFORM_ONLY_CHECKS.has(c.name) ? { name: c.name, ok: c.ok } : c)) : [];
    return {
      name, simulation: a.simulation, testOnly: Boolean(a.testOnly), capabilities: a.capabilities,
      configured: cfg.configured, missing: cfg.missing, blocker: realCallBlocker(a),
      accountCheck: account ? { ok: account.ok, checkedAt: account.checkedAt, verifiedAt: account.verifiedAt, checks } : null,
      eligibleForRealCalls: eligibility.eligible, eligibilityReason: eligibility.reason,
    };
  }));
  const [health, log, settlement] = await Promise.all([
    prisma.telephonyProviderHealth.findMany({ where: { businessId } }),
    prisma.telephonySwitchLog.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.callAttempt.findMany({ where: { businessId, status: "needs_settlement", settledAt: null }, orderBy: { requestedAt: "desc" }, take: 50, select: { id: true, callId: true, leg: true, provider: true, toE164: true, requestedAt: true, failureDetail: true } }),
  ]);
  return {
    featureFlag: routingEnabled() ? "on" : "off",
    platformDefault: platformDefaultProvider(),
    routing: { primary: routing.primary, backup: routing.backup, mode: routing.mode, manualActive: routing.manualActive, breaker: routing.breaker, stored: routing.stored },
    newCallsUse: await peekProviderForNewCall(businessId),
    providers, health, log, settlement,
    endToEnd: { status: "not_run", note: "An end-to-end test places a real (paid) call; it is not run automatically." },
  };
}

export async function saveRouting(businessId: string, actorId: string, patch: Parameters<typeof updateRouting>[2]) {
  const current = await loadRouting(businessId);
  const primary = patch.primaryProvider === undefined ? current.primary : patch.primaryProvider ?? platformDefaultProvider();
  const backup = patch.backupProvider === undefined ? current.backup : patch.backupProvider;
  if (backup && backup === primary) throw new ApiError("ספק הגיבוי חייב להיות שונה מהספק הראשי", 400, "backup_equals_primary");
  const mode = patch.mode ?? current.mode;
  if (mode !== "primary_only" && !backup) throw new ApiError("מצב מעבר דורש ספק גיבוי", 400, "backup_required");
  if (patch.manualActive === "backup") {
    if (mode !== "manual_backup") throw new ApiError("החלפה ידנית זמינה רק במצב \"מעבר ידני\"", 400, "not_manual_mode");
    const e = await providerEligibility(backup);
    if (!e.eligible) throw new ApiError(`ספק הגיבוי אינו זמין לשיחות אמיתיות (${e.reason})`, 409, "backup_not_eligible", { reason: e.reason });
  }
  return updateRouting(businessId, actorId, patch);
}

/** Read-only account check (no calls, no purchases). The result is platform-level: one provider account. */
export async function checkProvider(provider: ProviderName) {
  const a = adapterFor(provider);
  if (a.simulation && !a.testOnly) return { provider, ok: false, checks: [{ name: "simulation", ok: false, detail: "simulation adapter – never a real provider" }] };
  const checks = await a.verifyConfig();
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  const accountRef = a.configStatus().accountRef ?? "default";
  const now = new Date();
  await prisma.telephonyProviderAccount.upsert({
    where: { provider_accountRef: { provider, accountRef } },
    create: { provider, accountRef, ok, checkedAt: now, verifiedAt: ok ? now : null, detail: checks as unknown as Prisma.InputJsonValue },
    update: { ok, checkedAt: now, ...(ok ? { verifiedAt: now } : { verifiedAt: null }), detail: checks as unknown as Prisma.InputJsonValue },
  });
  return { provider, ok, checks: checks.map((c) => (PLATFORM_ONLY_CHECKS.has(c.name) ? { name: c.name, ok: c.ok } : c)) };
}

/** A manager records how an unconfirmed attempt ended (checked in the provider's portal / call log). */
export async function settleAttempt(businessId: string, actorId: string, attemptId: string, resolution: "no_call" | "call_happened", note?: string) {
  const a = await prisma.callAttempt.findFirst({ where: { id: attemptId, businessId, status: "needs_settlement" } });
  if (!a) throw new ApiError("ניסיון לא נמצא או שכבר הוסדר", 404, "not_found");
  const updated = await prisma.callAttempt.update({ where: { id: a.id }, data: { status: resolution === "call_happened" ? "created" : "failed", settledAt: new Date(), failureDetail: `settled by manager: ${resolution}${note ? ` – ${note}` : ""}`.slice(0, 300) } });
  const { audit } = await import("@/lib/audit");
  await audit(businessId, actorId, "call", a.callId, "telephony.attempt_settled", { attemptId: a.id, resolution });
  return updated;
}
