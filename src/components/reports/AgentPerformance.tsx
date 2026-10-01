"use client";

import { ExpertInbox } from "@/components/sales/ExpertAssistance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Download, X } from "lucide-react";
import { AgentCallDrawer, LIVE_LABEL, LIVE_LABEL_EN, type LiveAgent } from "./AgentCallDrawer";
import { useT } from "@/components/i18n/LangProvider";
import { api, qs } from "@/lib/client/api";
import { Panel, Spinner, cx } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";
import { DailyBars, MetricGroup, type Day, type Metric } from "./ReportParts";

export interface ReportQuery { from: string; to: string; compare: "previous" | "custom" | "none"; compareFrom?: string; compareTo?: string; userId: string; listId: string; product: string }
type Channel = "all" | "telephony" | "whatsapp";
interface Quality { responseMinutes: number | null; notCalled: number; newLeads: number; newWon: number; transferred: number; transferredWon: number; allLeads: number; allWon: number; avgDealValue: number | null; wonDeals: number; revenue: number; ilsDeals: number }
interface Wa { outbound: number; conversations: number; handled: number; firstResponse: number | null; openNow: number }
interface Agent {
  id: string; fullName: string; presence: string; presenceAt: string | null;
  outbound: number | null; answered: number | null; handled: number | null; manual: number | null; dialSeconds: number | null; talkSeconds: number | null; avgTalkSeconds: number | null;
  closed: number; revenue: number; newLeads: number; newWon: number; wa: Wa | null; quality: Quality;
}
interface Report { rows: Agent[]; channels: { telephony: boolean; whatsapp: boolean }; agents: { id: string; fullName: string }[]; from: string; to: string; timezone: string }
type TFn = ReturnType<typeof useT>;

const UNASSIGNED = "__unassigned";
const duration = (s: number | null) => s === null ? "—" : [Math.floor(s / 3600), Math.floor(s % 3600 / 60), Math.floor(s % 60)].map(v => String(v).padStart(2, "0")).join(":");
const shortDur = (s: number | null) => s === null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : "—";
const conv = (won: number, total: number) => total ? `${Math.round(won / total * 100)}% (${won}/${total})` : "—";
const mins = (m: number | null, t: TFn) => m === null ? "—" : m < 60 ? t(`${Math.round(m)} דק׳`, `${Math.round(m)} min`) : m < 1440 ? t(`${(m / 60).toFixed(1)} שע׳`, `${(m / 60).toFixed(1)} h`) : t(`${(m / 1440).toFixed(1)} ימים`, `${(m / 1440).toFixed(1)} days`);
const sum = (rows: Agent[], pick: (r: Agent) => number | null | undefined) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);

