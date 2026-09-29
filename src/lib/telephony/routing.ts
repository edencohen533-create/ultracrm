/**
 * Provider routing for NEW calls, per business. Behind the TELEPHONY_ROUTING=on feature flag; with the flag off (the
 * default) every new call uses the platform default exactly as before.
 *
 * Modes: primary_only (default) · manual_backup (an authorised manager flips new calls to the backup) ·
 * auto_failover (the primary's circuit breaker is open → new calls go to the backup while it is healthy).
 * A backup counts only when it is configured, its account check passed recently, and its agent client exists –
 * otherwise it is "not configured" and never receives real traffic. An active call never moves between providers.
 */
import { Prisma } from "@/generated/prisma/client";
import type { TelephonyProvider as ProviderName, TelephonyRoutingMode } from "@/generated/prisma/enums";
import { prisma, dbSchema } from "@/lib/db";
import { adapterFor, platformDefaultProvider, realCallBlocker } from "./registry";
import { CLOSED, DEFAULT_BREAKER, onFailure, onSuccess, tryAcquire, advance, type BreakerConfig, type BreakerSnapshot } from "./breaker";
import { countsTowardBreaker } from "./classify";
import type { FailureClass } from "./types";

type Tx = Prisma.TransactionClient;

export const routingEnabled = () => (process.env.TELEPHONY_ROUTING ?? "off").toLowerCase() === "on";
/** An account check older than this does not count as verified. */
export const ACCOUNT_CHECK_TTL_MS = 7 * 24 * 3600_000;

export interface Routing {
  primary: ProviderName;
  backup: ProviderName | null;
  mode: TelephonyRoutingMode;
  manualActive: "primary" | "backup";
  breaker: BreakerConfig;
  stored: boolean;
}

export async function loadRouting(businessId: string, db: Tx | typeof prisma = prisma): Promise<Routing> {
  const r = await db.telephonyRouting.findUnique({ where: { businessId } });
  return {
    primary: r?.primaryProvider ?? platformDefaultProvider(),
    backup: r?.backupProvider ?? null,
    mode: r?.mode ?? "primary_only",
    manualActive: r?.manualActive === "backup" ? "backup" : "primary",
    breaker: r ? { failureThreshold: r.failureThreshold, windowSeconds: r.windowSeconds, cooldownSeconds: r.cooldownSeconds, probeCalls: r.probeCalls } : DEFAULT_BREAKER,
    stored: Boolean(r),
  };
}

/** Is this provider allowed to carry real calls for new dials? */
export async function providerEligibility(provider: ProviderName | null): Promise<{ eligible: boolean; reason: string }> {
  if (!provider) return { eligible: false, reason: "not_configured" };
  const adapter = adapterFor(provider);
  const blocker = realCallBlocker(adapter);
  if (blocker) return { eligible: false, reason: blocker };
  if (adapter.testOnly) return { eligible: true, reason: "test_adapter" };
  const ref = adapter.configStatus().accountRef ?? "default";
  const acc = await prisma.telephonyProviderAccount.findUnique({ where: { provider_accountRef: { provider, accountRef: ref } } });
  if (!acc?.ok || !acc.verifiedAt) return { eligible: false, reason: "not_verified" };
  if (Date.now() - acc.verifiedAt.getTime() > ACCOUNT_CHECK_TTL_MS) return { eligible: false, reason: "verification_expired" };
  return { eligible: true, reason: "verified" };
}

function snapshotOf(row: { state: BreakerSnapshot["state"]; failuresInWindow: number; windowStartedAt: Date | null; openedAt: Date | null; nextProbeAt: Date | null; probeSuccesses: number; probesStarted: number } | null): BreakerSnapshot {
  return row ? { state: row.state, failuresInWindow: row.failuresInWindow, windowStartedAt: row.windowStartedAt, openedAt: row.openedAt, nextProbeAt: row.nextProbeAt, probeSuccesses: row.probeSuccesses, probesStarted: row.probesStarted } : { ...CLOSED };
}

