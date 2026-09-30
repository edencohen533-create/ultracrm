"use client";

import {ExpertInbox} from "@/components/sales/ExpertAssistance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Download, Info, Users } from "lucide-react";
import { AgentCallDrawer, LIVE_LABEL, LIVE_LABEL_EN, type LiveAgent } from "./AgentCallDrawer";
import { useT } from "@/components/i18n/LangProvider";
import { api, qs } from "@/lib/client/api";
import { Spinner } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";

interface Quality { responseMinutes: number | null; notCalled: number; newLeads: number; newWon: number; transferred: number; transferredWon: number; allLeads: number; allWon: number; avgDealValue: number | null; wonDeals: number }
interface Agent { id: string; fullName: string; presence: string; presenceAt: string; outbound: number; answered: number; handled: number; manual: number; closed: number; dialSeconds: number; talkSeconds: number; avgTalkSeconds: number | null; quality: Quality }
const conv = (won: number, total: number) => total ? `${Math.round(won / total * 100)}% (${won}/${total})` : "—";
const mins = (m: number | null, t: (he: string, en: string) => string) => m === null ? "—" : m < 60 ? t(`${Math.round(m)} דק׳`, `${Math.round(m)} min`) : m < 1440 ? t(`${(m / 60).toFixed(1)} שע׳`, `${(m / 60).toFixed(1)} h`) : t(`${(m / 1440).toFixed(1)} ימים`, `${(m / 1440).toFixed(1)} days`);
const shortDur = (s: number | null) => s === null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
interface Report { rows: Agent[]; totals: Pick<Agent, "outbound" | "answered" | "handled" | "closed" | "talkSeconds">; agents: { id: string; fullName: string }[]; from: string; to: string; timezone: string }
const duration = (s: number) => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), Math.floor(s % 60)].map(v => String(v).padStart(2, "0")).join(":");
const rate = (n: number, d: number) => d ? Math.round(n / d * 100) : 0;
const UNASSIGNED = "__unassigned";
type Sort = "fullName" | "outbound" | "handled" | "closed" | "dialSeconds" | "talkSeconds" | "total";
/**
 * Agent table + lead conversion. Standalone it has its own period picker; inside the reports page (`range`) it
 * follows the page's filters (business-timezone period, agent) and shows only the per-agent detail.
 */
