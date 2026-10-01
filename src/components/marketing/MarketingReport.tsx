"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MessagingPerformance } from "./MessagingPerformance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Select, Spinner, cx } from "@/components/ui";
import { HelpTip } from "@/components/ai/HelpTip";
import { useT } from "@/components/i18n/LangProvider";
import { addDays } from "@/lib/reports/compare";

type Level = "campaign" | "adset" | "ad";
interface Row { key: string; level: Level; name: string; special: boolean; status: string | null; thumbnailUrl: string | null; renamed: boolean; spend: number | null; spendCurrency: string | null; spendBy: Record<string, number>; impressions: number; clicks: number; metaLeads: number | null; leads: number; handled: number; contacted: number; handledRate: number | null; contactedRate: number | null; firstAttemptMedianMin: number | null; closedDeals: number; paidPurchases: number; newCustomers: number; revenue: number | null; revenueCurrency: string | null; revenueBy: Record<string, number>; refunds: number; cpl: number | null; costPerNewCustomer: number | null; roas: number | null; paidRate: number | null; avgPurchase: number | null }
interface Kpis { spend: number | null; spendBy: Record<string, number>; crmLeads: number; crmLeadsFromAds: number; metaLeads: number | null; cpl: number | null; handled: number; contacted: number; handledRate: number | null; contactedRate: number | null; firstAttemptMedianMin: number | null; closedDeals: number; paidPurchases: number; paidPurchasesFromAds: number; newCustomers: number; newCustomersFromAds: number; costPerNewCustomer: number | null; revenueBy: Record<string, number>; revenueFromAdsBy: Record<string, number>; revenueFromAds: number | null; roas: number | null; avgPurchase: number | null; paidRate: number | null }
interface Report {
  period: { from: string; to: string; timezone: string; today: string; mode: "cohort" | "activity"; level: Level; windowDays: number; maturityDays: number; immature: boolean };
  model: { description: string; windowDays: number }; kpis: Kpis; compare: { from: string; to: string; kpis: Kpis } | null;
  coverage: { accounts: Array<{ accountRowId: string; name: string; accountId: string; currency: string | null; status: string; syncedFrom: string | null; syncedThrough: string | null; lastSyncAt: string | null; complete: boolean }>; leadsAttributedRate: number | null; leadsTotal: number; leadsAttributed: number; purchasesAttributedRate: number | null; purchasesTotal: number; purchasesAttributed: number; dealsAttributedRate: number | null };
  rows: Row[]; warnings: string[];
}

const KEYS = ["preset", "from", "to", "mode", "level", "window", "maturity", "accounts", "agentId", "campaignId", "adsetId", "basis", "compare", "sort", "cols", "row"] as const;
type Q = Record<(typeof KEYS)[number], string>;
const DEF: Q = { preset: "last30", from: "", to: "", mode: "cohort", level: "campaign", window: "30", maturity: "30", accounts: "", agentId: "", campaignId: "", adsetId: "", basis: "gross", compare: "previous", sort: "paidPurchases", cols: "", row: "" };
const EXTRA_COLS: Array<[keyof Row, string, string]> = [["metaLeads", "לידים (Meta)", "Leads (Meta)"], ["cpl", "עלות לליד", "Cost per lead"], ["handledRate", "טופלו", "Handled"], ["contactedRate", "נוצר קשר", "Contacted"], ["firstAttemptMedianMin", "זמן לניסיון ראשון", "Time to first attempt"], ["closedDeals", "עסקאות שנסגרו", "Deals closed"], ["paidRate", "פניות → עסקה ששולמה", "Inquiries → paid"], ["avgPurchase", "רכישה ממוצעת", "Avg. purchase"], ["impressions", "חשיפות", "Impressions"], ["clicks", "קליקים", "Clicks"]];

function presetRange(p: string, today: string): [string, string] {
  const ms = `${today.slice(0, 8)}01`;
  if (p === "last7") return [addDays(today, -6), today];
  if (p === "last90") return [addDays(today, -89), today];
  if (p === "thisMonth") return [ms, today];
  if (p === "lastMonth") { const e = addDays(ms, -1); return [`${e.slice(0, 8)}01`, e]; }
  return [addDays(today, -29), today];
}