interface Col {
  key: string; group: "base" | "telephony" | "whatsapp" | "leads"; label: string; hint: string;
  value: (r: Agent) => number | null; cell: (r: Agent) => string; total?: (rows: Agent[]) => string;
}
/** Every per-agent figure. Totals are sums or ratios of sums (never an average of averages; a median isn't totalled). */
function columns(t: TFn, loc: string): Col[] {
  const n = (v: number | null) => v === null ? "—" : v.toLocaleString(loc);
  const money = (v: number | null) => v === null ? "—" : `₪${Math.round(v).toLocaleString(loc)}`;
  const tel = (f: (r: Agent) => number | null) => (r: Agent) => r.outbound === null ? null : f(r);
  const wa = (f: (w: Wa) => number | null) => (r: Agent) => r.wa ? f(r.wa) : null;
  return [
    // Base – outcomes, the same in every channel view
    { key: "newLeads", group: "base", label: t("לידים חדשים", "New leads"), hint: t("לידים שנוצרו בתקופה ושייכים לנציג (כולל לידים שהועברו אליו).", "Leads created in the period owned by the agent (incl. leads transferred to them)."), value: (r) => r.newLeads, cell: (r) => n(r.newLeads), total: (rs) => n(sum(rs, (r) => r.newLeads)) },
    { key: "closed", group: "base", label: t("עסקאות", "Deals"), hint: t("עסקאות שנסגרו בזכייה בתקופה, לפי הנציג האחראי על העסקה.", "Deals won in the period, by the deal's owner."), value: (r) => r.closed, cell: (r) => n(r.closed), total: (rs) => n(sum(rs, (r) => r.closed)) },
    { key: "closeRate", group: "base", label: t("אחוז סגירה", "Close rate"), hint: t("לידים חדשים מהתקופה שהומרו לעסקה, מתוך הלידים החדשים (עסקאות של לידים ישנים לא נספרות כאן).", "New leads of the period converted to a deal, out of new leads (deals of older leads aren't counted here)."), value: (r) => r.newLeads ? r.newWon / r.newLeads : null, cell: (r) => pct(r.newWon, r.newLeads), total: (rs) => pct(sum(rs, (r) => r.newWon), sum(rs, (r) => r.newLeads)) },
    { key: "revenue", group: "base", label: t("הכנסות", "Revenue"), hint: t("סכום העסקאות שנסגרו בתקופה, בשקלים (עסקאות במטבע אחר לא נכללות).", "Sum of deals won in the period, in ILS (other currencies excluded)."), value: (r) => r.revenue, cell: (r) => money(r.revenue), total: (rs) => money(sum(rs, (r) => r.revenue)) },
    // Telephony
    { key: "outbound", group: "telephony", label: t("שיחות יוצאות", "Outbound calls"), hint: t("ניסיונות חיוג יוצאים שנוצרו אצל ספק הטלפוניה.", "Outbound dial attempts created at the telephony provider."), value: (r) => r.outbound, cell: (r) => n(r.outbound), total: (rs) => n(sum(rs, (r) => r.outbound)) },
    { key: "answered", group: "telephony", label: t("נענו", "Answered"), hint: t("שיחות יוצאות שהספק אישר שנענו.", "Outbound calls the provider confirmed as answered."), value: (r) => r.answered, cell: (r) => n(r.answered), total: (rs) => n(sum(rs, (r) => r.answered)) },
    { key: "answerRate", group: "telephony", label: t("אחוז מענה", "Answer rate"), hint: t("שיחות שנענו מתוך השיחות היוצאות.", "Answered out of outbound calls."), value: tel((r) => r.outbound ? (r.answered ?? 0) / r.outbound : null), cell: (r) => r.outbound === null ? "—" : pct(r.answered ?? 0, r.outbound), total: (rs) => pct(sum(rs, (r) => r.answered), sum(rs, (r) => r.outbound)) },
    { key: "talkSeconds", group: "telephony", label: t("זמן שיחה כולל", "Total talk time"), hint: t("סך זמן השיחה בשיחות יוצאות שנענו.", "Total talk time on answered outbound calls."), value: (r) => r.talkSeconds, cell: (r) => duration(r.talkSeconds), total: (rs) => duration(sum(rs, (r) => r.talkSeconds)) },
    { key: "avgTalk", group: "telephony", label: t("משך שיחה ממוצע", "Avg. call length"), hint: t("זמן שיחה כולל חלקי השיחות שנענו.", "Total talk time divided by answered calls."), value: (r) => r.avgTalkSeconds, cell: (r) => shortDur(r.avgTalkSeconds), total: (rs) => { const a = sum(rs, (r) => r.answered); return shortDur(a ? Math.round(sum(rs, (r) => r.talkSeconds) / a) : null); } },
    { key: "handled", group: "telephony", label: t("שיחות שתועדו", "Calls with outcome"), hint: t("שיחות שנענו ונשמרה להן תוצאת שיחה.", "Answered calls with a saved call outcome."), value: (r) => r.handled, cell: (r) => n(r.handled), total: (rs) => n(sum(rs, (r) => r.handled)) },
    { key: "dialSeconds", group: "telephony", label: t("זמן בחיוג", "Dial time"), hint: t("זמן המתנה למענה בחיוגים יוצאים.", "Time waiting for an answer on outbound dials."), value: (r) => r.dialSeconds, cell: (r) => duration(r.dialSeconds), total: (rs) => duration(sum(rs, (r) => r.dialSeconds)) },
    { key: "manual", group: "telephony", label: t("חיוג ידני", "Manual dials"), hint: t("שיחות יוצאות שהנציג חייג ידנית (לא מהחייגן האוטומטי).", "Outbound calls the agent dialed manually (not the auto-dialer)."), value: (r) => r.manual, cell: (r) => n(r.manual), total: (rs) => n(sum(rs, (r) => r.manual)) },
    // Lead handling (dial based) and deal value
    { key: "notCalled", group: "leads", label: t("לידים שלא חויגו", "Leads not dialed"), hint: t("לידים חדשים מהתקופה (לא כולל שהועברו) שעדיין לא היה להם ניסיון חיוג.", "New leads of the period (not transferred) with no dial attempt yet."), value: (r) => r.outbound === null ? null : r.quality.notCalled, cell: (r) => r.outbound === null ? "—" : n(r.quality.notCalled), total: (rs) => n(sum(rs, (r) => r.quality.notCalled)) },
    { key: "response", group: "leads", label: t("זמן לחיוג ראשון", "Time to first dial"), hint: t("חציון הזמן מיצירת ליד חדש ועד ניסיון החיוג הראשון בפועל. בשורת הסה״כ לא מחושב – חציון אינו מצטבר.", "Median time from a new lead to its first actual dial. Not totalled – a median doesn't add up."), value: (r) => r.quality.responseMinutes, cell: (r) => mins(r.quality.responseMinutes, t) },
    { key: "avgDeal", group: "leads", label: t("עסקה ממוצעת", "Average deal"), hint: t("הכנסות בשקלים חלקי מספר העסקאות בשקלים.", "ILS revenue divided by ILS deals."), value: (r) => r.quality.avgDealValue, cell: (r) => money(r.quality.avgDealValue), total: (rs) => { const c = sum(rs, (r) => r.quality.ilsDeals); return money(c ? sum(rs, (r) => r.quality.revenue) / c : null); } },
    { key: "newConv", group: "leads", label: t("המרה מליד חדש (לא הועבר)", "New (not transferred) lead conversion"), hint: t("לידים שנוצרו אצל הנציג ולא הועברו אליו, שהומרו לעסקה.", "Leads created with the agent (not transferred to them) that converted."), value: (r) => r.quality.newLeads ? r.quality.newWon / r.quality.newLeads : null, cell: (r) => conv(r.quality.newWon, r.quality.newLeads), total: (rs) => conv(sum(rs, (r) => r.quality.newWon), sum(rs, (r) => r.quality.newLeads)) },
    { key: "transferConv", group: "leads", label: t("המרה מליד שהועבר", "Transferred lead conversion"), hint: t("לידים שהועברו לנציג בתקופה (ההעברה האחרונה), שהומרו לעסקה.", "Leads transferred to the agent in the period (latest transfer) that converted."), value: (r) => r.quality.transferred ? r.quality.transferredWon / r.quality.transferred : null, cell: (r) => conv(r.quality.transferredWon, r.quality.transferred), total: (rs) => conv(sum(rs, (r) => r.quality.transferredWon), sum(rs, (r) => r.quality.transferred)) },
    // WhatsApp
    { key: "waConv", group: "whatsapp", label: t("התכתבויות שטופלו", "Conversations handled"), hint: t("התכתבויות שהגיעה בהן הודעה מלקוח בתקופה וקיבלו תשובה מהנציג, מתוך ההתכתבויות שלו (שענה בהן, או משויכות אליו ולא נענו).", "Conversations with a customer message in the period that got the agent's reply, out of the agent's conversations (replied in, or assigned to them and unanswered)."), value: wa((w) => w.conversations ? w.handled / w.conversations : null), cell: (r) => r.wa ? `${r.wa.handled}/${r.wa.conversations}` : "—", total: (rs) => `${sum(rs, (r) => r.wa?.handled)}/${sum(rs, (r) => r.wa?.conversations)}` },
    { key: "waOutbound", group: "whatsapp", label: t("הודעות שנשלחו", "Messages sent"), hint: t("הודעות וואטסאפ שהנציג שלח בתקופה (בלי שליחות אוטומטיות ודיוור).", "WhatsApp messages the agent sent in the period (no automatic sends or campaigns)."), value: wa((w) => w.outbound), cell: (r) => r.wa ? n(r.wa.outbound) : "—", total: (rs) => n(sum(rs, (r) => r.wa?.outbound)) },
    { key: "waFirst", group: "whatsapp", label: t("זמן תגובה ראשוני", "First response"), hint: t("ממוצע הזמן מההודעה הראשונה של הלקוח בתקופה ועד התשובה הראשונה של הנציג.", "Average time from the customer's first message in the period to the agent's first reply."), value: wa((w) => w.firstResponse), cell: (r) => r.wa ? mins(r.wa.firstResponse, t) : "—" },
    { key: "waOpen", group: "whatsapp", label: t("פתוחות כעת", "Open now"), hint: t("התכתבויות פתוחות / ממתינות המשויכות לנציג ברגע זה – מצב נוכחי, לא לפי תקופה.", "Open / pending conversations assigned to the agent right now – current state, not by period."), value: wa((w) => w.openNow), cell: (r) => r.wa ? n(r.wa.openNow) : "—", total: (rs) => n(sum(rs, (r) => r.wa?.openNow)) },
  ];
}
/** What "הכול" shows by default (key metrics of each channel); everything else via the column chooser. */
const ALL_DEFAULT = ["outbound", "answered", "talkSeconds", "waConv", "waOutbound"];
const PREF_KEY = "reports.agentCols";

