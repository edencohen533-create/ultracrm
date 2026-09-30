/**
 * Monthly budget of a business (usage, before tax). New outbound paid actions RESERVE their estimated cost under a
 * per-business lock: spent (priced usage this month) + held reservations + the new one must fit the cap – so parallel
 * queues can't overrun it together. At the cap (hard stop) new outbound paid actions are refused with the reason;
 * a call already in progress, inbound calls / messages, opt-out requests and event logging are never stopped.
 * Alerts fire once per threshold per month. On a paid subscription, a service without a rate can't be used
 * commercially (blocked with the reason – never billed as zero).
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { rateOf } from "./pricebook";
import { ratesFor } from "./usage";

const period = (d = new Date()) => d.toISOString().slice(0, 7);
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

export async function spentThisMonth(businessId: string, tx: Prisma.TransactionClient | typeof db = db) {
  const [used, held] = await Promise.all([
    tx.usageEvent.aggregate({ where: { businessId, occurredAt: { gte: monthStart() }, priceMinor: { not: null }, billedByProvider: false }, _sum: { priceMinor: true } }),
    tx.budgetReservation.aggregate({ where: { businessId, status: "held", expiresAt: { gt: new Date() } }, _sum: { amountMinor: true } }),
  ]);
  return { usedMinor: used._sum.priceMinor ?? 0, heldMinor: held._sum.amountMinor ?? 0 };
}

async function subscribed(businessId: string) {
  const s = await db.subscription.findUnique({ where: { businessId }, select: { status: true } });
  return Boolean(s && s.status !== "none");
}

/**
 * Reserve the estimated cost of an outbound action (idempotent per key). Units × the rate; throws `service_unrated`
 * (no rate on a paid subscription) or `budget_exceeded` (would cross the cap). Legacy / manual businesses: no-op.
 */
export async function reserveBudget(businessId: string, input: { service: string; units: number; key: string; ttlMinutes?: number }) {
  if (!(await subscribed(businessId))) return null;
  const r = await ratesFor(businessId);
  const rate = r ? rateOf(r.rates, input.service) : null;
  if (!rate) throw new ApiError("לשירות הזה עדיין לא נקבע תעריף – לא ניתן להפעיל אותו מסחרית עד שייקבע", 409, "service_unrated", { service: input.service });
  const amount = Math.round(rate.unitPriceMinor! * input.units);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`budget:${businessId}`}, 0))`);
    const existing = await tx.budgetReservation.findUnique({ where: { businessId_key: { businessId, key: input.key } } });
    if (existing) return existing;
    const policy = await tx.budgetPolicy.findUnique({ where: { businessId } });
    if (policy?.monthlyCapMinor !== null && policy?.monthlyCapMinor !== undefined && policy.hardStop) {
      const s = await spentThisMonth(businessId, tx);
      if (s.usedMinor + s.heldMinor + amount > policy.monthlyCapMinor) throw new ApiError("הגעתם לתקרת התקציב החודשית – פעולות יוצאות חדשות בתשלום נעצרו. שיחות פעילות, שיחות והודעות נכנסות ובקשות הסרה ממשיכים.", 402, "budget_exceeded", { capMinor: policy.monthlyCapMinor, usedMinor: s.usedMinor, heldMinor: s.heldMinor, requestedMinor: amount });
    }
    return tx.budgetReservation.create({ data: { businessId, key: input.key, service: input.service, amountMinor: amount, expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 30) * 60_000) } });
  });
}
/** The action finished (its usage is now in the ledger) or never happened – the hold stops counting either way. */
export async function settleReservation(businessId: string, key: string, outcome: "committed" | "released") {
  await db.budgetReservation.updateMany({ where: { businessId, key, status: "held" }, data: { status: outcome } });
}

/** Estimate before a large send (e.g. a campaign): units × rate, and whether it fits the remaining budget. */
export async function estimateCost(businessId: string, service: string, units: number) {
  const r = await ratesFor(businessId); const rate = r ? rateOf(r.rates, service) : null;
  const policy = await db.budgetPolicy.findUnique({ where: { businessId } });
  const s = await spentThisMonth(businessId);
  const amount = rate ? Math.round(rate.unitPriceMinor! * units) : null;
  return { service, units, unitPriceMinor: rate?.unitPriceMinor ?? null, amountMinor: amount, rated: Boolean(rate), capMinor: policy?.monthlyCapMinor ?? null, usedMinor: s.usedMinor, heldMinor: s.heldMinor, fits: amount === null || policy?.monthlyCapMinor == null ? null : s.usedMinor + s.heldMinor + amount <= policy.monthlyCapMinor, note: amount === null ? "אין תעריף לשירות – לא ניתן להעריך ולא ניתן להפעיל מסחרית" : "הערכה לפי התעריף בגרסת המחירון של העסק; החיוב הסופי לפי השימוש בפועל" };
}

export async function getPolicy(businessId: string) {
  return (await db.budgetPolicy.findUnique({ where: { businessId } })) ?? { monthlyCapMinor: null, alertPercents: [50, 80, 100], hardStop: true, alertsSent: {} };
}
export async function setPolicy(businessId: string, actorId: string, input: { monthlyCapMinor: number | null; alertPercents: number[]; hardStop: boolean }) {
  const pcts = [...new Set(input.alertPercents.filter((p) => p > 0 && p <= 200))].sort((a, b) => a - b).slice(0, 6);
  const row = await db.budgetPolicy.upsert({ where: { businessId }, create: { businessId, monthlyCapMinor: input.monthlyCapMinor, alertPercents: pcts, hardStop: input.hardStop, updatedById: actorId }, update: { monthlyCapMinor: input.monthlyCapMinor, alertPercents: pcts, hardStop: input.hardStop, updatedById: actorId } });
  await audit(businessId, actorId, "business", businessId, "billing.budget_set", { monthlyCapMinor: input.monthlyCapMinor, alertPercents: pcts, hardStop: input.hardStop });
  return row;
}

/** Alerts at the configured percentages – once per threshold per month (recorded on the policy). */
export async function checkBudgetAlerts(businessId: string) {
  const p = await db.budgetPolicy.findUnique({ where: { businessId } });
  if (!p?.monthlyCapMinor) return [];
  const s = await spentThisMonth(businessId);
  const pct = (s.usedMinor / p.monthlyCapMinor) * 100;
  const sent = ((p.alertsSent ?? {}) as Record<string, number[]>)[period()] ?? [];
  const due = p.alertPercents.filter((t) => pct >= t && !sent.includes(t));
  if (!due || !due.length) return [];
  await db.budgetPolicy.update({ where: { id: p.id }, data: { alertsSent: { ...((p.alertsSent ?? {}) as object), [period()]: [...sent, ...due] } as Prisma.InputJsonValue } });
  for (const t of due) await audit(businessId, null, "business", businessId, "billing.budget_alert", { threshold: t, usedMinor: s.usedMinor, capMinor: p.monthlyCapMinor });
  return due;
}