export function AgentPerformance({ range }: { range?: { from: string; to: string; userId?: string | null } } = {}) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [live, setLive] = useState<LiveAgent[]>([]);
  const [stale, setStale] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [agent, setAgent] = useState("");
  const [sort, setSort] = useState<{ key: Sort; asc: boolean }>({ key: "fullName", asc: true });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    const now = new Date();
    const begin = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : period === "week" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) : period === "custom" && from ? new Date(`${from}T00:00:00`) : undefined;
    const end = period === "custom" && to ? new Date(`${to}T23:59:59.999`) : undefined;
    try { const result = await api.get<Report>(`/api/reports/agents${range ? qs({ userId: range.userId ?? "", from: range.from, to: range.to }) : qs({ userId: agent, from: begin?.toISOString(), to: end?.toISOString() })}`); if (generation.current === token) { setData(result); setError(""); } }
    catch (e) { if (generation.current === token) setError((e as Error).message); }
  }, [period, from, to, agent, range]);
  useEffect(() => { void load(); const interval = setInterval(load, 30000); return () => { clearInterval(interval); }; }, [load]);
  useEffect(() => {
    let alive = true; let pending = false; let lastSuccess = 0;
    const poll = async () => { if(pending) return; pending = true; try { const result = await api.get<{rows:LiveAgent[]}>("/api/manager/live"); if(alive){setLive(result.rows);lastSuccess=Date.now();setStale(false);} } catch { if(alive)setStale(true); } finally{pending=false;} };
    void poll(); const interval=setInterval(()=>{if(document.visibilityState==="visible")void poll();},2000);const onVis=()=>{if(document.visibilityState==="visible")void poll();};document.addEventListener("visibilitychange",onVis);const ticker=setInterval(()=>{if(alive){setLiveNow(Date.now());if(Date.now()-lastSuccess>10000)setStale(true);}},1000);
    return()=>{alive=false;clearInterval(interval);clearInterval(ticker);document.removeEventListener("visibilitychange",onVis);};
  }, []);
  const rows = useMemo(() => [...data?.rows ?? []].sort((a,b) => { if (a.id === UNASSIGNED || b.id === UNASSIGNED) return a.id === UNASSIGNED ? 1 : -1; const result = sort.key === "fullName" ? a.fullName.localeCompare(b.fullName, "he", { numeric: true }) : sort.key === "total" ? (a.dialSeconds + a.talkSeconds) - (b.dialSeconds + b.talkSeconds) : a[sort.key] - b[sort.key]; return sort.asc ? result : -result; }), [data, sort]);
  function sorting(key: Sort) { setSort(s => ({ key, asc: key === s.key ? !s.asc : true })); }
  const cols = useMemo(() => agentColumns(t, loc), [t, loc]);
  const totalsRow = useMemo(() => totalsOf(rows), [rows]);
  /** CSV = exactly the table: the same columns, one row per agent, and the same totals row. */
  function download() {
    const esc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
    const lines = [[t("נציג", "Agent"), t("סטטוס", "Status"), ...cols.map((c) => c.label)], ...rows.map((r) => [r.fullName, PRESENCE_LABEL[r.presence] ?? r.presence, ...cols.map((c) => c.csv(r))]), [t("סה״כ", "Total"), "", ...cols.map((c) => c.total ? c.total(totalsRow) : "")]];
    const csv = lines.map((r) => r.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = "agent-performance.csv"; link.click(); URL.revokeObjectURL(url);
  }
  const tot = data?.totals;
  const cards = [
    { key: "outbound", label: t("שיחות יוצאות", "Outbound calls"), value: tot?.outbound ?? 0, tone: "slate", hint: t("ניסיונות חיוג יוצאים שנוצרו אצל ספק הטלפוניה בטווח", "Outbound dial attempts created at the telephony provider in the range") },
    { key: "answered", label: t("שיחות שנענו", "Answered calls"), value: tot?.answered ?? 0, tone: "orange", percent: rate(tot?.answered ?? 0,tot?.outbound ?? 0), hint: t("שיחות יוצאות עם אישור מענה מהספק", "Outbound calls with answer confirmation from the provider") },
    { key: "handled", label: t("שיחות שנוהלו", "Handled calls"), value: tot?.handled ?? 0, tone: "blue", percent: rate(tot?.handled ?? 0,tot?.answered ?? 0), hint: t("שיחות יוצאות שנענו ונשמרה עבורן תוצאת שיחה", "Answered outbound calls with a saved call outcome") },
    { key: "closed", label: t("עסקאות סגורות", "Closed deals"), value: tot?.closed ?? 0, tone: "green", percent: rate(tot?.closed ?? 0,tot?.handled ?? 0), hint: t("עסקאות של הנציגים שנסגרו בהצלחה בטווח; האחוז ביחס לשיחות שנוהלו", "Agents' deals closed successfully in the range; percentage relative to handled calls") },
    { key: "talk", label: t("סה״כ זמן בשיחה", "Total talk time"), value: duration(tot?.talkSeconds ?? 0), tone: "dark", hint: t("זמן שיחה מצטבר בשיחות יוצאות שנענו", "Cumulative talk time on answered outbound calls") },
  ];
  const head = (key: Sort, title: string) => <button onClick={() => sorting(key)}>{title}{sort.key === key ? sort.asc ? <ArrowUp size={16}/> : <ArrowDown size={16}/> : null}</button>;
  return <div className={range ? "performance-page embedded" : "performance-page"} data-testid="agent-performance"><ExpertInbox onJoin={async callId=>{const row=live.find(r=>r.call?.id===callId);if(stale||!row?.call?.canMonitor)throw new Error("השיחה אינה זמינה כעת");setSelectedAgent(row.id);}}/>{!range && <header className="performance-header"><h1>{t("ביצועי נציגים", "Agent performance")}</h1><div className="performance-filters"><label><CalendarDays size={17}/><select aria-label={t("תקופת ביצועי נציגים", "Agent performance period")} value={period} onChange={e => setPeriod(e.target.value)}><option value="today">{t("היום", "Today")}</option><option value="week">{t("7 ימים אחרונים", "Last 7 days")}</option><option value="month">{t("החודש", "This month")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option></select></label><label><Users size={19}/><select aria-label={t("סינון נציגים", "Filter agents")} value={agent} onChange={e => setAgent(e.target.value)}><option value="">{t("כל הנציגים", "All agents")}</option>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label><button title={t("ייצוא CSV", "Export CSV")} aria-label={t("ייצוא ביצועי נציגים", "Export agent performance")} disabled={!data} onClick={download}><Download size={17}/></button></div></header>}
    {!range && period === "custom" && <div className="performance-dates"><label>{t("מתאריך", "From")} <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}/></label><label>{t("עד תאריך", "To")} <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}/></label></div>}
    <div className="performance-content">{error && <div role="alert" className="lead-error">{error}<button onClick={load}>{t("נסה שוב", "Retry")}</button></div>}
      {!range && <section className="performance-funnel" aria-label={t("סיכום ביצועים", "Performance summary")}>{cards.map(c => <article className={`performance-step ${c.tone}`} key={c.key} title={c.hint}><div><span>{c.label}</span>{c.tone !== "slate" && c.tone !== "dark" && <Info size={13}/>}</div><strong dir="ltr">{data ? c.value : "—"}</strong>{c.percent !== undefined && <small>{c.percent}%</small>}</article>)}</section>}
      {range && <div className="agt-toolbar"><span>{t("שורה אחת לכל נציג · גללו הצידה לעמודות נוספות", "One row per agent · scroll sideways for more columns")}</span><button type="button" onClick={download} disabled={!data} className="agt-export" data-testid="agent-export"><Download size={15} aria-hidden />{t("ייצוא CSV", "Export CSV")}</button></div>}
      {!data && !error ? <div className="p-12 flex justify-center"><Spinner /></div> : data && (
        <div className="agt-scroll" data-testid="agent-table-scroll">
          <table className="agt-table" data-testid="agent-table">
            <thead><tr>
              <th className="agt-sticky" scope="col">{head("fullName", t("נציג", "Agent"))}</th>
              <th scope="col">{t("סטטוס", "Status")}</th>
              {cols.map((c) => <th key={c.key} scope="col" title={c.hint}>{c.sort ? head(c.key as Sort, c.label) : c.label}</th>)}
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid={`agent-row-${r.id}`}>
                <th scope="row" className="agt-sticky">{r.id === UNASSIGNED ? <span className="text-muted" title={t("עסקאות שנסגרו ללא נציג אחראי ושיחות של משתמשים שאינם ברשימה (תמיכה / הוסרו)", "Deals closed without an owner and calls of users not in the list (support / removed)")}>{t("ללא נציג משויך", "No assigned agent")}</span> : <button className={selectedAgent === r.id ? "performance-agent selected" : "performance-agent"} onClick={() => setSelectedAgent(r.id)}>{r.fullName}</button>}</th>
                <td>{r.id === UNASSIGNED ? "—" : (() => { const current = live.find((a) => a.id === r.id); const status = current?.status ?? r.presence; return <><span className={`performance-presence ${status === "offline" || stale ? "offline" : "online"}`}>{stale ? t("מתחבר…", "Connecting…") : LIVE_LABEL[status] ? t(LIVE_LABEL[status], LIVE_LABEL_EN[status] ?? LIVE_LABEL[status]) : PRESENCE_LABEL[status] ?? status}</span>{current && !stale && <small className="performance-since"> ({duration(Math.max(0, Math.floor((liveNow - new Date(current.sinceAt).getTime()) / 1000)))})</small>}</>; })()}</td>
                {cols.map((c) => <td key={c.key} className="agt-num">{c.cell(r)}</td>)}
              </tr>))}
            </tbody>
            {rows.length > 1 && <tfoot><tr data-testid="agent-totals">
              <th scope="row" className="agt-sticky">{t("סה״כ", "Total")}</th><td />
              {cols.map((c) => <td key={c.key} className="agt-num">{c.total ? c.total(totalsRow) : "—"}</td>)}
            </tr></tfoot>}
          </table>
          {!rows.length && <div className="p-10 text-center text-muted">{t("אין נציגים התואמים לסינון", "No agents match the filter")}</div>}
        </div>
      )}
      {data && <p className="performance-caption">{t("המרה = ליד שהומר לעסקה או שיש לו עסקה שנסגרה. זמן תגובה = חציון עד ניסיון חיוג שבו המספר חויג בפועל (בשורת הסה״כ אינו מחושב – חציון אינו מצטבר). ממוצעים בשורת הסה״כ משוקללים.", "Conversion = a lead converted to a deal or with a closed deal. Response time = median up to a dial attempt where the number was actually dialed (not totalled – a median doesn't add up). Averages in the totals row are weighted.")}</p>}
      {data && <p className="performance-caption">{t("נתונים לתקופה:", "Data for period:")} {new Date(data.from).toLocaleDateString(loc)} – {new Date(data.to).toLocaleDateString(loc)} · {t("הסטטוס מציג זמינות נוכחית · מתעדכן בכל 30 שניות", "Status shows current availability · refreshes every 30 seconds")}</p>}
    </div>
    {selectedAgent && <AgentCallDrawer key={selectedAgent} agent={live.find(a=>a.id===selectedAgent) ?? { id:selectedAgent,fullName:data?.agents.find(a=>a.id===selectedAgent)?.fullName??t("נציג", "Agent"),status:"offline",sinceAt:new Date().toISOString(),call:null }} stale={stale} onClose={()=>setSelectedAgent(null)}/>}
  </div>;
}