/** Lock (creating if needed) the breaker row so concurrent calls see one consistent state. */
async function lockHealth(tx: Tx, businessId: string, provider: ProviderName) {
  const row = await tx.telephonyProviderHealth.upsert({ where: { businessId_provider: { businessId, provider } }, create: { businessId, provider }, update: {}, select: { id: true } });
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${dbSchema()}"."telephony_provider_health"`)} WHERE id = ${row.id} FOR UPDATE`);
  return tx.telephonyProviderHealth.findUniqueOrThrow({ where: { id: row.id } });
}

async function saveSnapshot(tx: Tx, businessId: string, provider: ProviderName, s: BreakerSnapshot, extra: Prisma.TelephonyProviderHealthUpdateInput = {}) {
  await tx.telephonyProviderHealth.update({
    where: { businessId_provider: { businessId, provider } },
    data: { state: s.state, failuresInWindow: s.failuresInWindow, windowStartedAt: s.windowStartedAt, openedAt: s.openedAt, nextProbeAt: s.nextProbeAt, probeSuccesses: s.probeSuccesses, probesStarted: s.probesStarted, ...extra },
  });
}

async function lastRoute(tx: Tx, businessId: string): Promise<ProviderName | null | undefined> {
  const last = await tx.telephonySwitchLog.findFirst({ where: { businessId, kind: { in: ["manual", "auto_failover", "auto_recovery", "policy_change"] } }, orderBy: { createdAt: "desc" } });
  return last ? last.toProvider : undefined;
}

export interface ProviderChoice { provider: ProviderName; probe: boolean; reason: string }

export async function chooseProviderForNewCall(businessId: string): Promise<ProviderChoice> {
  if (!routingEnabled()) return { provider: platformDefaultProvider(), probe: false, reason: "routing_off" };
  const routing = await loadRouting(businessId);
  if (routing.mode === "primary_only" || !routing.backup) return { provider: routing.primary, probe: false, reason: routing.mode === "primary_only" ? "primary_only" : "no_backup" };
  const backup = await providerEligibility(routing.backup);
  if (routing.mode === "manual_backup") {
    if (routing.manualActive === "backup" && backup.eligible) return { provider: routing.backup, probe: false, reason: "manual_backup" };
    return { provider: routing.primary, probe: false, reason: routing.manualActive === "backup" ? `backup_unavailable:${backup.reason}` : "manual_primary" };
  }
  // auto_failover: decide and reserve a probe slot atomically.
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const primaryRow = await lockHealth(tx, businessId, routing.primary);
    const p = tryAcquire(snapshotOf(primaryRow), routing.breaker, now);
    await saveSnapshot(tx, businessId, routing.primary, p.next);
    let choice: ProviderChoice;
    if (p.allowed) choice = { provider: routing.primary, probe: p.probe, reason: p.probe ? "primary_probe" : "primary" };
    else if (backup.eligible) {
      const backupRow = await lockHealth(tx, businessId, routing.backup!);
      const b = tryAcquire(snapshotOf(backupRow), routing.breaker, now);
      await saveSnapshot(tx, businessId, routing.backup!, b.next);
      choice = b.allowed ? { provider: routing.backup!, probe: b.probe, reason: "failover" } : { provider: routing.primary, probe: false, reason: "backup_breaker_open" };
    } else choice = { provider: routing.primary, probe: false, reason: `backup_unavailable:${backup.reason}` };
    // Log only real route changes (first failover, first recovery), not every call.
    const prev = await lastRoute(tx, businessId);
    const current = prev === undefined ? routing.primary : prev;
    if (current !== choice.provider) {
      await tx.telephonySwitchLog.create({ data: { businessId, fromProvider: current, toProvider: choice.provider, kind: choice.provider === routing.primary ? "auto_recovery" : "auto_failover", reason: choice.reason } });
    }
    return choice;
  });
}

