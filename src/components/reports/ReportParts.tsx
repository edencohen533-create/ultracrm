"use client";

import Link from "next/link";
import { cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { HelpTip } from "@/components/ai/HelpTip";
import type { Change, MetricKind } from "@/lib/reports/compare";

/** Shared pieces of the reports page and the agent detail: metric formatting, cards, groups and daily charts. */
export interface Metric { id: string; label: string; en: string; kind: MetricKind; direction: "up" | "down" | "neutral"; definition: string; definitionEn: string; change: Change }
export interface Day { day: string; outbound: number; answered: number; dealsWon: number; waInbound: number; waOutbound: number }
export type Periods = { current: string; compare: string | null };
/** Volume metrics: more isn't necessarily better, so their change is shown without good/bad colour. */
export const VOLUME = new Set(["outbound", "answered", "waInbound", "waOutbound"]);

export function fmt(v: number | null, kind: MetricKind, lang: string) {
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
export function MetricDetails({ m, periods }: { m: Metric; periods: { current: string; compare: string | null } }) {
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

export function ChangeLine({ m, hide, small = false }: { m: Metric; hide: boolean; small?: boolean }) {
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

export function MetricCard({ m, href, hideChange, periods }: { m: Metric; href?: string; hideChange: boolean; periods: { current: string; compare: string | null } }) {
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
export function MetricGroup({ title, metrics, href, hideChange, periods, testId, note, children, extraCount = 0, caption }: { title: string; metrics: Metric[]; href: (id: string) => string | undefined; hideChange: boolean; periods: { current: string; compare: string | null }; testId: string; note?: (m: Metric) => string | undefined; children?: React.ReactNode; extraCount?: number; caption?: React.ReactNode }) {
  const t = useT();
  const n = metrics.length + extraCount;
  const cols = n >= 6 ? "sm:grid-cols-3" : n === 5 ? "sm:grid-cols-5" : n === 4 ? "sm:grid-cols-4" : n === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3";
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
              {m.change.current === null && note?.(m) ? <p className="mt-0.5 text-[11px] leading-snug text-muted" data-testid="rep-na-note">{note(m)}</p> : <ChangeLine m={m} hide={hideChange} small />}
            </div>
          );
        })}
        {children}
      </div>
      {caption && <p className="border-t border-line px-3 py-1.5 text-[11px] text-muted">{caption}</p>}
    </section>
  );
}

/** Two series by day index (current vs comparison), readable on phones (scrolls inside its box when long). */
export function DailyBars({ cur, prev, field }: { cur: Day[]; prev: Day[] | null; field: Exclude<keyof Day, "day"> }) {
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

/** A non-metric cell in a MetricGroup (current state / not available), same look as the metric cells. */
export function GroupCell({ label, help, value, sub, testId }: { label: string; help?: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; testId: string }) {
  return (
    <div className="min-w-0 bg-panel px-3 py-2" data-testid={testId}>
      <div className="flex items-center gap-1 text-[11px] leading-tight text-muted"><span className="min-w-0">{label}</span>{help && <HelpTip label={label} hover>{help}</HelpTip>}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ textAlign: "start" }}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/** "x מתוך y" with a bar whose width is x / y (0 → empty bar, never full). */
export function Progress({ part, total, label }: { part: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0;
  return (
    <div className="mt-1" data-testid="rep-progress">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} data-testid="rep-progress-fill" /></div>
    </div>
  );
}
