import type { marketingReport } from "./report";

type Report = Awaited<ReturnType<typeof marketingReport>>;
const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v); return `"${(/^[=+\-@\t\r]/.test(s) && typeof v !== "number" ? `'${s}` : s).replaceAll('"', '""')}"`; };

/** Same rows / totals as the screen. Empty cell = no data (never 0 in its place). */
export function reportCsv(r: Report) {
  const head = ["רמה", "מזהה", "שם", "הוצאה", "מטבע הוצאה", "חשיפות", "קליקים", "לידים (Meta)", "לידים ייחודיים (CRM)", "עלות לליד", "טופלו", "נוצר קשר", "זמן חציוני לניסיון ראשון (דק׳)", "עסקאות שנסגרו", "רכישות ששולמו", "לקוחות חדשים ששילמו", "עלות פרסום ללקוח חדש", "הכנסות מיוחסות", "מטבע הכנסה", "ROAS", "שיעור פניות לעסקה ששולמה", "רכישה ממוצעת"];
  const lines = [head, ...r.rows.map((x) => [x.level, x.special ? "" : x.key, x.name, x.spend, x.spendCurrency, x.impressions, x.clicks, x.metaLeads, x.leads, x.cpl, x.handled, x.contacted, x.firstAttemptMedianMin, x.closedDeals, x.paidPurchases, x.newCustomers, x.costPerNewCustomer, x.revenue, x.revenueCurrency, x.roas, x.paidRate, x.avgPurchase])];
  const k = r.kpis;
  const revAll = Object.keys(k.revenueBy).length === 1 ? Object.values(k.revenueBy)[0] : null;
  // Totals = all rows including "לא משויך" (each spend row / purchase / deal sits in exactly one row). Unique people:
  // a person who came from two ads is one lead in the total and one in each of those rows.
  lines.push(["סה״כ (כולל לא משויך)", "", "", k.spend, Object.keys(k.spendBy).join("/"), "", "", k.metaLeads, k.crmLeads, k.cpl, k.handled, k.contacted, k.firstAttemptMedianMin, k.closedDeals, k.paidPurchases, k.newCustomers, k.costPerNewCustomer, revAll, Object.keys(k.revenueBy).join("/"), k.roas, k.paidRate, k.avgPurchase]);
  const meta = [[`תקופה ${r.period.from}–${r.period.to} (${r.period.timezone})`], [`מצב: ${r.period.mode === "cohort" ? `לידים שנכנסו בתקופה, חלון הבשלה ${r.period.maturityDays} ימים` : "פעילות בתקופה"}`], [`מודל שיוך: ${r.model.description} חלון שיוך ${r.model.windowDays} ימים.`], ...r.warnings.map((w) => [w])];
  return "﻿" + [...meta, [], ...lines].map((l) => l.map(cell).join(",")).join("\r\n");
}