/** Which provider new calls would use now – read-only (no probe slot, no log). For the browser token. */
export async function peekProviderForNewCall(businessId: string): Promise<ProviderName> {
  if (!routingEnabled()) return platformDefaultProvider();
  const routing = await loadRouting(businessId);
  if (routing.mode === "primary_only" || !routing.backup) return routing.primary;
  const backup = await providerEligibility(routing.backup);
  if (routing.mode === "manual_backup") return routing.manualActive === "backup" && backup.eligible ? routing.backup : routing.primary;
  const row = await prisma.telephonyProviderHealth.findUnique({ where: { businessId_provider: { businessId, provider: routing.primary } } });
  const primaryOpen = advance(snapshotOf(row), new Date(), routing.breaker).state === "open";
  return primaryOpen && backup.eligible ? routing.backup : routing.primary;
}

/** Feed a provider request result into the breaker. Normal call results are never reported here. */
export async function recordProviderResult(businessId: string, provider: ProviderName, result: { ok: true } | { ok: false; failureClass: FailureClass; detail?: string }) {
  if (!routingEnabled()) return;
  const routing = await loadRouting(businessId);
  await prisma.$transaction(async (tx) => {
    const row = await lockHealth(tx, businessId, provider);
    const now = new Date();
    const before = snapshotOf(row);
    if (result.ok) {
      const next = onSuccess(before, routing.breaker, now);
      await saveSnapshot(tx, businessId, provider, next, { lastSuccessAt: now });
      if (advance(before, now).state !== "closed" && next.state === "closed") await tx.telephonySwitchLog.create({ data: { businessId, fromProvider: null, toProvider: provider, kind: "breaker_closed", reason: "probe calls succeeded" } });
      return;
    }
    const failure = { lastFailureClass: result.failureClass, lastFailureDetail: result.detail?.slice(0, 300) ?? null, lastFailureAt: now };
    if (!countsTowardBreaker(result.failureClass)) { await saveSnapshot(tx, businessId, provider, advance(before, now), failure); return; }
    const next = onFailure(before, routing.breaker, now, result.failureClass);
    await saveSnapshot(tx, businessId, provider, next, failure);
    if (before.state !== "open" && next.state === "open") await tx.telephonySwitchLog.create({ data: { businessId, fromProvider: provider, toProvider: null, kind: "breaker_open", reason: `${result.failureClass}${result.detail ? `: ${result.detail.slice(0, 200)}` : ""}` } });
  });
}

/** Manager action: change policy / flip new calls. Logged; never touches calls already in progress. */
export async function updateRouting(businessId: string, actorId: string, patch: { primaryProvider?: ProviderName | null; backupProvider?: ProviderName | null; mode?: TelephonyRoutingMode; manualActive?: "primary" | "backup"; failureThreshold?: number; windowSeconds?: number; cooldownSeconds?: number; probeCalls?: number }) {
  return prisma.$transaction(async (tx) => {
    const before = await loadRouting(businessId, tx);
    const saved = await tx.telephonyRouting.upsert({ where: { businessId }, create: { businessId, ...patch, updatedById: actorId }, update: { ...patch, updatedById: actorId } });
    const after = await loadRouting(businessId, tx);
    const routeOf = (r: Routing) => (r.mode === "manual_backup" && r.manualActive === "backup" && r.backup ? r.backup : r.primary);
    if (patch.manualActive !== undefined && patch.manualActive !== before.manualActive) {
      await tx.telephonySwitchLog.create({ data: { businessId, actorId, kind: "manual", fromProvider: routeOf(before), toProvider: routeOf(after), reason: `new calls → ${patch.manualActive}` } });
    } else if (before.mode !== after.mode || before.primary !== after.primary || before.backup !== after.backup) {
      await tx.telephonySwitchLog.create({ data: { businessId, actorId, kind: "policy_change", fromProvider: routeOf(before), toProvider: routeOf(after), reason: `mode ${before.mode}→${after.mode}; primary ${before.primary}→${after.primary}; backup ${before.backup ?? "none"}→${after.backup ?? "none"}` } });
    }
    return saved;
  });
}