/** דוחות ← שיווק ומכירות. Every number comes from the server (one calculation for screen / export / AI). */
export function MarketingReport({ canConnect, canExport }: { canConnect: boolean; canExport: boolean }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const q = useMemo(() => Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? DEF[k]])) as Q, [params]);
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [from, to] = q.preset === "custom" && q.from && q.to ? [q.from, q.to] : presetRange(q.preset, today);
  const [data, setData] = useState<Report | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; fullName: string }>>([]);
  const [colsOpen, setColsOpen] = useState(false);
  const gen = useRef(0);

  const set = useCallback((next: Partial<Q>, push = false) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (!v || v === DEF[k as keyof Q]) sp.delete(k); else sp.set(k, v); }
    const href = `${pathname}${sp.size ? `?${sp}` : ""}`;
    if (push) router.push(href, { scroll: false }); else router.replace(href, { scroll: false });
  }, [params, pathname, router]);

  const apiQuery = useMemo(() => qs({ from, to, mode: q.mode, level: q.level, window: q.window, maturity: q.maturity, accounts: q.accounts, agentId: q.agentId, campaignId: q.campaignId, adsetId: q.adsetId, basis: q.basis, compare: q.compare }), [from, to, q]);
  useEffect(() => {
    const token = ++gen.current; setLoading(true);
    api.get<Report>(`/api/reports/marketing${apiQuery}`).then((r) => { if (gen.current === token) { setData(r); setError(""); } }).catch((e) => { if (gen.current === token) setError((e as Error).message); }).finally(() => { if (gen.current === token) setLoading(false); });
  }, [apiQuery]);
  useEffect(() => { api.get<{ agents: Array<{ id: string; fullName: string }> }>("/api/reports/filters").then((f) => setAgents(f.agents)).catch(() => undefined); }, []);

  const money = (v: number | null | undefined, cur?: string | null) => v === null || v === undefined ? t("אין נתון", "No data") : cur && cur !== "ILS" ? `${v.toLocaleString(loc, { maximumFractionDigits: 0 })} ${cur}` : `₪${v.toLocaleString(loc, { maximumFractionDigits: 0 })}`;
  const moneyBy = (by: Record<string, number>) => { const e = Object.entries(by); return e.length === 0 ? money(0) : e.map(([c, v]) => money(v, c)).join(" + "); };
  const pct = (v: number | null) => (v === null ? t("אין נתון", "No data") : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null) => (v === null ? t("אין נתון", "No data") : v.toLocaleString(loc));
  const mins = (v: number | null) => (v === null ? t("אין נתון", "No data") : v < 60 ? t(`${Math.round(v)} דק׳`, `${Math.round(v)} min`) : v < 1440 ? t(`${(v / 60).toFixed(1)} שע׳`, `${(v / 60).toFixed(1)} h`) : t(`${(v / 1440).toFixed(1)} ימים`, `${(v / 1440).toFixed(1)} days`));
  const extra = q.cols ? q.cols.split(",") : [];
  const k = data?.kpis; const ck = data?.compare?.kpis;
  const delta = (cur: number | null | undefined, prev: number | null | undefined) => cur === null || cur === undefined || prev === null || prev === undefined ? null : prev === 0 ? (cur === 0 ? t("ללא שינוי", "No change") : t("לא היה בתקופה הקודמת", "none before")) : `${cur >= prev ? "▲" : "▼"} ${Math.abs(((cur - prev) / prev) * 100).toFixed(0)}%`;
  const noAccounts = data && data.coverage.accounts.length === 0;

  const sorted = useMemo(() => {
    if (!data) return [];
    const key = q.sort as keyof Row; const asc = key === "costPerNewCustomer"; // lower cost is better
    const v = (r: Row) => r[key] as number | null;
    return [...data.rows].sort((a, b) => {
      if (a.special !== b.special) return a.special ? 1 : -1;       // "לא משויך" rows last
      const x = v(a), y = v(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // "no data" last
      return asc ? x - y : y - x;
    });
  }, [data, q.sort]);

  function drill(r: Row) {
    if (r.special) return set({ row: r.key }, true);
    if (q.level === "campaign") set({ level: "adset", campaignId: r.key, adsetId: "", row: "" }, true);
    else if (q.level === "adset") set({ level: "ad", adsetId: r.key, row: "" }, true);
    else set({ row: r.key }, true);
  }

  return (
    <div className="space-y-4 p-4 md:p-5" data-testid="marketing-report">
      <div className="flex justify-end"><Link href="/reports/marketing/meta" className="inline-flex h-9 items-center gap-1 rounded-lg border border-line bg-panel px-3 text-sm hover:border-accent hover:text-accent" data-testid="open-meta-conversions">{t("המרות למטא", "Conversions to Meta")}</Link></div>
      <section className="rounded-xl border border-line bg-panel p-3 space-y-2" aria-label={t("סינון", "Filters")}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <Select label={t("תקופה", "Period")} value={q.preset} onChange={(e) => set({ preset: e.target.value, ...(e.target.value === "custom" ? { from, to } : { from: "", to: "" }) })} data-testid="mkt-preset">
            <option value="last7">{t("7 ימים אחרונים", "Last 7 days")}</option><option value="last30">{t("30 ימים אחרונים", "Last 30 days")}</option><option value="last90">{t("90 ימים אחרונים", "Last 90 days")}</option><option value="thisMonth">{t("החודש", "This month")}</option><option value="lastMonth">{t("החודש הקודם", "Last month")}</option><option value="custom">{t("טווח מותאם", "Custom")}</option>
          </Select>
          <Select label={t("מצב מדידה", "Measurement")} value={q.mode} onChange={(e) => set({ mode: e.target.value })} data-testid="mkt-mode">
            <option value="cohort">{t("לידים שנכנסו בתקופה", "Leads that entered in the period")}</option><option value="activity">{t("פעילות בתקופה", "Activity in the period")}</option>
          </Select>
          {q.mode === "cohort" && <Select label={t("חלון הבשלה", "Maturity window")} value={q.maturity} onChange={(e) => set({ maturity: e.target.value })} data-testid="mkt-maturity">{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t(`${d} ימים`, `${d} days`)}</option>)}</Select>}
          <Select label={t("חלון שיוך", "Attribution window")} value={q.window} onChange={(e) => set({ window: e.target.value })} data-testid="mkt-window">{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t(`${d} ימים`, `${d} days`)}</option>)}</Select>
          <Select label={t("השוואה", "Compare")} value={q.compare} onChange={(e) => set({ compare: e.target.value })}><option value="previous">{t("לתקופה הקודמת", "Previous period")}</option><option value="none">{t("ללא", "None")}</option></Select>
          <Select label={t("חשבון פרסום", "Ad account")} value={q.accounts} onChange={(e) => set({ accounts: e.target.value, campaignId: "", adsetId: "" })} data-testid="mkt-account"><option value="">{t("כל החשבונות", "All accounts")}</option>{data?.coverage.accounts.map((a) => <option key={a.accountRowId} value={a.accountRowId}>{a.name}</option>)}</Select>
          <Select label={t("נציג", "Agent")} value={q.agentId} onChange={(e) => set({ agentId: e.target.value })} data-testid="mkt-agent"><option value="">{t("כל הנציגים", "All agents")}</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>
          <Select label={t("בסיס הכנסה", "Revenue basis")} value={q.basis} onChange={(e) => set({ basis: e.target.value })}><option value="gross">{t("כולל מע״מ ומשלוח", "Incl. VAT & shipping")}</option><option value="ex_tax_shipping">{t("ללא מע״מ ומשלוח (הזמנות חנות)", "Excl. VAT & shipping (store orders)")}</option></Select>
        </div>
        {q.preset === "custom" && <div className="flex flex-wrap gap-2 text-sm"><input type="date" aria-label={t("מתאריך", "From")} className="h-9 rounded-md border border-line bg-bg px-2" value={from} max={to} onChange={(e) => set({ from: e.target.value })} /><input type="date" aria-label={t("עד תאריך", "To")} className="h-9 rounded-md border border-line bg-bg px-2" value={to} min={from} onChange={(e) => set({ to: e.target.value })} /></div>}
        {data && <p className="text-xs text-muted" data-testid="mkt-model"><b>{t("מודל שיוך:", "Attribution model:")}</b> {data.model.description} {t(`חלון שיוך: ${data.model.windowDays} ימים.`, `Window: ${data.model.windowDays} days.`)} {data.period.mode === "cohort" ? t(`נמדדות תוצאות הפניות שנכנסו בתקופה עד ${data.period.maturityDays} ימים מכל פנייה.`, `Results of inquiries that entered in the period, up to ${data.period.maturityDays} days from each.`) : ""} <span className="ltr">{data.period.from} – {data.period.to}</span> ({data.period.timezone}).</p>}
        {data && <p className="text-xs" data-testid="mkt-coverage">{t("שויכו למודעה:", "Attributed to an ad:")} <b>{pct(data.coverage.leadsAttributedRate)}</b> {t(`מהלידים (${data.coverage.leadsAttributed}/${data.coverage.leadsTotal})`, `of leads (${data.coverage.leadsAttributed}/${data.coverage.leadsTotal})`)} · <b>{pct(data.coverage.purchasesAttributedRate)}</b> {t(`מהרכישות ששולמו (${data.coverage.purchasesAttributed}/${data.coverage.purchasesTotal})`, `of paid purchases (${data.coverage.purchasesAttributed}/${data.coverage.purchasesTotal})`)} · <b>{pct(data.coverage.dealsAttributedRate)}</b> {t("מהעסקאות שנסגרו", "of closed deals")}</p>}
      </section>

      {noAccounts && (
        <div className="rounded-xl border border-dashed border-line bg-panel p-4 text-sm flex flex-wrap items-center gap-3" data-testid="mkt-no-connection">
          <p className="flex-1 min-w-60">{t("לא מחובר חשבון פרסום, ולכן אין נתוני הוצאה, עלות ללקוח ו-ROAS. הלידים, הטיפול והמכירות מוצגים לפי מקור הפנייה שנשמר.", "No ad account is connected, so there's no spend, cost per customer or ROAS. Leads, handling and sales are shown by the saved inquiry source.")}</p>
          {canConnect ? <Link href="/settings?tab=connections#meta-ads" className="inline-flex items-center h-9 px-4 rounded-lg bg-accent text-white text-sm font-medium" data-testid="mkt-connect">{t("חבר חשבון פרסום", "Connect ad account")}</Link> : <span className="text-muted text-xs">{t("חיבור חשבון פרסום – על ידי בעל העסק או מנהל מורשה.", "An ad account is connected by the owner or an authorized manager.")}</span>}
        </div>
      )}
      {data?.warnings.length ? <ul className="space-y-1 text-xs" data-testid="mkt-warnings">{data.warnings.map((w) => <li key={w} className="rounded-md bg-warn/10 border border-warn/30 px-2 py-1">{w}</li>)}</ul> : null}
      {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-2 text-sm">{error}</p>}
      {!data && !error && <div className="flex justify-center p-10"><Spinner /></div>}

      {data && k && (
        <>
          <section className={cx("grid grid-cols-2 gap-3 lg:grid-cols-5", loading && "opacity-60")} aria-label={t("מדדים מרכזיים", "Key metrics")} data-testid="mkt-kpis">
            <Kpi id="spend" label={t("הוצאות פרסום", "Ad spend")} value={k.spend === null && Object.keys(k.spendBy).length > 1 ? moneyBy(k.spendBy) : money(k.spend)} prev={ck ? money(ck.spend) : null} delta={delta(k.spend, ck?.spend)} help={t("סכום ההוצאה שמטא דיווחה לכל המודעות בחשבונות שנבחרו, לפי ימים באזור הזמן של חשבון הפרסום. ימים שלא סונכרנו אינם נספרים כאפס.", "Spend Meta reported for all ads of the selected accounts, by day in the ad account's time zone. Unsynced days are not counted as zero.")} />
            <Kpi id="leads" label={t("לידים ייחודיים ב-CRM", "Unique CRM leads")} value={num(k.crmLeads)} sub={t(`${k.crmLeadsFromAds} ממודעות · Meta מדווחת ${k.metaLeads ?? "—"}`, `${k.crmLeadsFromAds} from ads · Meta reports ${k.metaLeads ?? "—"}`)} prev={ck ? num(ck.crmLeads) : null} delta={delta(k.crmLeads, ck?.crmLeads)} help={t("אנשים (לא פניות) שפנו בתקופה. אדם שפנה פעמיים נספר פעם אחת. לידים של Meta מוצגים בנפרד – ההגדרה, השיוך והתקופה שלהם שונים ולכן המספרים לא חייבים להיות זהים.", "People (not inquiries) who inquired in the period; someone who inquired twice counts once. Meta's leads are shown apart – different definition, attribution and period, so the numbers need not match.")} />
            <Kpi id="newCustomers" label={t("לקוחות חדשים ששילמו", "New paying customers")} value={num(k.newCustomersFromAds)} sub={t(`${k.newCustomers} בסך הכול (כולל לא משויך)`, `${k.newCustomers} in total (incl. unattributed)`)} prev={ck ? num(ck.newCustomersFromAds) : null} delta={delta(k.newCustomersFromAds, ck?.newCustomersFromAds)} help={t("אנשים שהרכישה ששולמה הראשונה שלהם אי פעם משויכת למודעה. רכישה שהוחזרה במלואה אינה נספרת.", "People whose first-ever paid purchase is attributed to an ad. A fully refunded purchase doesn't count.")} />
            <Kpi id="cpc" label={t("עלות פרסום ללקוח חדש", "Ad cost per new customer")} value={money(k.costPerNewCustomer)} prev={ck ? money(ck.costPerNewCustomer) : null} delta={delta(k.costPerNewCustomer, ck?.costPerNewCustomer)} help={t("הוצאות פרסום חלקי לקוחות חדשים ששילמו ממודעות. זו אינה עלות רכישת לקוח מלאה – לא כוללת שכר נציגים ועלויות אחרות.", "Ad spend divided by new paying customers from ads. Not a full acquisition cost – excludes agents' pay and other costs.")} />
            <Kpi id="revenue" label={t("הכנסות מיוחסות", "Attributed revenue")} value={k.revenueFromAds === null ? moneyBy(k.revenueFromAdsBy) : money(k.revenueFromAds)} sub={`ROAS ${k.roas === null ? t("אין נתון", "No data") : k.roas.toFixed(2)}`} prev={ck ? money(ck.revenueFromAds) : null} delta={delta(k.revenueFromAds, ck?.revenueFromAds)} help={t("סכום הרכישות ששולמו ומשויכות למודעות, לאחר החזרים (הזמנות חנות). ROAS = הכנסות מיוחסות חלקי הוצאות פרסום, רק כשהמטבע זהה. אין כאן רווח – רווחיות דורשת נתוני עלויות.", "Paid purchases attributed to ads, after refunds (store orders). ROAS = attributed revenue ÷ ad spend, only in the same currency. This is not profit – profitability needs cost data.")} />
          </section>
          <details className="rounded-xl border border-line bg-panel" data-testid="mkt-more">
            <summary className="cursor-pointer px-3 py-2 text-sm">{t("מדדים נוספים", "More metrics")}</summary>
            <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-4">
              <Kpi id="cpl" label={t("עלות לליד ב-CRM", "Cost per CRM lead")} value={money(k.cpl)} help={t("הוצאות פרסום חלקי לידים ייחודיים שהגיעו ממודעות.", "Ad spend ÷ unique leads from ads.")} />
              <Kpi id="handled" label={t("לידים שטופלו", "Leads handled")} value={pct(k.handledRate)} sub={num(k.handled)} help={t("פנייה שהיה אחריה ניסיון התקשרות, הודעת נציג או שינוי סטטוס.", "An inquiry followed by a call attempt, an agent message or a status change.")} />
              <Kpi id="contacted" label={t("נוצר קשר", "Contacted")} value={pct(k.contactedRate)} sub={num(k.contacted)} help={t("שיחה שנענתה, או תשובה של הלקוח בוואטסאפ אחרי הודעת נציג.", "An answered call, or a WhatsApp reply from the customer after an agent message.")} />
              <Kpi id="firstAttempt" label={t("זמן חציוני לניסיון ראשון", "Median time to first attempt")} value={mins(k.firstAttemptMedianMin)} help={t("מהפנייה ועד השיחה היוצאת או הודעת הנציג הראשונה.", "From the inquiry to the first outbound call or agent message.")} />
              <Kpi id="closed" label={t("עסקאות שנסגרו", "Deals closed")} value={num(k.closedDeals)} help={t("עסקאות שסומנו \"נסגרה\" – בלי קשר לתשלום.", "Deals marked won – regardless of payment.")} />
              <Kpi id="paid" label={t("עסקאות ששולמו", "Paid purchases")} value={num(k.paidPurchases)} sub={t(`${k.paidPurchasesFromAds} ממודעות`, `${k.paidPurchasesFromAds} from ads`)} help={t("הזמנות שהחנות סימנה כשולמו ותשלומים שספק הסליקה אישר; אותה רכישה משני מקורות נספרת פעם אחת.", "Orders the store marked paid and payments the provider confirmed; the same purchase from two sources counts once.")} />
              <Kpi id="paidRate" label={t("פניות שהובילו לעסקה ששולמה", "Inquiries → paid purchase")} value={pct(k.paidRate)} help={t("רק במצב \"לידים שנכנסו בתקופה\": מתוך הלידים ממודעות, אלה ששילמו בתוך חלון ההבשלה.", "Cohort mode only: of the leads from ads, those who paid within the maturity window.")} />
              <Kpi id="avg" label={t("סכום רכישה ממוצע", "Average purchase")} value={money(k.avgPurchase)} help={t("הכנסות חלקי רכישות ששולמו.", "Revenue ÷ paid purchases.")} />
            </div>
          </details>

          <div className="rounded-xl border border-line bg-panel">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <nav className="flex gap-1" aria-label={t("רמה", "Level")} data-testid="mkt-levels">
                {(["campaign", "adset", "ad"] as Level[]).map((l) => <button key={l} type="button" onClick={() => set({ level: l, row: "" })} className={cx("h-8 px-3 rounded-md text-sm", q.level === l ? "bg-accent text-white" : "hover:bg-panel-2")} aria-current={q.level === l ? "page" : undefined}>{l === "campaign" ? t("קמפיינים", "Campaigns") : l === "adset" ? t("קבוצות מודעות", "Ad sets") : t("מודעות", "Ads")}</button>)}
              </nav>
              {(q.campaignId || q.adsetId) && <span className="text-xs flex items-center gap-1" data-testid="mkt-breadcrumb">{q.campaignId && <>{t("קמפיין", "Campaign")} <span className="ltr">{q.campaignId}</span></>}{q.adsetId && <><ChevronLeft size={12} />{t("קבוצה", "Ad set")} <span className="ltr">{q.adsetId}</span></>}<button type="button" aria-label={t("הסר", "Clear")} onClick={() => set({ campaignId: "", adsetId: "" })}><X size={13} /></button></span>}
              <div className="ms-auto flex items-center gap-2">
                <Select aria-label={t("מיון", "Sort")} value={q.sort} onChange={(e) => set({ sort: e.target.value })} className="h-8" data-testid="mkt-sort"><option value="paidPurchases">{t("מיון: סגירות ששולמו", "Sort: paid purchases")}</option><option value="costPerNewCustomer">{t("מיון: עלות ללקוח", "Sort: cost per customer")}</option><option value="revenue">{t("מיון: הכנסות", "Sort: revenue")}</option><option value="roas">{t("מיון: ROAS", "Sort: ROAS")}</option><option value="spend">{t("מיון: הוצאה", "Sort: spend")}</option><option value="leads">{t("מיון: לידים", "Sort: leads")}</option></Select>
                <Button size="sm" variant="secondary" onClick={() => setColsOpen((v) => !v)}>{t("עמודות", "Columns")}</Button>
                {canExport && <a className="inline-flex items-center h-8 px-3 rounded-md text-xs border border-line" href={`/api/reports/marketing/export${apiQuery}`} data-testid="mkt-export">{t("ייצוא CSV", "Export CSV")}</a>}
              </div>
            </div>
            {colsOpen && <div className="flex flex-wrap gap-3 px-3 py-2 text-xs border-b border-line">{EXTRA_COLS.map(([c, he, en]) => <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={extra.includes(c)} onChange={(e) => set({ cols: (e.target.checked ? [...extra, c] : extra.filter((x) => x !== c)).join(",") })} /> {t(he, en)}</label>)}</div>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]" data-testid="mkt-table">
                <thead className="text-xs text-muted"><tr>
                  <th className="text-start px-3 h-9 font-medium">{q.level === "campaign" ? t("קמפיין", "Campaign") : q.level === "adset" ? t("קבוצת מודעות", "Ad set") : t("מודעה", "Ad")}</th>
                  <th className="text-start px-2 font-medium">{t("הוצאה", "Spend")}</th><th className="text-start px-2 font-medium">{t("לידים", "Leads")}</th><th className="text-start px-2 font-medium">{t("שולמו", "Paid")}</th><th className="text-start px-2 font-medium">{t("לקוחות חדשים", "New customers")}</th><th className="text-start px-2 font-medium">{t("עלות ללקוח", "Cost / customer")}</th><th className="text-start px-2 font-medium">{t("הכנסות", "Revenue")}</th><th className="text-start px-2 font-medium">ROAS</th>
                  {EXTRA_COLS.filter(([c]) => extra.includes(c)).map(([c, he, en]) => <th key={c} className="text-start px-2 font-medium">{t(he, en)}</th>)}
                  <th />
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {sorted.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-muted">{t("אין נתונים לתקופה ולסינון", "No data for this period and filter")}</td></tr>}
                  {sorted.map((r) => (
                    <tr key={r.key} className={cx("hover:bg-panel-2 cursor-pointer", r.special && "text-muted")} onClick={() => drill(r)} data-testid={`mkt-row-${r.key}`}>
                      <td className="px-3 h-11"><div className="flex items-center gap-2 min-w-0">{r.thumbnailUrl && <img src={r.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" referrerPolicy="no-referrer" />}<span className="truncate max-w-[280px]" title={r.name}>{r.name}</span>{r.renamed && <Badge tone="neutral">{t("שם שונה", "Renamed")}</Badge>}{r.status && r.status !== "ACTIVE" && <Badge tone="neutral">{t("לא פעיל", "Inactive")}</Badge>}</div></td>
                      <td className="px-2 tabular-nums">{r.spend === null && Object.keys(r.spendBy).length > 1 ? moneyBy(r.spendBy) : r.special ? "—" : money(r.spend, r.spendCurrency)}</td>
                      <td className="px-2 tabular-nums">{r.leads}{r.metaLeads !== null && <span className="text-muted text-xs"> / Meta {r.metaLeads}</span>}</td>
                      <td className="px-2 tabular-nums">{r.paidPurchases}{r.closedDeals > 0 && <span className="text-muted text-xs"> · {t("נסגרו", "closed")} {r.closedDeals}</span>}</td>
                      <td className="px-2 tabular-nums">{r.newCustomers}</td>
                      <td className="px-2 tabular-nums">{r.special ? "—" : money(r.costPerNewCustomer, r.spendCurrency)}</td>
                      <td className="px-2 tabular-nums">{r.revenue === null ? moneyBy(r.revenueBy) : money(r.revenue, r.revenueCurrency)}</td>
                      <td className="px-2 tabular-nums">{r.roas === null ? <span className="text-muted">{t("אין נתון", "No data")}</span> : r.roas.toFixed(2)}</td>
                      {EXTRA_COLS.filter(([c]) => extra.includes(c)).map(([c]) => <td key={c} className="px-2 tabular-nums">{c === "cpl" || c === "avgPurchase" ? money(r[c] as number | null, c === "cpl" ? r.spendCurrency : r.revenueCurrency) : c === "handledRate" || c === "contactedRate" || c === "paidRate" ? pct(r[c] as number | null) : c === "firstAttemptMedianMin" ? mins(r[c] as number | null) : num(r[c] as number | null)}</td>)}
                      <td className="px-2"><button type="button" className="text-xs underline text-accent" onClick={(e) => { e.stopPropagation(); set({ row: r.key }, true); }} data-testid={`mkt-detail-${r.key}`}>{t("פירוט", "Details")}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-3 py-2 text-[11px] text-muted border-t border-line">{t("כל רכישה ועסקה משויכות לשורה אחת בלבד, ולכן סכום השורות שווה לסיכום. אדם שפנה משתי מודעות נספר כליד בכל אחת מהן. הוצאה של קמפיין היא סכום הוצאות המודעות שלו.", "Every purchase and deal sits in exactly one row, so rows add up to the totals. A person who inquired from two ads is a lead in each. A campaign's spend is the sum of its ads.")}</p>
          </div>
        </>
      )}
      {/* ביצועי דיוור – delivery per sender / channel (moved from the old Analytics tab); independent of the ad data */}
      {from && to && from <= to && <MessagingPerformance from={from} to={to} />}
      {q.row && <RowDrawer query={apiQuery} rowKey={q.row} onClose={() => router.back()} money={money} pct={pct} mins={mins} />}
    </div>
  );
}

function Kpi({ id, label, value, sub, prev, delta, help }: { id: string; label: string; value: string; sub?: string; prev?: string | null; delta?: string | null; help: string }) {
  const t = useT();
  return (
    <article className="rounded-xl border border-line bg-panel p-3" data-testid={`mkt-kpi-${id}`}>
      <div className="flex items-center gap-1 text-xs text-muted">{label}<HelpTip label={label}>{help}</HelpTip></div>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
      {prev && <p className="text-xs text-muted">{t("לעומת", "vs")} {prev}{delta ? ` · ${delta}` : ""}</p>}
    </article>
  );
}

interface Detail {
  name: string; level: Level; row: Row | null; entity: { status: string | null; thumbnailUrl: string | null; previewUrl: string | null; nameHistory: Array<{ name: string; until: string }>; campaignId: string | null; adsetId: string | null } | null;
  inquiries: Array<{ contactId: string; name: string; at: string; channel: string; leadId: string | null; owner: string | null; handled: boolean; contacted: boolean; firstAttemptMin: number | null; paid: boolean; leadStatus: string | null }>;
  purchases: Array<{ key: string; kind: string; contactId: string; name: string; at: string; gross: number; refunded: number; net: number; currency: string; first: boolean; basis: string; label: string }>;
  deals: Array<{ id: string; contactId: string; name: string; at: string; amount: number; currency: string; title: string; basis: string }>;
  byAgent: Array<{ agent: string; leads: number; handled: number; contacted: number; paid: number; firstAttemptMedianMin: number | null; handledRate: number | null; contactedRate: number | null }>;
  byResponseTime: Array<{ bucket: string; leads: number; contacted: number; paid: number }>;
}
const BASIS: Record<string, [string, string]> = { linked_lead: ["לפי הליד שקושר לעסקה", "By the lead linked to the deal"], last_inquiry_in_window: ["פנייה אחרונה בחלון", "Last inquiry in window"], linked_lead_without_source: ["ליד מקושר ללא מקור", "Linked lead without source"], no_inquiry_in_window: ["אין פנייה בחלון", "No inquiry in window"] };

function RowDrawer({ query, rowKey, onClose, money, pct, mins }: { query: string; rowKey: string; onClose: () => void; money: (v: number | null | undefined, c?: string | null) => string; pct: (v: number | null) => string; mins: (v: number | null) => string }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [d, setD] = useState<Detail | null>(null); const [err, setErr] = useState(""); const [tab, setTab] = useState<"inquiries" | "purchases" | "deals" | "agents" | "response">("inquiries");
  useEffect(() => { let live = true; api.get<Detail>(`/api/reports/marketing/detail${query}&key=${encodeURIComponent(rowKey)}`).then((x) => live && setD(x)).catch((e) => live && setErr((e as Error).message)); return () => { live = false; }; }, [query, rowKey]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const dt = (s: string) => new Date(s).toLocaleString(loc, { dateStyle: "short", timeStyle: "short" });
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/20" onClick={onClose} aria-hidden />
      <aside className="lead-side-drawer" style={{ width: "min(720px,100vw)" }} role="dialog" aria-modal="true" aria-label={t("פירוט", "Details")} data-testid="mkt-drawer">
        <header><strong className="truncate">{d?.name ?? t("פירוט", "Details")}</strong><button type="button" onClick={onClose} aria-label={t("סגור", "Close")}><X size={20} /></button></header>
        <div className="space-y-3">
          {err && <p role="alert" className="text-bad text-sm">{err}</p>}
          {!d && !err && <div className="flex justify-center p-8"><Spinner /></div>}
          {d && (
            <>
              {d.entity && (
                <div className="flex gap-3 items-start text-xs">
                  {d.entity.thumbnailUrl ? <img src={d.entity.thumbnailUrl} alt={t("תצוגה מקדימה של המודעה", "Ad preview")} className="w-24 h-24 rounded object-cover" referrerPolicy="no-referrer" /> : d.level === "ad" && <div className="w-24 h-24 rounded bg-panel-2 flex items-center justify-center text-muted text-center p-1">{t("אין תצוגה מקדימה", "No preview")}</div>}
                  <div className="space-y-1">
                    {d.entity.status && <p>{t("מצב ב-Meta:", "Status at Meta:")} <span className="ltr">{d.entity.status}</span></p>}
                    {d.entity.previewUrl && <a href={d.entity.previewUrl} target="_blank" rel="noopener noreferrer" className="underline text-accent">{t("תצוגת המודעה ב-Meta", "Open the ad preview at Meta")}</a>}
                    {d.entity.nameHistory?.length > 0 && <p className="text-muted">{t("שמות קודמים:", "Earlier names:")} {d.entity.nameHistory.map((h) => h.name).join(" · ")}</p>}
                  </div>
                </div>
              )}
              {d.row && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {[[t("הוצאה", "Spend"), money(d.row.spend, d.row.spendCurrency)], [t("לידים (CRM / Meta)", "Leads (CRM / Meta)"), `${d.row.leads} / ${d.row.metaLeads ?? "—"}`], [t("טופלו / נוצר קשר", "Handled / contacted"), `${pct(d.row.handledRate)} / ${pct(d.row.contactedRate)}`], [t("זמן לניסיון ראשון", "First attempt"), mins(d.row.firstAttemptMedianMin)], [t("נסגרו / שולמו", "Closed / paid"), `${d.row.closedDeals} / ${d.row.paidPurchases}`], [t("לקוחות חדשים", "New customers"), String(d.row.newCustomers)], [t("הכנסות", "Revenue"), money(d.row.revenue, d.row.revenueCurrency)], ["ROAS", d.row.roas === null ? t("אין נתון", "No data") : d.row.roas.toFixed(2)]].map(([l, v]) => <div key={l} className="rounded-md border border-line p-2"><p className="text-muted">{l}</p><p className="font-semibold tabular-nums">{v}</p></div>)}
              </div>}
              {d.row && d.row.metaLeads !== null && d.row.metaLeads !== d.row.leads && <p className="text-xs text-muted">{t("הפער בין לידים ב-Meta ל-CRM: Meta סופרת לפי הגדרת האירוע והשיוך שלה (כולל צפייה) וביום החשבון; ה-CRM סופר אנשים שפנייתם נקלטה עם מזהה המודעה. פניות שנקלטו בלי מזהה אינן משויכות.", "Meta vs CRM gap: Meta counts by its own event and attribution definitions (incl. view-through) in the account's day; the CRM counts people whose inquiry arrived with the ad id. Inquiries without an id aren't attributed.")}</p>}
              <nav className="flex flex-wrap gap-1 text-xs" aria-label={t("פירוט", "Details")}>{([["inquiries", t(`פניות (${d.inquiries.length})`, `Inquiries (${d.inquiries.length})`)], ["purchases", t(`רכישות (${d.purchases.length})`, `Purchases (${d.purchases.length})`)], ["deals", t(`עסקאות (${d.deals.length})`, `Deals (${d.deals.length})`)], ["agents", t("לפי נציג", "By agent")], ["response", t("לפי זמן תגובה", "By response time")]] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={cx("h-7 px-2.5 rounded-full border", tab === k ? "bg-accent text-white border-accent" : "border-line")}>{l}</button>)}</nav>
              <div className="overflow-x-auto text-xs">
                {tab === "inquiries" && <table className="w-full min-w-[520px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("לקוח", "Customer")}</th><th className="text-start">{t("מועד", "Time")}</th><th className="text-start">{t("נציג", "Agent")}</th><th className="text-start">{t("טופל", "Handled")}</th><th className="text-start">{t("קשר", "Contact")}</th><th className="text-start">{t("ניסיון ראשון", "First attempt")}</th><th className="text-start">{t("שילם", "Paid")}</th></tr></thead><tbody className="divide-y divide-line">{d.inquiries.map((x) => <tr key={x.contactId + x.at}><td className="py-1"><Link className="underline" href={`/contacts/${x.contactId}`}>{x.name}</Link></td><td>{dt(x.at)}</td><td>{x.owner ?? "—"}</td><td>{x.handled ? "✓" : "—"}</td><td>{x.contacted ? "✓" : "—"}</td><td>{mins(x.firstAttemptMin)}</td><td>{x.paid ? "✓" : ""}</td></tr>)}</tbody></table>}
                {tab === "purchases" && <table className="w-full min-w-[520px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("לקוח", "Customer")}</th><th className="text-start">{t("מועד", "Time")}</th><th className="text-start">{t("סכום נטו", "Net")}</th><th className="text-start">{t("החזר", "Refund")}</th><th className="text-start">{t("סוג", "Type")}</th><th className="text-start">{t("בסיס שיוך", "Basis")}</th></tr></thead><tbody className="divide-y divide-line">{d.purchases.map((x) => <tr key={x.key}><td className="py-1"><Link className="underline" href={`/contacts/${x.contactId}`}>{x.name}</Link></td><td>{dt(x.at)}</td><td>{money(x.net, x.currency)}</td><td>{x.refunded ? money(x.refunded, x.currency) : "—"}</td><td>{x.first ? t("רכישה ראשונה", "First purchase") : t("רכישה חוזרת", "Repeat")} · {x.kind === "store_order" ? t("חנות", "Store") : t("סליקה", "Payment")}</td><td>{t(...(BASIS[x.basis] ?? [x.basis, x.basis]))}</td></tr>)}</tbody></table>}
                {tab === "deals" && <table className="w-full min-w-[420px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("עסקה", "Deal")}</th><th className="text-start">{t("לקוח", "Customer")}</th><th className="text-start">{t("נסגרה", "Closed")}</th><th className="text-start">{t("סכום (לא בהכרח שולם)", "Amount (not necessarily paid)")}</th></tr></thead><tbody className="divide-y divide-line">{d.deals.map((x) => <tr key={x.id}><td className="py-1">{x.title}</td><td><Link className="underline" href={`/contacts/${x.contactId}`}>{x.name}</Link></td><td>{dt(x.at)}</td><td>{money(x.amount, x.currency)}</td></tr>)}</tbody></table>}
                {tab === "agents" && <table className="w-full min-w-[420px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("נציג", "Agent")}</th><th className="text-start">{t("לידים", "Leads")}</th><th className="text-start">{t("טופלו", "Handled")}</th><th className="text-start">{t("נוצר קשר", "Contacted")}</th><th className="text-start">{t("זמן חציוני", "Median")}</th><th className="text-start">{t("שילמו", "Paid")}</th></tr></thead><tbody className="divide-y divide-line">{d.byAgent.map((x) => <tr key={x.agent}><td className="py-1">{x.agent}</td><td>{x.leads}</td><td>{pct(x.handledRate)}</td><td>{pct(x.contactedRate)}</td><td>{mins(x.firstAttemptMedianMin)}</td><td>{x.paid}</td></tr>)}</tbody></table>}
                {tab === "response" && <table className="w-full min-w-[360px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("זמן עד ניסיון ראשון", "Time to first attempt")}</th><th className="text-start">{t("לידים", "Leads")}</th><th className="text-start">{t("נוצר קשר", "Contacted")}</th><th className="text-start">{t("שילמו", "Paid")}</th></tr></thead><tbody className="divide-y divide-line">{d.byResponseTime.map((x) => <tr key={x.bucket}><td className="py-1">{x.bucket}</td><td>{x.leads}</td><td>{x.contacted}</td><td>{x.paid}</td></tr>)}</tbody></table>}
              </div>
              <p className="text-[11px] text-muted">{t("לפני שמסיקים שמודעה חלשה – בדקו אם הלידים שלה טופלו: שיעור טיפול נמוך או זמן תגובה ארוך מצביעים על איכות הטיפול ולא על איכות המודעה.", "Before concluding an ad is weak, check that its leads were handled: a low handled rate or slow response points to handling quality, not ad quality.")}</p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
