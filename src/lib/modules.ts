/**
 * Modules & quotas per business. A business inherits its plan's modules/quotas
 * and may override modules (e.g. a trial of telephony). Enforced server-side
 * (`withAuth({ module })`, `consumeQuota`) and mirrored in the UI (sidebar).
 * No billing / payment integration exists at this stage.
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";

export type ModuleKey = "crm" | "messaging" | "telephony";
export const MODULE_KEYS: ModuleKey[] = ["crm", "messaging", "telephony"];
export const MODULE_LABEL: Record<ModuleKey, string> = { crm: "CRM", messaging: "דיוור והודעות", telephony: "טלפוניה וחייגן" };

export type QuotaMetric = "users" | "contacts" | "messages_sent" | "calls_started" | "campaigns_started";
export const QUOTA_LABEL: Record<QuotaMetric, string> = {
  users: "משתמשים",
  contacts: "אנשי קשר",
  messages_sent: "הודעות יוצאות בחודש",
  calls_started: "שיחות יוצאות בחודש",
  campaigns_started: "קמפיינים בחודש",
};
/** Quotas measured against a monthly counter (others are absolute counts). */
const MONTHLY: QuotaMetric[] = ["messages_sent", "calls_started", "campaigns_started"];

export interface Entitlements {
  planKey: string | null;
  planName: string | null;
  modules: Record<ModuleKey, boolean>;
  /** `null` = unlimited */
  quotas: Record<QuotaMetric, number | null>;
}

const DEFAULT_MODULES: Record<ModuleKey, boolean> = { crm: true, messaging: true, telephony: true };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const cache = new Map<string, { at: number; value: Entitlements }>();
const CACHE_MS = 15_000;

export async function getEntitlements(businessId: string): Promise<Entitlements> {
  const hit = cache.get(businessId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const b = await db.business.findUnique({ where: { id: businessId }, select: { modules: true, plan: { select: { key: true, name: true, modules: true, quotas: true } } } });
  const planModules = asRecord(b?.plan?.modules);
  const overrides = asRecord(b?.modules);
  const modules = Object.fromEntries(MODULE_KEYS.map((k) => [k, typeof overrides[k] === "boolean" ? overrides[k] : typeof planModules[k] === "boolean" ? planModules[k] : DEFAULT_MODULES[k]])) as Record<ModuleKey, boolean>;
  const q = asRecord(b?.plan?.quotas);
  const quotas = Object.fromEntries((Object.keys(QUOTA_LABEL) as QuotaMetric[]).map((k) => [k, typeof q[k] === "number" ? (q[k] as number) : null])) as Record<QuotaMetric, number | null>;
  const value: Entitlements = { planKey: b?.plan?.key ?? null, planName: b?.plan?.name ?? null, modules, quotas };
  cache.set(businessId, { at: Date.now(), value });
  return value;
}

export function invalidateEntitlements(businessId: string) {
  cache.delete(businessId);
}

export async function isModuleEnabled(businessId: string, module: ModuleKey) {
  return (await getEntitlements(businessId)).modules[module];
}

export async function assertModuleEnabled(businessId: string, module: ModuleKey) {
  if (!(await isModuleEnabled(businessId, module))) {
    throw new ApiError(`המודול "${MODULE_LABEL[module]}" אינו פעיל בחבילה של העסק`, 403, "module_disabled", { module });
  }
}

export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Current usage for a metric (monthly counter, or absolute count for users/contacts). */
export async function currentUsage(businessId: string, metric: QuotaMetric): Promise<number> {
  if (metric === "users") return db.user.count({ where: { businessId, isActive: true } });
  if (metric === "contacts") return db.contact.count({ where: { businessId } });
  const row = await db.usageCounter.findUnique({ where: { businessId_metric_period: { businessId, metric, period: currentPeriod() } } });
  return row?.value ?? 0;
}

/**
 * Reserve `amount` units of a quota. Throws `quota_exceeded` (HTTP 429) when the
 * plan limit would be crossed. Monthly metrics are incremented atomically.
 */
export async function consumeQuota(businessId: string, metric: QuotaMetric, amount = 1) {
  const ent = await getEntitlements(businessId);
  const limit = ent.quotas[metric];
  if (MONTHLY.includes(metric)) {
    const period = currentPeriod();
    const row = await db.usageCounter.upsert({
      where: { businessId_metric_period: { businessId, metric, period } },
      create: { businessId, metric, period, value: amount },
      update: { value: { increment: amount } },
    });
    if (limit !== null && row.value > limit) {
      await db.usageCounter.update({ where: { id: row.id }, data: { value: { decrement: amount } } });
      throw new ApiError(`חריגה ממכסת ${QUOTA_LABEL[metric]} (${limit}) של החבילה`, 429, "quota_exceeded", { metric, limit });
    }
    return;
  }
  if (limit === null) return;
  const used = await currentUsage(businessId, metric);
  if (used + amount > limit) throw new ApiError(`חריגה ממכסת ${QUOTA_LABEL[metric]} (${limit}) של החבילה`, 429, "quota_exceeded", { metric, limit, used });
}

export async function usageSummary(businessId: string) {
  const ent = await getEntitlements(businessId);
  const metrics = Object.keys(QUOTA_LABEL) as QuotaMetric[];
  const usage = await Promise.all(metrics.map((m) => currentUsage(businessId, m)));
  return { ...ent, usage: Object.fromEntries(metrics.map((m, i) => [m, { used: usage[i], limit: ent.quotas[m], label: QUOTA_LABEL[m] }])) };
}
