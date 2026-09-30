/**
 * Reconciliation of the usage ledger with a provider's report (CSV the platform admin uploads – providers' report APIs
 * are not connected yet). Findings: missing here / missing at the provider / duplicates / quantity and cost
 * differences / costs that belong to no business. Amounts are integer minor units per currency – never summed across
 * currencies. Nothing is changed automatically: a correction is an explicit adjustment row; issued documents stay.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";

export const reconInputSchema = z.object({
  provider: z.string().min(2).max(40), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), currency: z.string().length(3),
  /** CSV with a header: providerRef,quantity,costMinor[,businessRef] (the platform maps its provider's columns to these). */
  csv: z.string().min(1).max(20_000_000),
  quantityTolerance: z.number().min(0).max(1).default(0.01),
});

function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const ix = (k: string) => head.indexOf(k);
  if (ix("providerRef") < 0 || ix("quantity") < 0 || ix("costMinor") < 0) throw new ApiError("עמודות חובה: providerRef,quantity,costMinor", 400, "validation");
  return lines.map((l, n) => { const c = l.split(",").map((x) => x.trim().replace(/^"|"$/g, "")); const q = Number(c[ix("quantity")]); const cost = Number(c[ix("costMinor")]); if (!c[ix("providerRef")] || !Number.isFinite(q) || !Number.isInteger(cost)) throw new ApiError(`שורה ${n + 2} לא תקינה`, 400, "validation"); return { ref: c[ix("providerRef")], quantity: q, costMinor: cost, businessRef: ix("businessRef") >= 0 ? c[ix("businessRef")] || null : null }; });
}

export async function runReconciliation(actorAccountId: string, input: unknown) {
  const b = reconInputSchema.parse(input);
  const report = parseCsv(b.csv);
  const ledger = await db.usageEvent.findMany({ where: { provider: b.provider, occurredAt: { gte: b.periodStart, lt: b.periodEnd }, kind: { in: ["charge", "cost_only", "adjustment"] }, providerRef: { not: null } }, select: { id: true, businessId: true, providerRef: true, quantity: true, billedQuantity: true, providerCostMinor: true, providerCurrency: true, kind: true } });
  const byRef = new Map<string, typeof ledger>(); for (const r of ledger) byRef.set(r.providerRef!, [...(byRef.get(r.providerRef!) ?? []), r]);
  const items: Array<{ kind: string; providerRef: string | null; businessId: string | null; details: Record<string, unknown> }> = [];
  const seen = new Map<string, number>();
  for (const r of report) seen.set(r.ref, (seen.get(r.ref) ?? 0) + 1);
  for (const [ref, n] of seen) if (n > 1) items.push({ kind: "duplicate", providerRef: ref, businessId: byRef.get(ref)?.[0]?.businessId ?? null, details: { timesInReport: n } });
  const reported = new Map(report.map((r) => [r.ref, r]));
  for (const r of reported.values()) {
    const ours = byRef.get(r.ref);
    if (!ours?.length) { items.push({ kind: r.businessRef ? "missing_internal" : "unassigned", providerRef: r.ref, businessId: null, details: { quantity: r.quantity, costMinor: r.costMinor, currency: b.currency, businessRef: r.businessRef } }); continue; }
    const qty = ours.filter((o) => o.kind !== "cost_only").reduce((s, o) => s + Number(o.billedQuantity ?? o.quantity), 0);
    if (Math.abs(qty - r.quantity) > b.quantityTolerance * Math.max(1, r.quantity)) items.push({ kind: "quantity_diff", providerRef: r.ref, businessId: ours[0].businessId, details: { ours: qty, provider: r.quantity } });
    const cost = ours.reduce((s, o) => s + (o.providerCostMinor ?? 0), 0);
    const known = ours.some((o) => o.providerCostMinor !== null);
    if (known && ours.every((o) => !o.providerCurrency || o.providerCurrency === b.currency) && cost !== r.costMinor) items.push({ kind: "price_diff", providerRef: r.ref, businessId: ours[0].businessId, details: { oursMinor: cost, providerMinor: r.costMinor, currency: b.currency } });
  }
  for (const [ref, ours] of byRef) if (!reported.has(ref)) items.push({ kind: "missing_provider", providerRef: ref, businessId: ours[0].businessId, details: { rows: ours.length } });
  const count = (k: string) => items.filter((i) => i.kind === k).length;
  const summary = { reportRows: report.length, ledgerRows: ledger.length, reportCostMinor: report.reduce((s, r) => s + r.costMinor, 0), currency: b.currency, duplicate: count("duplicate"), missing_internal: count("missing_internal"), missing_provider: count("missing_provider"), quantity_diff: count("quantity_diff"), price_diff: count("price_diff"), unassigned: count("unassigned"), unassignedCostMinor: items.filter((i) => i.kind === "unassigned").reduce((s, i) => s + Number(i.details.costMinor ?? 0), 0) };
  const run = await db.reconciliationRun.create({ data: { provider: b.provider, periodStart: b.periodStart, periodEnd: b.periodEnd, currency: b.currency, summary: summary as Prisma.InputJsonValue, createdById: actorAccountId, items: { create: items.slice(0, 20_000).map((i) => ({ kind: i.kind, providerRef: i.providerRef, businessId: i.businessId, details: i.details as Prisma.InputJsonValue })) } } });
  return { runId: run.id, summary };
}
