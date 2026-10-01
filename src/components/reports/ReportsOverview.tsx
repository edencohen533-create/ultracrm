"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, qs } from "@/lib/client/api";
import { Panel, Select, Spinner, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { HelpTip } from "@/components/ai/HelpTip";
import { AgentPerformance, type ReportQuery } from "./AgentPerformance";
import { ChangeLine, DailyBars, GroupCell, MetricCard, MetricDetails, MetricGroup, Progress, fmt, type Day, type Metric } from "./ReportParts";
import { addDays } from "@/lib/reports/compare";

interface PeriodView { from: string; to: string; start: string; end: string; days: number; partial: boolean }
export type Channel = "all" | "telephony" | "whatsapp";
export interface Channels { telephony: boolean; whatsapp: boolean }
interface WaCounts { waConversations: number; waHandled: number }
interface Report {
  timezone: string; periods: { current: PeriodView; compare: PeriodView | null; mode: string; lengthMismatch: boolean; partialCompare: boolean };
  metrics: Metric[]; series: { current: Day[]; compare: Day[] | null }; channels: Channels;
  counts: { current: WaCounts | null; compare: WaCounts | null }; state: { waOpenNow: number | null };
}
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
/** Order = right to left in Hebrew. The four KPIs never change with the channel switch (sales aren't split by channel). */
const KEY = ["revenue", "dealsWon", "leadCloseRate", "newLeads"];
const CALLS = ["outbound", "answered", "answerRate", "talkSeconds", "avgTalkSeconds"];
const LEADS_TEL = ["notCalled", "responseMinutes"];
const WA = ["waInbound", "waOutbound", "waFirstResponse"];
/** Call metrics that open "חייגן → היסטוריית שיחות" with the same period / agent / list (the same rows they count). */
const CALL_METRIC: Record<string, "outbound" | "answered"> = { outbound: "outbound", answered: "answered", answerRate: "outbound", talkSeconds: "answered", avgTalkSeconds: "answered" };

/**
 * דוחות ← ביצועי נציגים: one filter row (period, agent, campaign, comparison) → 4 KPIs → activity by channel
 * on separate telephony / WhatsApp pages → daily charts → one agent table. Every number comes from the server (business
 * timezone, the same filters for both periods, the user's scope); a value the server can't compute is null, never 0.
 */
export function ReportsOverview({ channel = "telephony" }: { channel?: "telephony" | "whatsapp" }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [opts, setOpts] = useState<Filters | null>(null);
  const [preset, setPreset] = useState<Preset>("last7");
  const [custom, setCustom] = useState<[string, string]>(["", ""]);
  const [compare, setCompare] = useState<"previous" | "custom" | "none">("previous");
  const [cmp, setCmp] = useState<[string, string]>(["", ""]);
  const [userId, setUserId] = useState(""); const [listId, setListId] = useState(""); const [product, setProduct] = useState("");
  const [data, setData] = useState<Report | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const loadFilters = useCallback(() => { api.get<Filters>("/api/reports/filters").then((f) => { setOpts(f); setError(""); }).catch((e) => setError((e as Error).message)); }, []);
  useEffect(loadFilters, [loadFilters]);
  const [from, to] = useMemo(() => (!opts ? ["", ""] : preset === "custom" ? custom : presetRange(preset, opts.today)), [opts, preset, custom]);
  const ready = Boolean(from && to && from <= to && (compare !== "custom" || (cmp[0] && cmp[1] && cmp[0] <= cmp[1])));
  const query: ReportQuery | null = useMemo(() => (ready ? { from, to, compare, ...(compare === "custom" ? { compareFrom: cmp[0], compareTo: cmp[1] } : {}), userId, listId, product } : null), [ready, from, to, compare, cmp, userId, listId, product]);
  const load = useCallback(async () => {
    if (!query) return;
    const token = ++gen.current; setLoading(true);
    try {
      const r = await api.get<Report>(`/api/reports/comparison${qs({ ...query })}`);
      if (gen.current === token) { setData(r); setError(""); }
    } catch (e) { if (gen.current === token) setError((e as Error).message); }
    finally { if (gen.current === token) setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  const channels = { telephony: channel === "telephony" && data?.channels.telephony === true, whatsapp: channel === "whatsapp" && data?.channels.whatsapp === true };
  const showTel = channels.telephony;
  const showWa = channels.whatsapp;

  const d = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString(loc, { day: "numeric", month: "numeric", year: "2-digit", timeZone: "UTC" });
  const range = (p: PeriodView) => (p.from === p.to ? d(p.from) : `${d(p.from)} – ${d(p.to)}`);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", timeZone: data?.timezone });
  const historyHref = (id: string) => {
    const metric = CALL_METRIC[id];
    // A product filter has no equivalent in the call history – no link rather than a list that doesn't match the number.
    if (!metric || !data || product) return undefined;
    const p = new URLSearchParams({ from: data.periods.current.from, to: data.periods.current.to, metric });
    if (userId) p.set("userId", userId);
    if (listId) p.set("listId", listId);
    return `/calling/history?${p.toString()}`;
  };

  const [more, setMore] = useState(false);
  const listName = opts?.lists.find((l) => l.id === listId)?.name;
  const agentName = opts?.agents.find((a) => a.id === userId)?.fullName;
  const chips = [
    userId && { key: "agent", text: t(`נציג: ${agentName ?? "…"}`, `Agent: ${agentName ?? "…"}`), clear: () => setUserId("") },
    listId && { key: "list", text: t(`קמפיין: ${listName ?? "…"}`, `Campaign: ${listName ?? "…"}`), clear: () => setListId("") },
    product && { key: "product", text: t(`מוצר: ${product}`, `Product: ${product}`), clear: () => setProduct("") },
  ].filter(Boolean) as Array<{ key: string; text: string; clear: () => void }>;
  // One shared message instead of "no data" on every metric when the comparison period has nothing at all.
  const noCompareData = Boolean(data?.periods.compare && data.metrics.every((m) => m.change.previous === null || m.change.previous === 0));
  const byId = (id: string) => data?.metrics.find((m) => m.id === id);
  const group = (ids: string[]) => ids.map(byId).filter((m): m is Metric => Boolean(m));
  const periodsText = data ? { current: range(data.periods.current), compare: data.periods.compare ? range(data.periods.compare) : null } : null;
  /** Why a value is missing (instead of a bare dash). */
  const note = (m: Metric) => {
    if (m.id === "waInbound" && userId) return t("לא זמין בסינון לפי נציג – הודעה נכנסת שייכת להתכתבות, לא לנציג.", "N/A when filtering by agent – an inbound message belongs to a conversation, not an agent.");
    if (m.id === "waFirstResponse") return t("אין תשובות של נציגים בתקופה.", "No agent replies in the period.");
    if (m.id === "responseMinutes") return t("אין לידים חדשים שחויגו בתקופה.", "No new leads dialed in the period.");
    if (m.id === "answerRate") return t("אין שיחות יוצאות בתקופה.", "No outbound calls in the period.");
    if (m.id === "avgTalkSeconds") return t("אין שיחות שנענו בתקופה.", "No answered calls in the period.");
    if (m.id === "avgDeal") return t("אין עסקאות בשקלים בתקופה.", "No ILS deals in the period.");
    return undefined;
  };
  const handled = byId("waHandledRate"); const cnt = data?.counts.current;
  const avgDeal = group(["avgDeal"]);

  return (
    <div className="min-w-0 max-w-full space-y-4 p-4 md:p-5" data-testid="reports-overview">
      <h1 className="text-lg font-semibold">{channel === "whatsapp" ? t("ביצועי WhatsApp", "WhatsApp performance") : t("ביצועי נציגים – טלפוניה", "Agent performance – telephony")}</h1>
      {/* 1. One filter row for the whole page – period, agent, campaign, comparison; product under "more" */}
      <section className="rounded-xl border border-line bg-panel p-3" aria-label={t("סינון ותאריכים", "Filters and dates")}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[calc(50%-4px)] sm:w-44"><Select label={t("תקופה", "Period")} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="rep-preset">
            <option value="today">{t("היום", "Today")}</option><option value="yesterday">{t("אתמול", "Yesterday")}</option><option value="last7">{t("7 הימים האחרונים", "Last 7 days")}</option>
            <option value="last30">{t("30 הימים האחרונים", "Last 30 days")}</option><option value="thisMonth">{t("החודש", "This month")}</option><option value="lastMonth">{t("החודש הקודם", "Last month")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option>
          </Select></div>
          <div className="w-[calc(50%-4px)] sm:w-44"><Select label={t("נציג", "Agent")} value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="rep-agent"><option value="">{t("כל הנציגים", "All agents")}</option>{opts?.agents.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select></div>
          <div className="w-[calc(50%-4px)] sm:w-48"><Select label={t("קמפיין", "Campaign")} value={listId} onChange={(e) => setListId(e.target.value)} data-testid="rep-list" title={t("קמפיין חיוג (רשימה). מסנן לידים, עסקאות והתכתבויות לפי אנשי הקשר שברשימה, ושיחות לפי הרשימה שממנה חויגו.", "Dial campaign (list). Filters leads, deals and conversations by the list's contacts, and calls by the list they were dialed from.")}><option value="">{t("כל הקמפיינים", "All campaigns")}</option>{opts?.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>
          <div className="w-[calc(50%-4px)] sm:w-40"><Select label={t("השוואה", "Compare")} value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} data-testid="rep-compare" title={t("השוואה לתקופה אחרת", "Compare with another period")}>
            <option value="previous">{t("לתקופה הקודמת", "Previous period")}</option><option value="custom">{t("לטווח מותאם", "Custom range")}</option><option value="none">{t("ללא השוואה", "No comparison")}</option>
          </Select></div>
          {(opts?.products.length ?? 0) > 0 && <button type="button" className={cx("h-10 rounded-lg border border-line px-3 text-sm", (more || product) && "border-accent text-accent")} aria-expanded={more} aria-controls="rep-more" onClick={() => setMore((v) => !v)} data-testid="rep-more-toggle">
            {t("סינון נוסף", "More filters")}{product && <span className="ms-1 rounded-full bg-accent px-1.5 text-xs text-white">1</span>}
          </button>}
        </div>
        {more && (opts?.products.length ?? 0) > 0 && (
          <div id="rep-more" className="mt-2 flex flex-wrap gap-2 border-t border-line pt-2" data-testid="rep-more">
            <div className="w-full sm:w-52"><Select label={t("מוצר", "Product")} value={product} onChange={(e) => setProduct(e.target.value)} data-testid="rep-product"><option value="">{t("כל המוצרים", "All products")}</option>{opts!.products.map((p) => <option key={p} value={p}>{p}</option>)}</Select></div>
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

      {error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-bad/40 bg-bad/10 p-2 text-sm" data-testid="rep-error"><span className="flex-1">{data ? t("עדכון הנתונים נכשל – מוצגים הנתונים הקודמים. ", "Refresh failed – showing the previous data. ") : t("טעינת הדוח נכשלה. ", "The report failed to load. ")}{error}</span><button type="button" className="rounded-md border border-line px-2 py-0.5" onClick={() => (opts ? void load() : loadFilters())}>{t("נסה שוב", "Retry")}</button></div>}
      {!data && !error && <div className="flex justify-center p-10"><Spinner /></div>}

      {data && periodsText && (
        <>
          {noCompareData && <p className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" role="status" data-testid="rep-no-compare">{t("אין נתונים בתקופת ההשוואה – שינויים לא מוצגים.", "No data in the comparison period – changes aren't shown.")}</p>}
          {/* 2. One row per agent – first on the page; the same filters, activity columns by channel */}
          <div className="rounded-xl border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2 text-sm font-semibold">{t("פירוט לפי נציג", "Detail by agent")}</h2>
            {query && <AgentPerformance query={query} channel={channel} channels={channels} />}
          </div>
          {/* 3. Key metrics – the same in every channel view */}
          <section aria-label={t("מדדים מרכזיים", "Key metrics")} className={cx("grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4", loading && "opacity-60")} data-testid="rep-kpis">
            {group(KEY).map((m) => <MetricCard key={m.id} m={m} hideChange={noCompareData} periods={periodsText} />)}
          </section>

          <div className={cx("grid gap-3", showTel && showWa ? "lg:grid-cols-2" : "lg:grid-cols-[3fr_2fr]", loading && "opacity-60")}>
            {showTel && <MetricGroup title={t("שיחות טלפון", "Phone calls")} testId="rep-group-calls" metrics={group(CALLS)} href={historyHref} hideChange={noCompareData} periods={periodsText} note={note} />}
            {showWa && (
              <MetricGroup title={t("התכתבויות וואטסאפ", "WhatsApp conversations")} testId="rep-group-wa" metrics={[]} href={() => undefined} hideChange={noCompareData} periods={periodsText} note={note} extraCount={6}
                caption={t("התכתבות = שיחה עם לקוח (כמה הודעות). הודעה = הודעה בודדת. ״פתוחות כעת״ הוא מצב נוכחי; השאר – פעילות בתקופה.", "A conversation = a thread with a customer (many messages). A message = a single message. \"Open now\" is the current state; the rest is activity in the period.")}>
                <GroupCell testId="rep-wa-open" label={t("פתוחות כעת", "Open now")} value={data.state.waOpenNow === null ? "—" : <span dir="ltr">{data.state.waOpenNow.toLocaleString(loc)}</span>} sub={t("מצב נוכחי · לא לפי תקופה", "Current state · not by period")}
                  help={t("התכתבויות וואטסאפ בסטטוס פתוח / ממתין ברגע זה (בסינון לפי נציג – המשויכות אליו). לא מושווה לתקופה קודמת.", "WhatsApp conversations open / pending right now (per agent – assigned to them). Not compared with a previous period.")} />
                {handled && cnt && (
                  <GroupCell testId="rep-metric-waHandledRate" label={t(handled.label, handled.en)} help={<MetricDetails m={handled} periods={periodsText} />}
                    value={<span data-testid="rep-value">{t(`${cnt.waHandled} מתוך ${cnt.waConversations}`, `${cnt.waHandled} of ${cnt.waConversations}`)}</span>}
                    sub={<>{cnt.waConversations ? <span dir="ltr">{fmt(handled.change.current, "rate", t.lang)}</span> : t("אין התכתבויות נכנסות בתקופה", "No incoming conversations in the period")}<Progress part={cnt.waHandled} total={cnt.waConversations} label={t("התכתבויות שטופלו", "Conversations handled")} />{cnt.waConversations > 0 && <ChangeLine m={handled} hide={noCompareData} small />}</>} />
                )}
                {group(WA).map((m) => (
                  <GroupCell key={m.id} testId={`rep-metric-${m.id}`} label={t(m.label, m.en)} help={<MetricDetails m={m} periods={periodsText} />}
                    value={<span dir="ltr" data-testid="rep-value">{m.change.current === null && m.id === "waInbound" && userId ? t("לא זמין", "N/A") : fmt(m.change.current, m.kind, t.lang)}</span>}
                    sub={m.change.current === null ? note(m) : <ChangeLine m={m} hide={noCompareData} small />} />
                ))}
                <GroupCell testId="rep-wa-handling" label={t("זמן טיפול ממוצע", "Avg. handling time")} value={<span className="text-base text-muted">{t("לא זמין", "N/A")}</span>}
                  sub={t("אין זמן סגירה אמין להתכתבות", "No reliable conversation close time")} help={t("סגירת התכתבות לא נרשמת בכל המקרים (למשל ע״י אוטומציה), ולכן לא מחושב זמן טיפול – כדי לא להציג נתון שגוי.", "A conversation's close isn't recorded in every case (e.g. by an automation), so handling time isn't calculated – rather than show a wrong number.")} />
              </MetricGroup>
            )}
            {showTel && !showWa && <MetricGroup title={t("טיפול בלידים וערך עסקה", "Lead handling & deal value")} testId="rep-group-leads" metrics={group([...LEADS_TEL, "avgDeal"])} href={historyHref} hideChange={noCompareData} periods={periodsText} note={note} />}
            {showWa && !showTel && <MetricGroup title={t("ערך עסקה", "Deal value")} testId="rep-group-leads" metrics={avgDeal} href={() => undefined} hideChange={noCompareData} periods={periodsText} note={note} />}
          </div>
          {showTel && showWa && <MetricGroup title={t("טיפול בלידים וערך עסקה", "Lead handling & deal value")} testId="rep-group-leads" metrics={group([...LEADS_TEL, "avgDeal"])} href={historyHref} hideChange={noCompareData} periods={periodsText} note={note} />}
          {!channels.telephony && !channels.whatsapp && <p className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" data-testid="rep-no-channels">{t("אין לך ערוץ פעילות זמין (טלפוניה / וואטסאפ) – מוצגים לידים ועסקאות בלבד.", "No activity channel (telephony / WhatsApp) is available to you – only leads and deals are shown.")}</p>}

          {/* 4. Charts – one per subject, no duplicates */}
          <div className={cx("grid min-w-0 gap-3", showTel && showWa ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
            {showTel && <Panel className="min-w-0" title={t("שיחות יוצאות לפי יום", "Outbound calls per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="outbound" /></Panel>}
            {showWa && <Panel className="min-w-0" title={t("הודעות וואטסאפ של נציגים לפי יום", "Agents' WhatsApp messages per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="waOutbound" /></Panel>}
            <Panel className="min-w-0" title={t("עסקאות שנסגרו לפי יום", "Deals won per day")}><DailyBars cur={data.series.current} prev={data.series.compare} field="dealsWon" /></Panel>
          </div>

        </>
      )}
    </div>
  );
}
