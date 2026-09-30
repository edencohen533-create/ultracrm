/**
 * The assistant's view of the marketing report – the SAME calculation as the screen (marketingReport), with the
 * period, sample, attribution model and a link to the detail. It refuses to name a "winner" on a small sample,
 * partial spend data or a cohort that has not matured, and it only ever suggests – it never changes budgets, pauses
 * or launches anything, and it sends nothing to Meta.
 */
import type { SessionUser } from "@/lib/auth";
import { zonedParts } from "@/lib/business-day";
import { getBusinessSettings } from "@/lib/settings";
import { addDays } from "@/lib/reports/compare";
import { assertMarketing } from "./meta-connection";
import { marketingReport, type Level, type Mode } from "./report";

export const MIN_LEADS = 20;
export const MIN_PAID = 3;
export type Focus = "most_paid" | "cheapest_new_customer" | "low_handling" | "compare";

export async function marketingInsight(user: SessionUser, args: { focus?: string; days?: number; from?: string; to?: string; level?: string; mode?: string }) {
  await assertMarketing(user, "view");
  const tz = (await getBusinessSettings(user.businessId)).timezone;
  const today = zonedParts(tz, new Date()).date;
  const days = Math.min(Math.max(Number(args.days) || 30, 7), 365);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from ?? "") ? args.from! : addDays(today, -(days - 1));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to ?? "") ? args.to! : today;
  const level: Level = args.level === "campaign" || args.level === "adset" ? args.level : "ad";
  const mode: Mode = args.mode === "activity" ? "activity" : "cohort";
  const focus: Focus = (["most_paid", "cheapest_new_customer", "low_handling", "compare"] as const).includes(args.focus as Focus) ? (args.focus as Focus) : "most_paid";
  const r = await marketingReport(user, { from, to, mode, level, windowDays: 30, maturityDays: 30, compare: "previous" });
  const link = (key?: string) => `/reports/marketing?preset=custom&from=${from}&to=${to}&mode=${mode}&level=${level}${key ? `&row=${encodeURIComponent(key)}` : ""}`;
  const rows = r.rows.filter((x) => !x.special);
  const caveats: string[] = [...r.warnings];
  const spendComplete = r.coverage.accounts.length > 0 && r.coverage.accounts.every((a) => a.complete);
  const base = { period: { from, to, timezone: tz, mode: mode === "cohort" ? "לידים שנכנסו בתקופה (חלון הבשלה 30 ימים)" : "פעילות בתקופה" }, model: r.model.description, attributionWindowDays: r.model.windowDays, coverage: { leadsAttributed: `${r.coverage.leadsAttributed}/${r.coverage.leadsTotal}`, purchasesAttributed: `${r.coverage.purchasesAttributed}/${r.coverage.purchasesTotal}` }, link: link(), rules: "הצעות בלבד – אין שינוי תקציבים, השהיה או הפעלת קמפיינים, ואין שליחת אירועים ל-Meta." };
  const pick = (x: (typeof rows)[number]) => ({ name: x.name, id: x.key, leads: x.leads, metaLeads: x.metaLeads, paidPurchases: x.paidPurchases, newCustomers: x.newCustomers, spend: x.spend, currency: x.spendCurrency, costPerNewCustomer: x.costPerNewCustomer, revenue: x.revenue, roas: x.roas, handledRate: x.handledRate, contactedRate: x.contactedRate, link: link(x.key) });

  if (focus === "compare") {
    return { ...base, focus, current: r.kpis, previous: r.compare?.kpis ?? null, previousPeriod: r.compare ? { from: r.compare.from, to: r.compare.to } : null, caveats, conclusionAllowed: !r.period.immature && spendComplete, note: r.period.immature ? "התקופה הנוכחית טרם הבשילה – השוואה לתוצאות של תקופה קודמת (בשלה) אינה הוגנת עדיין." : null };
  }
  if (focus === "low_handling") {
    const flagged = rows.filter((x) => x.leads >= 5 && (x.handledRate ?? 1) < 0.7).sort((a, b) => (a.handledRate ?? 0) - (b.handledRate ?? 0)).slice(0, 5).map(pick);
    return { ...base, focus, items: flagged, explanation: "מקורות עם לפחות 5 לידים שפחות מ-70% מהם טופלו. אין להסיק שהמודעה גרועה כשהלידים שלה לא טופלו – זו בעיית טיפול.", caveats };
  }
  const eligible = rows.filter((x) => x.leads >= MIN_LEADS && x.paidPurchases >= MIN_PAID);
  const ranked = focus === "cheapest_new_customer"
    ? eligible.filter((x) => x.costPerNewCustomer !== null && x.newCustomers >= MIN_PAID).sort((a, b) => a.costPerNewCustomer! - b.costPerNewCustomer!)
    : eligible.sort((a, b) => b.paidPurchases - a.paidPurchases || (b.revenue ?? 0) - (a.revenue ?? 0));
  const reasons: string[] = [];
  if (!eligible.length) reasons.push(`אין מקור עם מדגם מספיק (לפחות ${MIN_LEADS} לידים ו-${MIN_PAID} עסקאות ששולמו).`);
  if (r.period.immature && mode === "cohort") reasons.push("חלק מהלידים בתקופה טרם הבשילו – הסדר עוד עשוי להשתנות.");
  if (focus === "cheapest_new_customer" && !spendComplete) reasons.push("נתוני ההוצאה חסרים או חלקיים לתקופה – עלות ללקוח אינה אמינה.");
  const conclusionAllowed = reasons.length === 0 && ranked.length > 0;
  return {
    ...base, focus, conclusionAllowed,
    leader: conclusionAllowed ? pick(ranked[0]) : null,
    candidates: (ranked.length ? ranked : rows.slice().sort((a, b) => b.paidPurchases - a.paidPurchases)).slice(0, 5).map(pick),
    whyNoConclusion: reasons,
    sampleRule: `הכרזה על מקור מוביל רק עם לפחות ${MIN_LEADS} לידים ו-${MIN_PAID} עסקאות ששולמו, נתוני הוצאה מלאים ולידים שהבשילו.`,
    caveats,
  };
}