/**
 * One row per agent with the page's filters (period, agent, campaign, product) and the user's scope – all of it
 * enforced by the server. Base columns are outcomes; activity columns follow the channel switch. A click on an agent
 * opens their detail (all metrics, charts, live call).
 */
export function AgentPerformance({ query, channel, channels }: { query: ReportQuery; channel: Channel; channels: { telephony: boolean; whatsapp: boolean } }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [live, setLive] = useState<LiveAgent[]>([]);
  const [stale, setStale] = useState(true);
  const [liveAgent, setLiveAgent] = useState<string | null>(null);
  const [detail, setDetail] = useState<Agent | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: string; asc: boolean }>({ key: "fullName", asc: true });
  const [chooser, setChooser] = useState(false);
  const [extra, setExtra] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") ?? ALL_DEFAULT; } catch { return ALL_DEFAULT; } });
  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify(extra)); } catch { /* per-viewer convenience only */ } }, [extra]);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    try { const r = await api.get<Report>(`/api/reports/agents${qs({ from: query.from, to: query.to, userId: query.userId, listId: query.listId, product: query.product })}`); if (generation.current === token) { setData(r); setError(""); } }
    catch (e) { if (generation.current === token) setError((e as Error).message); }
  }, [query]);
  useEffect(() => { void load(); const interval = setInterval(load, 30000); return () => { clearInterval(interval); }; }, [load]);
  // Live status (telephony only – the live board is a telephony feature).
  useEffect(() => {
    if (!channels.telephony) return;
    let alive = true; let pending = false; let lastSuccess = 0;
    const poll = async () => { if (pending) return; pending = true; try { const result = await api.get<{ rows: LiveAgent[] }>("/api/manager/live"); if (alive) { setLive(result.rows); lastSuccess = Date.now(); setStale(false); } } catch { if (alive) setStale(true); } finally { pending = false; } };
    void poll(); const interval = setInterval(() => { if (document.visibilityState === "visible") void poll(); }, 2000); const onVis = () => { if (document.visibilityState === "visible") void poll(); }; document.addEventListener("visibilitychange", onVis); const ticker = setInterval(() => { if (alive) { setLiveNow(Date.now()); if (Date.now() - lastSuccess > 10000) setStale(true); } }, 1000);
    return () => { alive = false; clearInterval(interval); clearInterval(ticker); document.removeEventListener("visibilitychange", onVis); };
  }, [channels.telephony]);

  const all = useMemo(() => columns(t, loc), [t, loc]);
  // Lead handling columns are dial-based except the average deal / conversions, which are outcomes.
  const usable = useMemo(() => all.filter((c) => c.group === "base" || (c.group === "telephony" && channels.telephony) || (c.group === "whatsapp" && channels.whatsapp) || (c.group === "leads" && (channels.telephony || !["notCalled", "response"].includes(c.key)))), [all, channels]);
  const cols = useMemo(() => usable.filter((c) => c.group === "base" || (channel === "telephony" ? c.group === "telephony" || c.group === "leads" : channel === "whatsapp" ? c.group === "whatsapp" : extra.includes(c.key))), [usable, channel, extra]);
  const rows = useMemo(() => [...data?.rows ?? []].sort((a, b) => {
    if (a.id === UNASSIGNED || b.id === UNASSIGNED) return a.id === UNASSIGNED ? 1 : -1;
    if (sort.key === "fullName") return (sort.asc ? 1 : -1) * a.fullName.localeCompare(b.fullName, "he", { numeric: true });
    const col = all.find((c) => c.key === sort.key); const va = col?.value(a) ?? null, vb = col?.value(b) ?? null;
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1; // "no data" last in both directions
    return (sort.asc ? 1 : -1) * (va - vb);
  }), [data, sort, all]);
  const sorting = (key: string) => setSort((s) => ({ key, asc: key === s.key ? !s.asc : key === "fullName" }));
  const statusOf = (r: Agent) => { const current = live.find((a) => a.id === r.id); return { current, status: current?.status ?? r.presence }; };
  const statusText = (r: Agent) => { if (r.id === UNASSIGNED) return "—"; const { status } = statusOf(r); return channels.telephony && stale ? t("מתחבר…", "Connecting…") : LIVE_LABEL[status] ? t(LIVE_LABEL[status], LIVE_LABEL_EN[status] ?? LIVE_LABEL[status]) : PRESENCE_LABEL[status] ?? status; };

  /** CSV = exactly the table on screen: the same filters, columns, rows and totals row. */
  function download() {
    if (!data) return;
    const esc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
    const lines = [
      [t("נציג", "Agent"), t("סטטוס", "Status"), ...cols.map((c) => c.label)],
      ...rows.map((r) => [r.id === UNASSIGNED ? t("ללא נציג משויך", "No assigned agent") : r.fullName, statusText(r), ...cols.map((c) => c.cell(r))]),
      ...(rows.length > 1 ? [[t("סה״כ", "Total"), "", ...cols.map((c) => c.total ? c.total(rows) : "")]] : []),
    ];
    const csv = lines.map((r) => r.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `agent-performance_${query.from}_${query.to}${channel !== "all" ? `_${channel}` : ""}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  const head = (key: string, title: string, hint?: string) => <button type="button" onClick={() => sorting(key)} title={hint} data-testid={`agent-sort-${key}`}>{title}{sort.key === key ? sort.asc ? <ArrowUp size={14} /> : <ArrowDown size={14} /> : null}</button>;
  const groupName = (g: Col["group"]) => g === "telephony" ? t("טלפוניה", "Telephony") : g === "whatsapp" ? t("וואטסאפ", "WhatsApp") : t("טיפול בלידים וערך עסקה", "Lead handling & deal value");

  return <div className="performance-page embedded" data-testid="agent-performance">
    {channels.telephony && <ExpertInbox onJoin={async (callId) => { const row = live.find((r) => r.call?.id === callId); if (stale || !row?.call?.canMonitor) throw new Error("השיחה אינה זמינה כעת"); setLiveAgent(row.id); }} />}
    <div className="performance-content">
      {error && <div role="alert" className="lead-error">{error}<button onClick={load}>{t("נסה שוב", "Retry")}</button></div>}
      <div className="agt-toolbar">
        <span>{t("לחיצה על נציג פותחת פירוט מלא · גללו הצידה לעמודות נוספות", "Click an agent for full detail · scroll sideways for more columns")}</span>
        <span className="flex items-center gap-2">
          {channel === "all" && <button type="button" className="agt-export" aria-expanded={chooser} onClick={() => setChooser((v) => !v)} data-testid="agent-cols-toggle"><Columns3 size={15} aria-hidden />{t("עמודות", "Columns")}</button>}
          <button type="button" onClick={download} disabled={!data} className="agt-export" data-testid="agent-export"><Download size={15} aria-hidden />{t("ייצוא CSV", "Export CSV")}</button>
        </span>
      </div>
      {channel === "all" && chooser && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-line px-4 py-2 text-xs" data-testid="agent-cols">
          {(["telephony", "whatsapp", "leads"] as const).map((g) => { const list = usable.filter((c) => c.group === g); return list.length ? (
            <fieldset key={g} className="flex flex-wrap items-center gap-x-3 gap-y-1"><legend className="me-1 font-semibold text-muted">{groupName(g)}:</legend>
              {list.map((c) => <label key={c.key} className="flex items-center gap-1"><input type="checkbox" checked={extra.includes(c.key)} onChange={(e) => setExtra((x) => e.target.checked ? [...x, c.key] : x.filter((k) => k !== c.key))} data-testid={`agent-col-${c.key}`} />{c.label}</label>)}
            </fieldset>) : null; })}
          <button type="button" className="text-accent underline" onClick={() => setExtra(ALL_DEFAULT)}>{t("ברירת מחדל", "Default")}</button>
        </div>
      )}
      {!data && !error ? <div className="flex justify-center p-12"><Spinner /></div> : data && (
        <div className="agt-scroll" data-testid="agent-table-scroll">
          <table className="agt-table" data-testid="agent-table">
            <thead><tr>
              <th className="agt-sticky" scope="col">{head("fullName", t("נציג", "Agent"))}</th>
              <th scope="col">{t("סטטוס", "Status")}</th>
              {cols.map((c) => <th key={c.key} scope="col" className={c.group === "base" ? "" : "agt-act"}>{head(c.key, c.label, c.hint)}</th>)}
            </tr></thead>
            <tbody>{rows.map((r) => {
              const { current, status } = statusOf(r);
              return (
                <tr key={r.id} data-testid={`agent-row-${r.id}`}>
                  <th scope="row" className="agt-sticky">{r.id === UNASSIGNED ? <span className="text-muted" title={t("עסקאות ולידים ללא נציג אחראי, התכתבויות שלא נענו ולא שויכו, ופעילות של משתמשים שאינם ברשימה (תמיכה / הוסרו)", "Deals and leads without an owner, unanswered unassigned conversations, and activity of users not listed (support / removed)")}>{t("ללא נציג משויך", "No assigned agent")}</span>
                    : <button type="button" className={detail?.id === r.id ? "performance-agent selected" : "performance-agent"} onClick={() => setDetail(r)} data-testid={`agent-open-${r.id}`}>{r.fullName}</button>}</th>
                  <td>{r.id === UNASSIGNED ? "—" : <><span className={`performance-presence ${status === "offline" || (channels.telephony && stale) ? "offline" : "online"}`}>{statusText(r)}</span>{current && !stale && <small className="performance-since"> ({duration(Math.max(0, Math.floor((liveNow - new Date(current.sinceAt).getTime()) / 1000)))})</small>}</>}</td>
                  {cols.map((c) => <td key={c.key} className="agt-num" dir="auto">{c.cell(r)}</td>)}
                </tr>);
            })}</tbody>
            {rows.length > 1 && <tfoot><tr data-testid="agent-totals">
              <th scope="row" className="agt-sticky">{t("סה״כ", "Total")}</th><td />
              {cols.map((c) => <td key={c.key} className="agt-num" dir="auto">{c.total ? c.total(rows) : "—"}</td>)}
            </tr></tfoot>}
          </table>
          {!rows.length && <div className="p-10 text-center text-muted">{t("אין נציגים התואמים לסינון", "No agents match the filter")}</div>}
        </div>
      )}
      {data && <p className="performance-caption">{channels.whatsapp ? t("פעילות וואטסאפ משויכת לנציג שענה ראשון בהתכתבות; התכתבות שלא נענתה – לנציג המשויך אליה. ליד שהועבר נספר אצל הבעלים הנוכחי, ושיחות והודעות – אצל מי שביצע אותן. הכנסות בשקלים בלבד.", "WhatsApp activity belongs to the agent who replied first; an unanswered conversation – to its assignee. A transferred lead counts for its current owner; calls and messages – for whoever made them. Revenue in ILS only.") : t("ליד שהועבר נספר אצל הבעלים הנוכחי, ושיחות – אצל הנציג שביצע אותן. הכנסות בשקלים בלבד.", "Transferred leads count for their current owner; calls count for the agent who made them. Revenue in ILS only.")}</p>}
    </div>
    {detail && <AgentDetail agent={detail} query={query} channels={channels} cols={usable} onClose={() => setDetail(null)} onLive={channels.telephony ? () => setLiveAgent(detail.id) : undefined} />}
    {liveAgent && <AgentCallDrawer key={liveAgent} agent={live.find((a) => a.id === liveAgent) ?? { id: liveAgent, fullName: data?.agents.find((a) => a.id === liveAgent)?.fullName ?? t("נציג", "Agent"), status: "offline", sinceAt: new Date().toISOString(), call: null }} stale={stale} onClose={() => setLiveAgent(null)} />}
  </div>;
}

interface AgentReport { metrics: Metric[]; series: { current: Day[]; compare: Day[] | null }; periods: { current: { from: string; to: string }; compare: { from: string; to: string } | null } }
/** One agent: every metric with comparison (server-side scope check on userId), daily charts and all table figures. */
function AgentDetail({ agent, query, channels, cols, onClose, onLive }: { agent: Agent; query: ReportQuery; channels: { telephony: boolean; whatsapp: boolean }; cols: Col[]; onClose: () => void; onLive?: () => void }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const dialog = useRef<HTMLDialogElement>(null);
  const [rep, setRep] = useState<AgentReport | null>(null); const [err, setErr] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    api.get<AgentReport>(`/api/reports/comparison${qs({ from: query.from, to: query.to, compare: query.compare, compareFrom: query.compareFrom, compareTo: query.compareTo, userId: agent.id, listId: query.listId, product: query.product })}`).then((r) => live && setRep(r)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [agent.id, query]);
  const d = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString(loc, { day: "numeric", month: "numeric", year: "2-digit", timeZone: "UTC" });
  const periods = rep ? { current: `${d(rep.periods.current.from)} – ${d(rep.periods.current.to)}`, compare: rep.periods.compare ? `${d(rep.periods.compare.from)} – ${d(rep.periods.compare.to)}` : null } : { current: "", compare: null };
  const pick = (ids: string[]) => ids.map((id) => rep?.metrics.find((m) => m.id === id)).filter((m): m is Metric => Boolean(m));
  const noCompare = Boolean(rep?.periods.compare && rep.metrics.every((m) => m.change.previous === null || m.change.previous === 0));
  return (
    <dialog ref={dialog} className="lead-details-dialog" aria-label={t(`פירוט נציג: ${agent.fullName}`, `Agent detail: ${agent.fullName}`)} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="agent-detail">
      <div className="lead-details-panel" style={{ width: "min(760px, 100vw)" }}>
        <header><h2>{agent.fullName}</h2><button type="button" aria-label={t("סגירה", "Close")} onClick={onClose} data-testid="agent-detail-close"><X size={22} /></button></header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[color:var(--text)]">
          {onLive && <button type="button" className="h-9 rounded-lg border border-line px-3 text-sm" onClick={onLive} data-testid="agent-detail-live">{t("שיחה חיה והאזנה", "Live call & listen")}</button>}
          {err && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-2 text-sm">{err}</p>}
          {!rep && !err && <div className="flex justify-center p-8"><Spinner /></div>}
          {rep && <>
            <MetricGroup title={t("תוצאות", "Outcomes")} testId="agent-detail-kpis" metrics={pick(["revenue", "dealsWon", "leadCloseRate", "newLeads", "avgDeal"])} href={() => undefined} hideChange={noCompare} periods={periods} />
            {channels.telephony && <MetricGroup title={t("שיחות טלפון", "Phone calls")} testId="agent-detail-calls" metrics={pick(["outbound", "answered", "answerRate", "talkSeconds", "avgTalkSeconds", "notCalled", "responseMinutes"])} href={() => undefined} hideChange={noCompare} periods={periods} />}
            {channels.whatsapp && <MetricGroup title={t("התכתבויות וואטסאפ", "WhatsApp conversations")} testId="agent-detail-wa" metrics={pick(["waOutbound", "waHandledRate", "waFirstResponse"])} href={() => undefined} hideChange={noCompare} periods={periods} caption={t("הודעות נכנסות לא מוצגות לנציג – הן שייכות להתכתבות.", "Inbound messages aren't shown per agent – they belong to the conversation.")} />}
            <div className="grid gap-3 sm:grid-cols-2">
              {channels.telephony && <Panel className="min-w-0" title={t("שיחות יוצאות לפי יום", "Outbound calls per day")}><DailyBars cur={rep.series.current} prev={rep.series.compare} field="outbound" /></Panel>}
              {channels.whatsapp && <Panel className="min-w-0" title={t("הודעות וואטסאפ לפי יום", "WhatsApp messages per day")}><DailyBars cur={rep.series.current} prev={rep.series.compare} field="waOutbound" /></Panel>}
              <Panel className="min-w-0" title={t("עסקאות לפי יום", "Deals per day")}><DailyBars cur={rep.series.current} prev={rep.series.compare} field="dealsWon" /></Panel>
            </div>
          </>}
          <section className="rounded-xl border border-line" aria-label={t("כל נתוני הטבלה", "All table figures")} data-testid="agent-detail-figures">
            <h3 className="border-b border-line px-3 py-1.5 text-xs font-semibold">{t("כל הנתונים בתקופה", "All figures in the period")}</h3>
            <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
              {cols.map((c) => <div key={c.key} className={cx("bg-panel px-3 py-2")} title={c.hint}><dt className="text-[11px] text-muted">{c.label}</dt><dd className="mt-0.5 font-semibold tabular-nums" dir="auto">{c.cell(agent)}</dd></div>)}
            </dl>
          </section>
        </div>
      </div>
    </dialog>
  );
}
