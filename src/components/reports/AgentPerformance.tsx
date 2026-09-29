"use client";

import {ExpertInbox} from "@/components/sales/ExpertAssistance";
import {SalesDiagnostics} from "@/components/sales/SalesDiagnostics";
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
type Sort = "fullName" | "outbound" | "handled" | "closed" | "dialSeconds" | "talkSeconds" | "total";
export function AgentPerformance() {
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
    try { const result = await api.get<Report>(`/api/reports/agents${qs({ userId: agent, from: begin?.toISOString(), to: end?.toISOString() })}`); if (generation.current === token) { setData(result); setError(""); } }
    catch (e) { if (generation.current === token) setError((e as Error).message); }
  }, [period, from, to, agent]);
  useEffect(() => { void load(); const interval = setInterval(load, 30000); return () => { clearInterval(interval); }; }, [load]);
  useEffect(() => {
    let alive = true; let pending = false; let lastSuccess = 0;
    const poll = async () => { if(pending) return; pending = true; try { const result = await api.get<{rows:LiveAgent[]}>("/api/manager/live"); if(alive){setLive(result.rows);lastSuccess=Date.now();setStale(false);} } catch { if(alive)setStale(true); } finally{pending=false;} };
    void poll(); const interval=setInterval(poll,2000);const ticker=setInterval(()=>{if(alive){setLiveNow(Date.now());if(Date.now()-lastSuccess>10000)setStale(true);}},1000);
    return()=>{alive=false;clearInterval(interval);clearInterval(ticker);};
  }, []);
  const rows = useMemo(() => [...data?.rows ?? []].sort((a,b) => { const result = sort.key === "fullName" ? a.fullName.localeCompare(b.fullName,"he") : sort.key === "total" ? (a.dialSeconds + a.talkSeconds) - (b.dialSeconds + b.talkSeconds) : a[sort.key] - b[sort.key]; return sort.asc ? result : -result; }), [data, sort]);
  function sorting(key: Sort) { setSort(s => ({ key, asc: key === s.key ? !s.asc : true })); }
  function download() {
    const rowsCsv = [[t("שם מלא", "Full name"),t("סטטוס", "Status"),t("שיחות יוצאות", "Outbound calls"),t("נוהלו", "Handled"),t("סגורות", "Closed"),t("זמן בחיוג", "Dial time"),t("זמן בשיחה", "Talk time"),t("זמן כולל", "Total time")], ...rows.map(r => [r.fullName,PRESENCE_LABEL[r.presence] ?? r.presence,String(r.outbound),String(r.handled),String(r.closed),duration(r.dialSeconds),duration(r.talkSeconds),duration(r.dialSeconds+r.talkSeconds)])];
    const csv = rowsCsv.map(r => r.map(v => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"})); const link = document.createElement("a"); link.href=url;link.download="agent-performance.csv";link.click();URL.revokeObjectURL(url);
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
  return <div className="performance-page" data-testid="agent-performance"><ExpertInbox onJoin={async callId=>{const row=live.find(r=>r.call?.id===callId);if(stale||!row?.call?.canMonitor)throw new Error("השיחה אינה זמינה כעת");setSelectedAgent(row.id);}}/><header className="performance-header"><h1>{t("ביצועי נציגים", "Agent performance")}</h1><div className="performance-filters"><label><CalendarDays size={17}/><select aria-label={t("תקופת ביצועי נציגים", "Agent performance period")} value={period} onChange={e => setPeriod(e.target.value)}><option value="today">{t("היום", "Today")}</option><option value="week">{t("7 ימים אחרונים", "Last 7 days")}</option><option value="month">{t("החודש", "This month")}</option><option value="custom">{t("טווח מותאם", "Custom range")}</option></select></label><label><Users size={19}/><select aria-label={t("סינון נציגים", "Filter agents")} value={agent} onChange={e => setAgent(e.target.value)}><option value="">{t("כל הנציגים", "All agents")}</option>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label><button title={t("ייצוא CSV", "Export CSV")} aria-label={t("ייצוא ביצועי נציגים", "Export agent performance")} disabled={!data} onClick={download}><Download size={17}/></button></div></header>
    {period === "custom" && <div className="performance-dates"><label>{t("מתאריך", "From")} <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}/></label><label>{t("עד תאריך", "To")} <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}/></label></div>}
    <div className="performance-content">{error && <div role="alert" className="lead-error">{error}<button onClick={load}>{t("נסה שוב", "Retry")}</button></div>}
      <section className="performance-funnel" aria-label={t("סיכום ביצועים", "Performance summary")}>{cards.map(c => <article className={`performance-step ${c.tone}`} key={c.key} title={c.hint}><div><span>{c.label}</span>{c.tone !== "slate" && c.tone !== "dark" && <Info size={13}/>}</div><strong dir="ltr">{data ? c.value : "—"}</strong>{c.percent !== undefined && <small>{c.percent}%</small>}</article>)}</section>
      <section className="performance-table-card"><h2>{t("נציגים", "Agents")}</h2>{!data && !error ? <div className="p-12 flex justify-center"><Spinner/></div> : <div className="performance-table-scroll"><table><thead><tr><th>{head("fullName",t("שם מלא", "Full name"))}</th><th>{t("סטטוס", "Status")}</th><th>{head("outbound",t("שיחות יוצאות", "Outbound calls"))}</th><th>{head("handled",t("נוהלו", "Handled"))}</th><th>{head("closed",t("סגורות", "Closed"))}</th><th>{head("dialSeconds",t("סה״כ זמן בחיוג", "Total dial time"))}</th><th>{head("talkSeconds",t("סה״כ זמן בשיחה", "Total talk time"))}</th><th>{head("total",t("סה״כ זמן בחיוג + בשיחה", "Total dial + talk time"))}</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td><button className={selectedAgent === r.id ? "performance-agent selected" : "performance-agent"} onClick={() => setSelectedAgent(r.id)}>{r.fullName}</button></td><td>{(() => { const current=live.find(a=>a.id===r.id); const status=current?.status??r.presence; return <><span className={`performance-presence ${status === "offline" || stale ? "offline" : "online"}`}>{stale ? t("מתחבר…", "Connecting…") : LIVE_LABEL[status] ? t(LIVE_LABEL[status], LIVE_LABEL_EN[status] ?? LIVE_LABEL[status]) : PRESENCE_LABEL[status] ?? status}</span>{current && !stale && <small className="performance-since"> ({duration(Math.max(0,Math.floor((liveNow-new Date(current.sinceAt).getTime())/1000)))})</small>}</>; })()}</td><td>{r.outbound}{r.manual > 0 && <span className="performance-manual"> ({t("ידני:", "manual:")} {rate(r.manual,r.outbound)}%)</span>}</td><td>{r.handled}</td><td>{r.closed}</td><td dir="ltr">{duration(r.dialSeconds)}</td><td dir="ltr">{duration(r.talkSeconds)}</td><td dir="ltr">{duration(r.dialSeconds+r.talkSeconds)}</td></tr>)}</tbody></table>{data && !rows.length && <div className="p-10 text-center text-muted">{t("אין נציגים התואמים לסינון", "No agents match the filter")}</div>}</div>}</section>
      {data && <section className="performance-table-card" data-testid="lead-quality"><h2>{t("המרה וטיפול בלידים", "Lead conversion & handling")}</h2><div className="performance-table-scroll"><table><thead><tr><th>{t("נציג", "Agent")}</th><th title={t("ממוצע זמן שיחה בשיחות יוצאות שנענו", "Average talk time on answered outbound calls")}>{t("זמן שיחה ממוצע", "Avg. talk time")}</th><th title={t("חציון הזמן מיצירת ליד חדש ועד ניסיון החיוג הראשון בפועל", "Median time from new lead creation to the first actual dial attempt")}>{t("זמן תגובה לליד חדש", "New lead response time")}</th><th title={t("לידים חדשים מהתקופה שעדיין לא חויגו", "New leads from the period not yet dialed")}>{t("לא חויגו", "Not dialed")}</th><th title={t("לידים שנוצרו בתקופה והגיעו לנציג חדשים (לא בהעברה)", "Leads created in the period that reached the agent as new (not transferred)")}>{t("המרה מליד חדש", "New lead conversion")}</th><th title={t("לידים שהועברו לנציג מנציג אחר בתקופה", "Leads transferred to the agent from another agent in the period")}>{t("המרה מליד שהועבר", "Transferred lead conversion")}</th><th title={t("כל הלידים של הנציג שנוצרו בתקופה", "All of the agent's leads created in the period")}>{t("המרה מכל הלידים", "All leads conversion")}</th><th title={t("ממוצע סכום העסקאות שנסגרו בתקופה", "Average amount of deals closed in the period")}>{t("שווי עסקה ממוצע", "Avg. deal value")}</th></tr></thead><tbody>{rows.map(r => <tr key={r.id} data-testid={`quality-${r.id}`}><td>{r.fullName}</td><td dir="ltr">{shortDur(r.avgTalkSeconds)}</td><td>{mins(r.quality.responseMinutes, t)}</td><td>{r.quality.notCalled || "—"}</td><td dir="ltr">{conv(r.quality.newWon, r.quality.newLeads)}</td><td dir="ltr">{conv(r.quality.transferredWon, r.quality.transferred)}</td><td dir="ltr">{conv(r.quality.allWon, r.quality.allLeads)}</td><td dir="ltr">{r.quality.avgDealValue === null ? "—" : `₪${r.quality.avgDealValue.toLocaleString(loc)}`}</td></tr>)}</tbody></table></div><p className="performance-caption">{t("המרה = ליד שהומר לעסקה או שיש לו עסקה שנסגרה. זמן תגובה נמדד עד ניסיון חיוג שבו המספר חויג בפועל.", "Conversion = a lead converted to a deal or with a closed deal. Response time is measured up to a dial attempt where the number was actually dialed.")}</p></section>}
      {data && <p className="performance-caption">{t("נתונים לתקופה:", "Data for period:")} {new Date(data.from).toLocaleDateString(loc)} – {new Date(data.to).toLocaleDateString(loc)} · {t("הסטטוס מציג זמינות נוכחית · מתעדכן בכל 30 שניות", "Status shows current availability · refreshes every 30 seconds")}</p>}
    </div>
    <SalesDiagnostics/>
    {selectedAgent && <AgentCallDrawer key={selectedAgent} agent={live.find(a=>a.id===selectedAgent) ?? { id:selectedAgent,fullName:data?.agents.find(a=>a.id===selectedAgent)?.fullName??t("נציג", "Agent"),status:"offline",sinceAt:new Date().toISOString(),call:null }} stale={stale} onClose={()=>setSelectedAgent(null)}/>}
  </div>;
}
