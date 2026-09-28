/**
 * Modules & quotas per business. A business inherits its plan's modules/quotas
 * and may override modules (e.g. a trial of telephony). Enforced server-side
 * (`withAuth({ module })`, `consumeQuota`) and mirrored in the UI (sidebar).
 * No billing / payment integration exists at this stage.
 */
import { db, type Db } from "@/lib/db";
import { ApiError } from "@/lib/response";

export type { ModuleKey, QuotaMetric } from "@/lib/access/catalog";
import { MODULES, MODULE_LABEL as LABELS, QUOTA_LABEL as QLABELS, type ModuleKey, type QuotaMetric } from "@/lib/access/catalog";
import { businessEntitlement, invalidateEntitlement } from "@/lib/access/engine";
export const MODULE_KEYS: ModuleKey[] = MODULES;
export const MODULE_LABEL = LABELS;
export const QUOTA_LABEL = QLABELS;
/** Quotas measured against a monthly counter (others are absolute counts). */
const MONTHLY: QuotaMetric[] = ["messages_sent", "calls_started", "campaigns_started"];

export interface Entitlements {
  planKey: string | null;
  planName: string | null;
  /** Module usable by the business right now (in the package / add-on / trial, and the business is not suspended). */
  modules: Record<ModuleKey, boolean>;
  /** `null` = unlimited */
  quotas: Record<QuotaMetric, number | null>;
}

/** Business-level view of src/lib/access/engine.ts (kept for existing callers). */
export async function getEntitlements(businessId: string): Promise<Entitlements> {
  const e = await businessEntitlement(businessId);
  return { planKey: e.planKey, planName: e.planName, modules: Object.fromEntries(MODULES.map((m) => [m, e.modules[m].included && !e.suspended])) as Record<ModuleKey, boolean>, quotas: e.quotas };
}

export function invalidateEntitlements(businessId: string) {
  invalidateEntitlement(businessId);
}

export async function isModuleEnabled(businessId: string, module: ModuleKey) {
  return (await getEntitlements(businessId)).modules[module];
}

export async function assertModuleEnabled(businessId: string, module: ModuleKey) {
  if (!(await isModuleEnabled(businessId, module))) {
    throw new ApiError(`המודול "${MODULE_LABEL[module]}" אינו פעיל בחבילה של העסק`, 403, "module_not_purchased", { module });
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
export async function consumeQuota(businessId: string, metric: QuotaMetric, amount = 1, transaction?: Db) {
  const ent = await getEntitlements(businessId);
  const limit = ent.quotas[metric];
  if (MONTHLY.includes(metric)) {
    const reserve = async (tx: Db) => {
      const period = currentPeriod();
      const row = await tx.usageCounter.upsert({
        where: { businessId_metric_period: { businessId, metric, period } },
        create: { businessId, metric, period, value: amount },
        update: { value: { increment: amount } },
      });
      if (limit !== null && row.value > limit) throw new ApiError(`חריגה ממכסת ${QUOTA_LABEL[metric]} (${limit}) של החבילה`, 429, "quota_exceeded", { metric, limit });
    };
    // A rejected reservation rolls back with the operation that requested it.
    if (transaction) await reserve(transaction);
    else await db.$transaction(reserve);
    return;
  }
  if (limit === null) return;
  const used = await currentUsage(businessId, metric);
  if (used + amount > limit) throw new ApiError(`חריגה ממכסת ${QUOTA_LABEL[metric]} (${limit}) של החבילה`, 429, "quota_exceeded", { metric, limit, used });
}

export async function usageSummary(businessId: string) {
  const ent = await getEntitlements(businessId);
  const metrics = Object.keys(QLABELS) as QuotaMetric[];
  const usage = await Promise.all(metrics.map((m) => currentUsage(businessId, m)));
  return { ...ent, usage: Object.fromEntries(metrics.map((m, i) => [m, { used: usage[i], limit: ent.quotas[m], label: QUOTA_LABEL[m] }])) };
}
