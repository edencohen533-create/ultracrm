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
const KEY = ["answerRate", "leadCloseRate", "dealsWon", "revenue"];
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

  return (
    <div className="space-y-4 p-4 md:p-5" data-testid="reports-overview">
      {/* 1. Filters and dates */}
      <section className="rounded-xl border border-line bg-panel p-3" aria-label={t("סינון ותאריכים", "Filters and dates")}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Select label={t("תקופה", "Period")} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="rep-preset">
            <option value="today">{t("היום", "Today")}</option><option value="yesterday">{t("אתמול", "Yesterday")}</option><option value="last7">{t("7 הימים האחרונים", "Last 7 days")}</option>
            <option value="last30">{t("30 הימים האחרונים", "Last 30 days")}</option><option value="thisMonth">{t("החודש", "This month")}</option><option value="lastMonth">{t("החודש הקודם", "Last month")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option>
          </Select>
          <Select label={t("השוואה", "Compare with")} value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} data-testid="rep-compare">
            <option value="previous">{t("התקופה הקודמת (אותו אורך)", "Previous period (same length)")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option><option value="none">{t("ללא השוואה", "No comparison")}</option>
          </Select>
          <Select label={t("נציג", "Agent")} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="rep-agent"><option value="">{t("כל הנציגים", "All agents")}</option>{opts?.agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>
          <Select label={t("רשימת חיוג", "Dial list")} value={listId} onChange={(e) => setListId(e.target.value)} data-testid="rep-list"><option value="">{t("כל רשימות החיוג", "All dial lists")}</option>{opts?.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          {(opts?.products.length ?? 0) > 0 && <Select label={t("מוצר", "Product")} value={product} onChange={(e) => setProduct(e.target.value)} data-testid="rep-product"><option value="">{t("כל המוצרים", "All products")}</option>{opts!.products.map((p) => <option key={p} value={p}>{p}</option>)}</Select>}
        </div>
        {(preset === "custom" || compare === "custom") && (
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {preset === "custom" && <fieldset className="flex flex-wrap items-end gap-2"><legend className="text-xs text-muted">{t("תקופה", "Period")}</legend><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("מתאריך", "From")} value={custom[0]} max={opts?.today} onChange={(e) => setCustom([e.target.value, custom[1]])} data-testid="rep-from" /><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("עד תאריך", "To")} value={custom[1]} max={opts?.today} min={custom[0] || undefined} onChange={(e) => setCustom([custom[0], e.target.value])} data-testid="rep-to" /></fieldset>}
            {compare === "custom" && <fieldset className="flex flex-wrap items-end gap-2"><legend className="text-xs text-muted">{t("טווח להשוואה", "Comparison range")}</legend><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("השוואה מתאריך", "Compare from")} value={cmp[0]} max={opts?.today} onChange={(e) => setCmp([e.target.value, cmp[1]])} data-testid="rep-cfrom" /><input type="date" className="h-9 rounded-md border border-line bg-bg px-2" aria-label={t("השוואה עד תאריך", "Compare to")} value={cmp[1]} max={opts?.today} min={cmp[0] || undefined} onChange={(e) => setCmp([cmp[0], e.target.value])} data-testid="rep-cto" /></fieldset>}
          </div>
        )}
        {data && (
          <p className="mt-2 text-xs text-muted" data-testid="rep-periods">
            {t("תקופה:", "Period:")} <b>{range(data.periods.current)}</b>{data.periods.current.partial && t(` (עד עכשיו, ${time(data.periods.current.end)})`, ` (so far, ${time(data.periods.current.end)})`)}
            {data.periods.compare && <> · {t("מול:", "vs:")} <b>{range(data.periods.compare)}</b>{data.periods.compare.partial && data.periods.mode === "previous" && t(" (עד אותה שעה)", " (up to the same time)")}</>}
            {" · "}{t(`אזור זמן: ${data.timezone}`, `Time zone: ${data.timezone}`)}
            {data.periods.partialCompare && <span className="ms-2 rounded bg-warn/15 px-1.5 py-0.5 text-warn" data-testid="rep-partial">{t("השוואה חלקית – התקופה עוד לא הסתיימה", "Partial comparison – the period hasn't ended")}</span>}
            {data.periods.lengthMismatch && <span className="ms-2 rounded bg-warn/15 px-1.5 py-0.5 text-warn" data-testid="rep-mismatch">{t(`טווחים באורכים שונים (${data.periods.current.days} מול ${data.periods.compare!.days} ימים) – ספירות אינן ברות השוואה ישירה`, `Ranges of different length (${data.periods.current.days} vs ${data.periods.compare!.days} days) – counts aren't directly comparable`)}</span>}
          </p>
        )}
      </section>

      {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-2 text-sm">{error}</p>}
      {!data && !error && <div className="flex justify-center p-10"><Spinner /></div>}

      {data && (
        <>
          {/* 2. Key metrics */}
          <section aria-label={t("מדדים מרכזיים", "Key metrics")} className={cx("grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4", loading && "opacity-60")} data-testid="rep-kpis">
            {data.metrics.filter((m) => KEY.includes(m.id)).map((m) => <MetricCard key={m.id} m={m} big href={historyHref(m.id)} />)}
          </section>
          <section aria-label={t("מדדים נוספים", "More metrics")} className={cx("grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4", loading && "opacity-60")}>
            {data.metrics.filter((m) => !KEY.includes(m.id)).map((m) => <MetricCard key={m.id} m={m} href={historyHref(m.id)} />)}
          </section>

          {/* 3. Charts */}
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <Panel className="min-w-0" title={t("שיחות יוצאות לפי יום", "Outbound calls per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="outbound" /></Panel>
            <Panel className="min-w-0" title={t("עסקאות שנסגרו לפי יום", "Deals won per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="dealsWon" /></Panel>
          </div>

          {/* 4. Detail per agent (same period / agent) */}
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

function MetricCard({ m, big = false, href }: { m: Metric; big?: boolean; href?: string }) {
  const t = useT();
  const c = m.change;
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  const abs = (n: number) => Math.abs(n);
  let change: string;
  if (c.note === "no_compare") change = "";
  else if (c.note === "no_data") change = t("אין נתונים להשוואה", "No data to compare");
  else if (c.note === "both_zero") change = t("ללא שינוי (0 בשתי התקופות)", "No change (0 in both periods)");
  else if (m.kind === "rate") change = t(`${sign(c.points!)}${abs(c.points!).toFixed(1)} נק׳ אחוז`, `${sign(c.points!)}${abs(c.points!).toFixed(1)} pp`) + (c.note === "from_zero" ? t(" (מ-0%)", " (from 0%)") : c.relative !== null ? t(` · יחסי ${sign(c.relative)}${abs(c.relative).toFixed(1)}%`, ` · relative ${sign(c.relative)}${abs(c.relative).toFixed(1)}%`) : "");
  else if (c.note === "from_zero") change = t(`${sign(c.delta!)}${fmt(abs(c.delta!), m.kind, t.lang)} (לא היה בתקופה הקודמת)`, `${sign(c.delta!)}${fmt(abs(c.delta!), m.kind, t.lang)} (none in the previous period)`);
  else change = `${sign(c.delta!)}${fmt(abs(c.delta!), m.kind, t.lang)} (${sign(c.relative!)}${abs(c.relative!).toFixed(1)}%)`;
  const tone = c.trend === "better" ? "text-good" : c.trend === "worse" ? "text-bad" : "text-muted";
  const arrow = c.trend === "better" ? "▲" : c.trend === "worse" ? "▼" : c.trend === "neutral" ? "↕" : "";
  return (
    <article className="rounded-xl border border-line bg-panel p-3" data-testid={`rep-metric-${m.id}`}>
      <div className="flex items-center gap-1 text-xs text-muted">{t(m.label, m.en)}<HelpTip label={t(m.label, m.en)} testId={`rep-help-${m.id}`}>{t(m.definition, m.definitionEn)}{m.direction === "neutral" ? t(" שינוי במדד זה אינו מסומן כטוב או רע.", " A change here is not marked good or bad.") : ""}</HelpTip></div>
      <p className={cx("mt-1 font-bold tabular-nums", big ? "text-2xl" : "text-xl")} dir="ltr" style={{ textAlign: "start" }} data-testid="rep-value">{fmt(c.current, m.kind, t.lang)}</p>
      {c.note !== "no_compare" && <p className="text-xs text-muted" data-testid="rep-prev">{t("לעומת", "vs")} <span dir="ltr">{fmt(c.previous, m.kind, t.lang)}</span></p>}
      {href && <Link href={href} className="mt-1 inline-block text-xs text-accent underline" data-testid={`rep-open-${m.id}`}>{t("לשיחות בהיסטוריה ←", "Open in call history →")}</Link>}
      {change && <p className={cx("mt-1 text-xs font-medium", tone)} data-testid="rep-change"><span aria-hidden="true">{arrow} </span>{change}{c.trend === "better" ? <span className="sr-only">{t(" – שיפור", " – improvement")}</span> : c.trend === "worse" ? <span className="sr-only">{t(" – ירידה", " – decline")}</span> : null}</p>}
    </article>
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
