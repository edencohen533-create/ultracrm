"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, qs } from "@/lib/client/api";
import { Panel, Select, Spinner, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { HelpTip } from "@/components/ai/HelpTip";
import { AgentPerformance } from "./AgentPerformance";
import { addDays } from "@/lib/reports/compare";
import type { Change, MetricKind } from "@/lib/reports/compare";

interface Metric { id: string; label: string; en: string; kind: MetricKind; direction: "up" | "down" | "neutral"; definition: string; definitionEn: string; change: Change }
interface PeriodView { from: string; to: string; start: string; end: string; days: number; partial: boolean }
interface Day { day: string; outbound: number; answered: number; dealsWon: number }
interface Report { timezone: string; periods: { current: PeriodView; compare: PeriodView | null; mode: string; lengthMismatch: boolean; partialCompare: boolean }; metrics: Metric[]; series: { current: Day[]; compare: Day[] | null } }
interface Filters { agents: Array<{ id: string; fullName: string }>; lists: Array<{ id: string; name: string }>; products: string[]; timezone: string; today: string }

type Preset = "today" | "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth" | "custom";
function presetRange(p: Preset, today: string): [string, string] {
  const monthStart = `${today.slice(0, 8)}01`;
  switch (p) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "last7": return [addDays(today, -6), today];
    case "last30": return [addDays(today, -29), today];
    case "thisMonth": return [monthStart, today];
    case "lastMonth": { const end = addDays(monthStart, -1); return [`${end.slice(0, 8)}01`, end]; }
    default: return [today, today];
  }
}
/** Order = right to left in Hebrew. */
const KEY = ["revenue", "dealsWon", "leadCloseRate", "newLeads"];
const CALLS = ["outbound", "answered", "answerRate", "talkSeconds", "avgTalkSeconds"];
const LEADS = ["notCalled", "responseMinutes", "avgDeal"];
/** Volume metrics: more calls isn't necessarily better, so their change is shown without good/bad colour. */
const VOLUME = new Set(["outbound", "answered"]);
/** Call metrics that open "חייגן → היסטוריית שיחות" with the same period / agent / list (the same rows they count). */
const CALL_METRIC: Record<string, "outbound" | "answered"> = { outbound: "outbound", answered: "answered", answerRate: "outbound", talkSeconds: "answered", avgTalkSeconds: "answered" };

/**
 * Reports page: filters & dates → key metrics (value, comparison value, change) → daily charts → per-agent detail.
 * Every number comes from the server (business timezone, same filters for both periods, the user's scope).
 */