type Totals = { outbound: number; answered: number; handled: number; manual: number; closed: number; dialSeconds: number; talkSeconds: number; notCalled: number; newLeads: number; newWon: number; transferred: number; transferredWon: number; allLeads: number; allWon: number; dealValue: number; wonDeals: number };
function totalsOf(rows: Agent[]): Totals {
  return rows.reduce<Totals>((s, r) => ({ outbound: s.outbound + r.outbound, answered: s.answered + r.answered, handled: s.handled + r.handled, manual: s.manual + r.manual, closed: s.closed + r.closed, dialSeconds: s.dialSeconds + r.dialSeconds, talkSeconds: s.talkSeconds + r.talkSeconds, notCalled: s.notCalled + r.quality.notCalled, newLeads: s.newLeads + r.quality.newLeads, newWon: s.newWon + r.quality.newWon, transferred: s.transferred + r.quality.transferred, transferredWon: s.transferredWon + r.quality.transferredWon, allLeads: s.allLeads + r.quality.allLeads, allWon: s.allWon + r.quality.allWon, dealValue: s.dealValue + (r.quality.avgDealValue ?? 0) * r.quality.wonDeals, wonDeals: s.wonDeals + r.quality.wonDeals }),
    { outbound: 0, answered: 0, handled: 0, manual: 0, closed: 0, dialSeconds: 0, talkSeconds: 0, notCalled: 0, newLeads: 0, newWon: 0, transferred: 0, transferredWon: 0, allLeads: 0, allWon: 0, dealValue: 0, wonDeals: 0 });
}
interface Col { key: string; label: string; hint?: string; sort?: boolean; cell: (r: Agent) => React.ReactNode; csv: (r: Agent) => string; total?: (s: Totals) => string }
/** Every per-agent figure as a column (one row per agent). Totals are sums, or weighted averages / ratios of sums. */
function agentColumns(t: (he: string, en: string) => string, loc: string): Col[] {
  const money = (v: number | null) => v === null ? "—" : `₪${Math.round(v).toLocaleString(loc)}`;
  const n = (v: number) => v.toLocaleString(loc);
  return [
    { key: "outbound", sort: true, label: t("שיחות יוצאות", "Outbound calls"), hint: t("ניסיונות חיוג יוצאים שנוצרו אצל ספק הטלפוניה", "Outbound dial attempts created at the telephony provider"), cell: (r) => <>{n(r.outbound)}{r.manual > 0 && <span className="performance-manual"> ({t("ידני:", "manual:")} {rate(r.manual, r.outbound)}%)</span>}</>, csv: (r) => String(r.outbound), total: (s) => n(s.outbound) },
    { key: "answered", label: t("נענו", "Answered"), hint: t("שיחות יוצאות עם אישור מענה מהספק", "Outbound calls answered"), cell: (r) => n(r.answered), csv: (r) => String(r.answered), total: (s) => n(s.answered) },
    { key: "handled", sort: true, label: t("נוהלו", "Handled"), hint: t("שיחות שנענו ונשמרה להן תוצאה", "Answered calls with a saved outcome"), cell: (r) => n(r.handled), csv: (r) => String(r.handled), total: (s) => n(s.handled) },
    { key: "closed", sort: true, label: t("עסקאות סגורות", "Closed deals"), cell: (r) => n(r.closed), csv: (r) => String(r.closed), total: (s) => n(s.closed) },
    { key: "dialSeconds", sort: true, label: t("זמן בחיוג", "Dial time"), cell: (r) => <span dir="ltr">{duration(r.dialSeconds)}</span>, csv: (r) => duration(r.dialSeconds), total: (s) => duration(s.dialSeconds) },
    { key: "talkSeconds", sort: true, label: t("זמן בשיחה", "Talk time"), cell: (r) => <span dir="ltr">{duration(r.talkSeconds)}</span>, csv: (r) => duration(r.talkSeconds), total: (s) => duration(s.talkSeconds) },
    { key: "total", sort: true, label: t("חיוג + שיחה", "Dial + talk"), cell: (r) => <span dir="ltr">{duration(r.dialSeconds + r.talkSeconds)}</span>, csv: (r) => duration(r.dialSeconds + r.talkSeconds), total: (s) => duration(s.dialSeconds + s.talkSeconds) },
    { key: "avgTalk", label: t("זמן שיחה ממוצע", "Avg. talk time"), hint: t("ממוצע זמן שיחה בשיחות יוצאות שנענו", "Average talk time on answered outbound calls"), cell: (r) => <span dir="ltr">{shortDur(r.avgTalkSeconds)}</span>, csv: (r) => shortDur(r.avgTalkSeconds), total: (s) => shortDur(s.answered ? Math.round(s.talkSeconds / s.answered) : null) },
    { key: "response", label: t("זמן תגובה לליד חדש", "New lead response"), hint: t("חציון הזמן מיצירת ליד חדש ועד ניסיון החיוג הראשון בפועל", "Median time from a new lead to the first actual dial"), cell: (r) => mins(r.quality.responseMinutes, t), csv: (r) => mins(r.quality.responseMinutes, t) },
    { key: "notCalled", label: t("לא חויגו", "Not dialed"), hint: t("לידים חדשים מהתקופה שעדיין לא חויגו", "New leads from the period not yet dialed"), cell: (r) => r.quality.notCalled ? n(r.quality.notCalled) : "—", csv: (r) => String(r.quality.notCalled), total: (s) => n(s.notCalled) },
    { key: "newConv", label: t("המרה מליד חדש", "New lead conversion"), cell: (r) => <span dir="ltr">{conv(r.quality.newWon, r.quality.newLeads)}</span>, csv: (r) => conv(r.quality.newWon, r.quality.newLeads), total: (s) => conv(s.newWon, s.newLeads) },
    { key: "transferConv", label: t("המרה מליד שהועבר", "Transferred lead conversion"), cell: (r) => <span dir="ltr">{conv(r.quality.transferredWon, r.quality.transferred)}</span>, csv: (r) => conv(r.quality.transferredWon, r.quality.transferred), total: (s) => conv(s.transferredWon, s.transferred) },
    { key: "allConv", label: t("המרה מכל הלידים", "All leads conversion"), cell: (r) => <span dir="ltr">{conv(r.quality.allWon, r.quality.allLeads)}</span>, csv: (r) => conv(r.quality.allWon, r.quality.allLeads), total: (s) => conv(s.allWon, s.allLeads) },
    { key: "dealValue", label: t("שווי עסקה ממוצע", "Avg. deal value"), cell: (r) => money(r.quality.avgDealValue), csv: (r) => r.quality.avgDealValue === null ? "" : String(Math.round(r.quality.avgDealValue)), total: (s) => money(s.wonDeals ? s.dealValue / s.wonDeals : null) },
  ];
}
