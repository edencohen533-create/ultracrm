import { withAuth } from "@/lib/api";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertBillingAdmin } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
const cell = (v: unknown) => `"${String(v ?? "").replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`;
/** Every usage row of a month (units, rate version, price, status) – checkable and exportable. */
export const GET = withAuth(async ({ req, user }) => {
  await assertBillingAdmin(user);
  const m = new URL(req.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new ApiError("חודש לא תקין", 400, "validation");
  const start = new Date(`${m}-01T00:00:00Z`); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const rows = await prisma.usageEvent.findMany({ where: { businessId: user.businessId, occurredAt: { gte: start, lt: end } }, orderBy: { occurredAt: "asc" }, take: 100_000 });
  const head = ["occurredAt", "module", "service", "kind", "status", "unit", "quantity", "billedQuantity", "priceBookVersion", "currency", "priceMinor", "billedByProvider", "provider", "providerRef", "id", "correctsEventId"];
  const csv = [head, ...rows.map((r) => [r.occurredAt.toISOString(), r.module, r.service, r.kind, r.status, r.unit, r.quantity.toString(), r.billedQuantity?.toString() ?? "", r.priceBookVersion ?? "", r.currency, r.priceMinor ?? "", r.billedByProvider, r.provider ?? "", r.providerRef ?? "", r.id, r.correctsEventId ?? ""])].map((l) => l.map(cell).join(",")).join("\r\n");
  return new Response("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="usage-${m}.csv"`, "Cache-Control": "private, no-store" } });
});