export function ReportsOverview() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [opts, setOpts] = useState<Filters | null>(null);
  const [preset, setPreset] = useState<Preset>("last7");
  const [custom, setCustom] = useState<[string, string]>(["", ""]);
  const [compare, setCompare] = useState<"previous" | "custom" | "none">("previous");
  const [cmp, setCmp] = useState<[string, string]>(["", ""]);
  const [userId, setUserId] = useState(""); const [listId, setListId] = useState(""); const [product, setProduct] = useState("");
  const [data, setData] = useState<Report | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  useEffect(() => { api.get<Filters>("/api/reports/filters").then(setOpts).catch((e) => setError((e as Error).message)); }, []);
  const [from, to] = useMemo(() => (!opts ? ["", ""] : preset === "custom" ? custom : presetRange(preset, opts.today)), [opts, preset, custom]);
  const ready = Boolean(from && to && from <= to && (compare !== "custom" || (cmp[0] && cmp[1] && cmp[0] <= cmp[1])));
  const load = useCallback(async () => {
    if (!ready) return;
    const token = ++gen.current; setLoading(true);
    try {
      const r = await api.get<Report>(`/api/reports/comparison${qs({ from, to, compare, ...(compare === "custom" ? { compareFrom: cmp[0], compareTo: cmp[1] } : {}), userId, listId, product })}`);
      if (gen.current === token) { setData(r); setError(""); }
    } catch (e) { if (gen.current === token) setError((e as Error).message); }
    finally { if (gen.current === token) setLoading(false); }
  }, [ready, from, to, compare, cmp, userId, listId, product]);
  useEffect(() => { void load(); }, [load]);

  const d = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString(loc, { day: "numeric", month: "numeric", year: "2-digit", timeZone: "UTC" });
  const range = (p: PeriodView) => (p.from === p.to ? d(p.from) : `${d(p.from)} – ${d(p.to)}`);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", timeZone: data?.timezone });
  const curStart = data?.periods.current.start, curEnd = data?.periods.current.end;
  const historyHref = (id: string) => {
    const metric = CALL_METRIC[id];
    // A product filter has no equivalent in the call history – no link rather than a list that doesn't match the number.
    if (!metric || !data || product) return undefined;
    const p = new URLSearchParams({ from: data.periods.current.from, to: data.periods.current.to, metric });
    if (userId) p.set("userId", userId);
    if (listId) p.set("listId", listId);
    return `/calling/history?${p.toString()}`;
  };
  const detailRange = useMemo(() => (curStart && curEnd ? { from: curStart, to: curEnd, userId: userId || null } : undefined), [curStart, curEnd, userId]);

  const [more, setMore] = useState(false);
  const listName = opts?.lists.find((l) => l.id === listId)?.name;
  const agentName = opts?.agents.find((a) => a.id === userId)?.fullName;
  const chips = [
    userId && { key: "agent", text: t(`נציג: ${agentName ?? "…"}`, `Agent: ${agentName ?? "…"}`), clear: () => setUserId("") },
    listId && { key: "list", text: t(`רשימת חיוג: ${listName ?? "…"}`, `Dial list: ${listName ?? "…"}`), clear: () => setListId("") },
    product && { key: "product", text: t(`מוצר: ${product}`, `Product: ${product}`), clear: () => setProduct("") },
  ].filter(Boolean) as Array<{ key: string; text: string; clear: () => void }>;
  const extraActive = Number(Boolean(listId)) + Number(Boolean(product));
  // One shared message instead of "no data" on every metric when the comparison period has nothing at all.
  const noCompareData = Boolean(data?.periods.compare && data.metrics.every((m) => m.change.previous === null || m.change.previous === 0));
  const byId = (id: string) => data?.metrics.find((m) => m.id === id);
  const group = (ids: string[]) => ids.map(byId).filter((m): m is Metric => Boolean(m));
  const periodsText = data ? { current: range(data.periods.current), compare: data.periods.compare ? range(data.periods.compare) : null } : null;

  return (
    <div className="space-y-4 p-4 md:p-5" data-testid="reports-overview">
      {/* 1. Filters and dates – period, agent and comparison always visible; the rest under "more filters" */}
      <section className="rounded-xl border border-line bg-panel p-3" aria-label={t("סינון ותאריכים", "Filters and dates")}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[calc(50%-4px)] sm:w-44"><Select label={t("תקופה", "Period")} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="rep-preset">
            <option value="today">{t("היום", "Today")}</option><option value="yesterday">{t("אתמול", "Yesterday")}</option><option value="last7">{t("7 הימים האחרונים", "Last 7 days")}</option>
            <option value="last30">{t("30 הימים האחרונים", "Last 30 days")}</option><option value="thisMonth">{t("החודש", "This month")}</option><option value="lastMonth">{t("החודש הקודם", "Last month")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option>
          </Select></div>
          <div className="w-[calc(50%-4px)] sm:w-44"><Select label={t("נציג", "Agent")} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="rep-agent"><option value="">{t("כל הנציגים", "All agents")}</option>{opts?.agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select></div>
          <div className="w-[calc(50%-4px)] sm:w-40"><Select label={t("השוואה", "Compare")} value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} data-testid="rep-compare" title={t("השוואה לתקופה אחרת", "Compare with another period")}>
            <option value="previous">{t("לתקופה הקודמת", "Previous period")}</option><option value="custom">{t("לטווח מותאם", "Custom range")}</option><option value="none">{t("ללא השוואה", "No comparison")}</option>
          </Select></div>
          <button type="button" className={cx("h-10 rounded-lg border border-line px-3 text-sm", (more || extraActive > 0) && "border-accent text-accent")} aria-expanded={more} aria-controls="rep-more" onClick={() => setMore((v) => !v)} data-testid="rep-more-toggle">
            {t("סינון נוסף", "More filters")}{extraActive > 0 && <span className="ms-1 rounded-full bg-accent px-1.5 text-xs text-white">{extraActive}</span>}
          </button>
        </div>
        {more && (
          <div id="rep-more" className="mt-2 flex flex-wrap gap-2 border-t border-line pt-2" data-testid="rep-more">
            <div className="w-full sm:w-52"><Select label={t("רשימת חיוג", "Dial list")} value={listId} onChange={(e) => setListId(e.target.value)} data-testid="rep-list"><option value="">{t("כל רשימות החיוג", "All dial lists")}</option>{opts?.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>
            {(opts?.products.length ?? 0) > 0 ? <div className="w-full sm:w-52"><Select label={t("מוצר", "Product")} value={product} onChange={(e) => setProduct(e.target.value)} data-testid="rep-product"><option value="">{t("כל המוצרים", "All products")}</option>{opts!.products.map((p) => <option key={p} value={p}>{p}</option>)}</Select></div> : <p className="self-end pb-2 text-xs text-muted">{t("אין מוצרים לסינון.", "No products to filter by.")}</p>}
          </div>
        )}
        {chips.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("סינונים פעילים", "Active filters")} data-testid="rep-chips">
            {chips.map((c) => <li key={c.key} className="inline-flex items-center gap-1 rounded-full border border-line bg-bg py-0.5 pe-1 ps-2.5 text-xs">{c.text}<button type="button" onClick={c.clear} className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-text" aria-label={t(`הסרת סינון: ${c.text}`, `Remove filter: ${c.text}`)} data-testid={`rep-chip-${c.key}`}>×</button></li>)}
          </ul>
        )}
        {(preset === "custom" || compare === "custom") && (
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {preset === "custom" && <fieldset className="flex flex-wrap items-end gap-2"><legend className="text-xs text-muted">{t("תקופה", "Period")}</legend><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("מתאריך", "From")} value={custom[0]} max={opts?.today} onChange={(e) => setCustom([e.target.value, custom[1]])} data-testid="rep-from" /><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("עד תאריך", "To")} value={custom[1]} max={opts?.today} min={custom[0] || undefined} onChange={(e) => setCustom([custom[0], e.target.value])} data-testid="rep-to" /></fieldset>}
            {compare === "custom" && <fieldset className="flex flex-wrap items-end gap-2"><legend className="text-xs text-muted">{t("טווח להשוואה", "Comparison range")}</legend><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("השוואה מתאריך", "Compare from")} value={cmp[0]} max={opts?.today} onChange={(e) => setCmp([e.target.value, cmp[1]])} data-testid="rep-cfrom" /><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("השוואה עד תאריך", "Compare to")} value={cmp[1]} max={opts?.today} min={cmp[0] || undefined} onChange={(e) => setCmp([cmp[0], e.target.value])} data-testid="rep-cto" /></fieldset>}
          </div>
        )}
        {data && periodsText && (
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" data-testid="rep-periods">
            <span><b className="text-text">{periodsText.current}</b>{periodsText.compare && <> {t("מול", "vs")} <b className="text-text">{periodsText.compare}</b></>}</span>
            {data.periods.current.partial && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-warn" data-testid="rep-partial">{t(`תקופה חלקית – עד ${time(data.periods.current.end)}`, `Partial period – up to ${time(data.periods.current.end)}`)}</span>}
            {data.periods.lengthMismatch && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-warn" data-testid="rep-mismatch">{t(`טווחים באורכים שונים (${data.periods.current.days} מול ${data.periods.compare!.days} ימים)`, `Different lengths (${data.periods.current.days} vs ${data.periods.compare!.days} days)`)}</span>}
            <HelpTip label={t("טווח התאריכים", "Date range")} testId="rep-periods-help" hover>
              {t(`אזור זמן: ${data.timezone}. הימים נספרים לפי שעון העסק.`, `Time zone: ${data.timezone}. Days follow the business's clock.`)}
              {data.periods.current.partial && <><br />{t(`התקופה עוד לא הסתיימה – הנתונים עד ${time(data.periods.current.end)}.`, `The period hasn't ended – data up to ${time(data.periods.current.end)}.`)}{data.periods.compare?.partial && data.periods.mode === "previous" && t(" תקופת ההשוואה נספרת עד אותה שעה, כדי להשוות באופן שווה.", " The comparison period is counted up to the same hour, like for like.")}</>}
              {data.periods.lengthMismatch && <><br />{t("הטווחים באורכים שונים – ספירות אינן ברות השוואה ישירה.", "The ranges differ in length – counts aren't directly comparable.")}</>}
            </HelpTip>
          </p>
        )}
      </section>

      {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-2 text-sm">{error}</p>}
      {!data && !error && <div className="flex justify-center p-10"><Spinner /></div>}

      {data && (
        <>
          {noCompareData && <p className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" role="status" data-testid="rep-no-compare">{t("אין נתונים בתקופת ההשוואה – שינויים לא מוצגים.", "No data in the comparison period – changes aren't shown.")}</p>}
          {/* 2. Key metrics – four compact cards */}
          <section aria-label={t("מדדים מרכזיים", "Key metrics")} className={cx("grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4", loading && "opacity-60")} data-testid="rep-kpis">
            {group(KEY).map((m) => <MetricCard key={m.id} m={m} href={historyHref(m.id)} hideChange={noCompareData} periods={periodsText!} />)}
          </section>
          {/* 3. Secondary metrics – two compact groups, no card per number */}
          <div className={cx("grid gap-3 lg:grid-cols-[3fr_2fr]", loading && "opacity-60")}>
            <MetricGroup title={t("פעילות שיחות", "Call activity")} testId="rep-group-calls" metrics={group(CALLS)} href={historyHref} hideChange={noCompareData} periods={periodsText!} />
            <MetricGroup title={t("טיפול בלידים וערך עסקה", "Lead handling & deal value")} testId="rep-group-leads" metrics={group(LEADS)} href={historyHref} hideChange={noCompareData} periods={periodsText!} />
          </div>

          {/* 4. Charts */}
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <Panel className="min-w-0" title={t("שיחות יוצאות לפי יום", "Outbound calls per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="outbound" /></Panel>
            <Panel className="min-w-0" title={t("עסקאות שנסגרו לפי יום", "Deals won per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="dealsWon" /></Panel>
          </div>

          {/* 5. Detail per agent (same period / agent) */}
          <div className="rounded-xl border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2 text-sm font-semibold">{t("פירוט לפי נציג", "Detail by agent")}{listId || product ? <span className="ms-2 text-xs font-normal text-muted">{t("(הטבלה מסוננת לפי תקופה ונציג בלבד)", "(the table is filtered by period and agent only)")}</span> : null}</h2>
            <AgentPerformance range={detailRange} />
          </div>
        </>
      )}
    </div>
  );
}

function fmt(v: number | null, kind: MetricKind, lang: string) {
  if (v === null) return "—";
  const loc = lang === "en" ? "en-GB" : "he-IL";
  if (kind === "rate") return `${(v * 100).toFixed(1)}%`;
  if (kind === "money") return `₪${v.toLocaleString(loc, { maximumFractionDigits: 0 })}`;
  if (kind === "duration") { const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = Math.round(v % 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; }
  if (kind === "minutes") return v < 60 ? (lang === "en" ? `${v.toFixed(0)} min` : `${v.toFixed(0)} דק׳`) : v < 1440 ? (lang === "en" ? `${(v / 60).toFixed(1)} h` : `${(v / 60).toFixed(1)} שע׳`) : (lang === "en" ? `${(v / 1440).toFixed(1)} days` : `${(v / 1440).toFixed(1)} ימים`);
  return v.toLocaleString(loc);
}

type T = ReturnType<typeof useT>;
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");

/** The short comparison line (or null) and its colour. Rates change in percentage points; from a zero base → absolute. */
function shortChange(m: Metric, t: T): { text: string; suffix?: string; tone: string; arrow: string; sr: string } | null {
  const c = m.change;
  if (c.note === "no_compare") return null;
  if (c.note === "no_data") return { text: t("אין בסיס להשוואה", "No basis to compare"), tone: "text-muted", arrow: "", sr: "" };
  if (c.note === "both_zero" || c.trend === "same") return { text: t("ללא שינוי", "No change"), tone: "text-muted", arrow: "", sr: "" };
  const up = (c.delta ?? 0) > 0;
  // The number is shown left-to-right, the words around it follow the page direction.
  let text: string; let suffix: string | undefined;
  if (m.kind === "rate") { text = `${sign(c.points!)}${Math.abs(c.points!).toFixed(1)}`; suffix = t("נק׳ אחוז", "pp"); }
  else if (c.note === "from_zero") { text = `${sign(c.delta!)}${fmt(Math.abs(c.delta!), m.kind, t.lang)}`; suffix = t("(מ-0)", "(from 0)"); }
  else text = `${sign(c.relative!)}${Math.abs(c.relative!).toFixed(1)}%`;
  const judged = !VOLUME.has(m.id) && (c.trend === "better" || c.trend === "worse");
  return { text, suffix, tone: judged ? (c.trend === "better" ? "text-good" : "text-bad") : "text-muted", arrow: up ? "↑" : "↓", sr: judged ? (c.trend === "better" ? t(" – שיפור", " – improvement") : t(" – הרעה", " – decline")) : "" };
}

/** Full definition + calculation, in the metric's explanation (click, hover, keyboard focus). */
function MetricDetails({ m, periods }: { m: Metric; periods: { current: string; compare: string | null } }) {
  const t = useT(); const c = m.change; const f = (v: number | null) => fmt(v, m.kind, t.lang);
  return (
    <>
      <span className="block">{t(m.definition, m.definitionEn)}</span>
      {c.note !== "no_compare" && (
        <span className="mt-2 block border-t border-line pt-2" dir="auto">
          <span className="block">{periods.current}: <b dir="ltr">{f(c.current)}</b></span>
          <span className="block">{periods.compare}: <b dir="ltr">{f(c.previous)}</b></span>
          {c.note === "no_data" ? <span className="block">{t("לא ניתן לחשב את המדד באחת התקופות (למשל אין בסיס לחישוב האחוז) – לכן אין השוואה.", "The metric can't be calculated for one of the periods (e.g. no base for the rate) – so there's no comparison.")}</span>
            : c.note === "both_zero" ? <span className="block">{t("0 בשתי התקופות.", "0 in both periods.")}</span>
            : <>
                <span className="block">{m.kind === "rate" ? t(`שינוי: ${sign(c.points!)}${Math.abs(c.points!).toFixed(1)} נקודות אחוז`, `Change: ${sign(c.points!)}${Math.abs(c.points!).toFixed(1)} percentage points`) : t(`שינוי מוחלט: ${sign(c.delta!)}${f(Math.abs(c.delta!))}`, `Absolute change: ${sign(c.delta!)}${f(Math.abs(c.delta!))}`)}</span>
                <span className="block">{c.relative !== null ? t(`שינוי יחסי: ${sign(c.relative)}${Math.abs(c.relative).toFixed(1)}%`, `Relative change: ${sign(c.relative)}${Math.abs(c.relative).toFixed(1)}%`) : t("שינוי יחסי לא מחושב – הערך הקודם הוא 0.", "Relative change not calculated – the previous value is 0.")}</span>
              </>}
        </span>
      )}
      {(m.direction === "neutral" || VOLUME.has(m.id)) && <span className="mt-1 block text-muted">{t("שינוי במדד זה אינו מסומן כטוב או רע.", "A change here is not marked good or bad.")}</span>}
    </>
  );
}

function ChangeLine({ m, hide, small = false }: { m: Metric; hide: boolean; small?: boolean }) {
  const t = useT();
  const ch = hide ? null : shortChange(m, t);
  if (!ch) return null;
  return (
    <p className={cx("mt-0.5 flex flex-wrap items-baseline gap-x-1.5", small ? "text-[11px]" : "text-xs")}>
      <span className={cx("font-medium", ch.tone)} data-testid="rep-change"><span aria-hidden="true">{ch.arrow}</span>{ch.arrow && " "}<span dir="ltr">{ch.text}</span>{ch.suffix && ` ${ch.suffix}`}{ch.sr && <span className="sr-only">{ch.sr}</span>}</span>
      {m.change.note !== "no_data" && <span className="text-muted" data-testid="rep-prev">{t("לעומת", "vs")} <span dir="ltr">{fmt(m.change.previous, m.kind, t.lang)}</span></span>}
    </p>
  );
}

function MetricCard({ m, href, hideChange, periods }: { m: Metric; href?: string; hideChange: boolean; periods: { current: string; compare: string | null } }) {
  const t = useT();
  return (
    <article className="min-w-0 rounded-xl border border-line bg-panel px-3 py-2.5" data-testid={`rep-metric-${m.id}`}>
      <div className="flex items-center gap-1 text-xs text-muted"><span className="min-w-0">{t(m.label, m.en)}</span><HelpTip label={t(m.label, m.en)} testId={`rep-help-${m.id}`} hover><MetricDetails m={m} periods={periods} /></HelpTip></div>
      <p className="mt-0.5 text-2xl font-bold tabular-nums" dir="ltr" style={{ textAlign: "start" }} data-testid="rep-value">{fmt(m.change.current, m.kind, t.lang)}</p>
      <ChangeLine m={m} hide={hideChange} />
      {href && <Link href={href} className="mt-1 inline-block text-xs text-accent underline" data-testid={`rep-open-${m.id}`}>{t("לשיחות בהיסטוריה ←", "Open in call history →")}</Link>}
    </article>
  );
}

/** Several metrics in one compact box, separated by hairlines (no card per number). */
function MetricGroup({ title, metrics, href, hideChange, periods, testId }: { title: string; metrics: Metric[]; href: (id: string) => string | undefined; hideChange: boolean; periods: { current: string; compare: string | null }; testId: string }) {
  const t = useT();
  const cols = metrics.length >= 5 ? "sm:grid-cols-5" : metrics.length === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3";
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-line bg-panel" aria-label={title} data-testid={testId}>
      <h2 className="border-b border-line px-3 py-1.5 text-xs font-semibold">{title}</h2>
      <div className={cx("grid grid-cols-2 gap-px bg-line [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1", cols)}>
        {metrics.map((m) => {
          const link = href(m.id);
          return (
            <div key={m.id} className="min-w-0 bg-panel px-3 py-2" data-testid={`rep-metric-${m.id}`}>
              <div className="flex items-center gap-1 text-[11px] leading-tight text-muted"><span className="min-w-0">{t(m.label, m.en)}</span><HelpTip label={t(m.label, m.en)} testId={`rep-help-${m.id}`} hover><MetricDetails m={m} periods={periods} /></HelpTip></div>
              <p className="mt-0.5 text-lg font-semibold tabular-nums" dir="ltr" style={{ textAlign: "start" }} data-testid="rep-value">
                {link ? <Link href={link} className="hover:underline" title={t("לשיחות בהיסטוריה", "Open in call history")} data-testid={`rep-open-${m.id}`}>{fmt(m.change.current, m.kind, t.lang)}</Link> : fmt(m.change.current, m.kind, t.lang)}
              </p>
              <ChangeLine m={m} hide={hideChange} small />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Two series by day index (current vs comparison), readable on phones (scrolls inside its box when long). */
function DailyBars({ cur, prev, field }: { cur: Day[]; prev: Day[] | null; field: "outbound" | "dealsWon" }) {
  const t = useT();
  const n = Math.max(cur.length, prev?.length ?? 0);
  const max = Math.max(1, ...cur.map((x) => x[field]), ...(prev ?? []).map((x) => x[field]));
  const total = (s: Day[] | null) => (s ?? []).reduce((a, x) => a + x[field], 0);
  if (!cur.length || (total(cur) === 0 && total(prev) === 0)) return <p className="py-6 text-center text-sm text-muted" data-testid="rep-chart-empty">{t("אין נתונים בתקופה – לא מוצג גרף", "No data in the period – no chart")}</p>;
  const bw = 14, gap = 10, h = 120, w = n * (bw * 2 + gap);
  return (
    <div>
      <div className="overflow-x-auto" data-testid={`rep-chart-${field}`}>
        <svg viewBox={`0 0 ${w} ${h + 18}`} width={Math.max(w, 280)} height={h + 18} role="img" aria-label={t(`${cur.length} ימים, סה״כ ${total(cur)} מול ${total(prev)}`, `${cur.length} days, total ${total(cur)} vs ${total(prev)}`)} style={{ direction: "ltr" }}>
          {Array.from({ length: n }).map((_, i) => {
            const x = i * (bw * 2 + gap); const c = cur[i]?.[field] ?? 0; const p = prev?.[i]?.[field] ?? 0;
            return (
              <g key={i}>
                {prev && <rect x={x} y={h - (p / max) * h} width={bw} height={(p / max) * h} style={{ fill: "var(--line)" }}><title>{`${prev[i]?.day ?? ""}: ${p}`}</title></rect>}
                <rect x={x + (prev ? bw : bw / 2)} y={h - (c / max) * h} width={bw} height={(c / max) * h} style={{ fill: "var(--accent)" }}><title>{`${cur[i]?.day ?? ""}: ${c}`}</title></rect>
                {cur[i] && (n <= 16 || i % Math.ceil(n / 10) === 0) && <text x={x + bw} y={h + 13} fontSize="9" textAnchor="middle" style={{ fill: "var(--muted)" }}>{cur[i].day.slice(8)}/{cur[i].day.slice(5, 7)}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-1 flex flex-wrap gap-3 text-xs text-muted"><span><span className="inline-block h-2 w-3 rounded-sm align-middle" style={{ background: "var(--accent)" }} /> {t("התקופה", "Period")}: {total(cur)}</span>{prev && <span><span className="inline-block h-2 w-3 rounded-sm align-middle" style={{ background: "var(--line)" }} /> {t("השוואה", "Comparison")}: {total(prev)}</span>}</p>
    </div>
  );
}
