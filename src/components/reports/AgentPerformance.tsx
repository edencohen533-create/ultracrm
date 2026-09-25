"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Download, Info, Users } from "lucide-react";
import { AgentCallDrawer, LIVE_LABEL, type LiveAgent } from "./AgentCallDrawer";
import { api, qs } from "@/lib/client/api";
import { Spinner } from "@/components/ui";
import { PRESENCE_LABEL } from "@/lib/client/format";

interface Agent { id: string; fullName: string; presence: string; presenceAt: string; outbound: number; answered: number; handled: number; manual: number; closed: number; dialSeconds: number; talkSeconds: number }
interface Report { rows: Agent[]; totals: Pick<Agent, "outbound" | "answered" | "handled" | "closed" | "talkSeconds">; agents: { id: string; fullName: string }[]; from: string; to: string; timezone: string }
const duration = (s: number) => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), Math.floor(s % 60)].map(v => String(v).padStart(2, "0")).join(":");
const rate = (n: number, d: number) => d ? Math.round(n / d * 100) : 0;
type Sort = "fullName" | "outbound" | "handled" | "closed" | "dialSeconds" | "talkSeconds" | "total";
export function AgentPerformance() {
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
    const rowsCsv = [["שם מלא","סטטוס","שיחות יוצאות","נוהלו","סגורות","זמן בחיוג","זמן בשיחה","זמן כולל"], ...rows.map(r => [r.fullName,PRESENCE_LABEL[r.presence] ?? r.presence,String(r.outbound),String(r.handled),String(r.closed),duration(r.dialSeconds),duration(r.talkSeconds),duration(r.dialSeconds+r.talkSeconds)])];
    const csv = rowsCsv.map(r => r.map(v => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"})); const link = document.createElement("a"); link.href=url;link.download="agent-performance.csv";link.click();URL.revokeObjectURL(url);
  }
  const t = data?.totals;
  const cards = [
    { label: "שיחות יוצאות", value: t?.outbound ?? 0, tone: "slate", hint: "ניסיונות חיוג יוצאים שנוצרו אצל ספק הטלפוניה בטווח" },
    { label: "שיחות שנענו", value: t?.answered ?? 0, tone: "orange", percent: rate(t?.answered ?? 0,t?.outbound ?? 0), hint: "שיחות יוצאות עם אישור מענה מהספק" },
    { label: "שיחות שנוהלו", value: t?.handled ?? 0, tone: "blue", percent: rate(t?.handled ?? 0,t?.answered ?? 0), hint: "שיחות יוצאות שנענו ונשמרה עבורן תוצאת שיחה" },
    { label: "עסקאות סגורות", value: t?.closed ?? 0, tone: "green", percent: rate(t?.closed ?? 0,t?.handled ?? 0), hint: "עסקאות של הנציגים שנסגרו בהצלחה בטווח; האחוז ביחס לשיחות שנוהלו" },
    { label: "סה״כ זמן בשיחה", value: duration(t?.talkSeconds ?? 0), tone: "dark", hint: "זמן שיחה מצטבר בשיחות יוצאות שנענו" },
  ];
  const head = (key: Sort, title: string) => <button onClick={() => sorting(key)}>{title}{sort.key === key ? sort.asc ? <ArrowUp size={16}/> : <ArrowDown size={16}/> : null}</button>;
  return <div className="performance-page" data-testid="agent-performance"><header className="performance-header"><h1>ביצועי נציגים</h1><div className="performance-filters"><label><CalendarDays size={17}/><select aria-label="תקופת ביצועי נציגים" value={period} onChange={e => setPeriod(e.target.value)}><option value="today">היום</option><option value="week">7 ימים אחרונים</option><option value="month">החודש</option><option value="custom">טווח מותאם</option></select></label><label><Users size={19}/><select aria-label="סינון נציגים" value={agent} onChange={e => setAgent(e.target.value)}><option value="">כל הנציגים</option>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label><button title="ייצוא CSV" aria-label="ייצוא ביצועי נציגים" disabled={!data} onClick={download}><Download size={17}/></button></div></header>
    {period === "custom" && <div className="performance-dates"><label>מתאריך <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}/></label><label>עד תאריך <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}/></label></div>}
    <div className="performance-content">{error && <div role="alert" className="lead-error">{error}<button onClick={load}>נסה שוב</button></div>}
      <section className="performance-funnel" aria-label="סיכום ביצועים">{cards.map(c => <article className={`performance-step ${c.tone}`} key={c.label} title={c.hint}><div><span>{c.label}</span>{c.tone !== "slate" && c.tone !== "dark" && <Info size={13}/>}</div><strong dir="ltr">{data ? c.value : "—"}</strong>{c.percent !== undefined && <small>{c.percent}%</small>}</article>)}</section>
      <section className="performance-table-card"><h2>נציגים</h2>{!data && !error ? <div className="p-12 flex justify-center"><Spinner/></div> : <div className="performance-table-scroll"><table><thead><tr><th>{head("fullName","שם מלא")}</th><th>סטטוס</th><th>{head("outbound","שיחות יוצאות")}</th><th>{head("handled","נוהלו")}</th><th>{head("closed","סגורות")}</th><th>{head("dialSeconds","סה״כ זמן בחיוג")}</th><th>{head("talkSeconds","סה״כ זמן בשיחה")}</th><th>{head("total","סה״כ זמן בחיוג + בשיחה")}</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td><button className={selectedAgent === r.id ? "performance-agent selected" : "performance-agent"} onClick={() => setSelectedAgent(r.id)}>{r.fullName}</button></td><td>{(() => { const current=live.find(a=>a.id===r.id); const status=current?.status??r.presence; return <><span className={`performance-presence ${status === "offline" || stale ? "offline" : "online"}`}>{stale ? "מתחבר…" : LIVE_LABEL[status] ?? PRESENCE_LABEL[status] ?? status}</span>{current && !stale && <small className="performance-since"> ({duration(Math.max(0,Math.floor((liveNow-new Date(current.sinceAt).getTime())/1000)))})</small>}</>; })()}</td><td>{r.outbound}{r.manual > 0 && <span className="performance-manual"> (ידני: {rate(r.manual,r.outbound)}%)</span>}</td><td>{r.handled}</td><td>{r.closed}</td><td dir="ltr">{duration(r.dialSeconds)}</td><td dir="ltr">{duration(r.talkSeconds)}</td><td dir="ltr">{duration(r.dialSeconds+r.talkSeconds)}</td></tr>)}</tbody></table>{data && !rows.length && <div className="p-10 text-center text-muted">אין נציגים התואמים לסינון</div>}</div>}</section>
      {data && <p className="performance-caption">נתונים לתקופה: {new Date(data.from).toLocaleDateString("he-IL")} – {new Date(data.to).toLocaleDateString("he-IL")} · הסטטוס מציג זמינות נוכחית · מתעדכן בכל 30 שניות</p>}
    </div>
    {selectedAgent && <AgentCallDrawer key={selectedAgent} agent={live.find(a=>a.id===selectedAgent) ?? { id:selectedAgent,fullName:data?.agents.find(a=>a.id===selectedAgent)?.fullName??"נציג",status:"offline",sinceAt:new Date().toISOString(),call:null }} stale={stale} onClose={()=>setSelectedAgent(null)}/>}
  </div>;
}
