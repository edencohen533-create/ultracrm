"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, ErrorState, Input, Select, Spinner, Stat, cx } from "@/components/ui";
import { formatDuration } from "@/lib/client/format";
import { LiveFloor } from "@/components/manager/LiveFloor";

interface Metrics { dials: number; connected: number; uniqueContacts: number; connectRate: number; talkSeconds: number; avgTalkSeconds: number; avgRingSeconds: number; avgWrapUpSeconds: number; avgGapSeconds: number; inbound: number; inboundMissed: number; sales: number; callbacks: number; outcomes: Record<string, number>; callbackAdherence?: { due: number; onTime: number; overdueOpen: number; rate: number | null } }
interface Agent { id: string; fullName: string; role: string; presence: string; displayPresence: string; presenceAt: string; team: { name: string } | null; session: { mode: string; status: string; dialsCount: number; list: { name: string } | null } | null; liveCall: { id: string; status: string; direction: string; toE164: string; createdAt: string; answeredAt: string | null; contact: { fullName: string } | null } | null; metrics: Metrics | null }
interface Dash {
  now: string; agents: Agent[]; totals: Metrics; byList: Record<string, Metrics>; bySource: Record<string, Metrics>;
  lists: Array<{ id: string; name: string; isActive: boolean; isPaused: boolean }>;
  queues: Array<{ id: string; name: string; isPaused: boolean; stats: { dueNow: number; total: number; unavailable: Record<string, number | boolean> } }>;
  alerts: Array<{ kind: string; severity: "warn" | "bad"; text: string }>; overdueTasks: number; dialingPaused: boolean;
  telephony: { simulation: boolean }; definitions: Record<string, string>;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function ManagerPage() {
  const [view, setView] = useState<"now" | "reports">("now");
  return (
    <div className="flex flex-col min-h-screen">
      <header className="px-5 pt-5 pb-3 flex flex-wrap items-center gap-3 border-b border-line">
        <h1 className="text-lg font-semibold">מוקד בזמן אמת</h1>
        <div className="flex rounded-lg border border-line overflow-hidden ms-2">
          <button onClick={() => setView("now")} className={cx("h-9 px-4 text-sm", view === "now" ? "bg-accent text-white" : "text-muted hover:text-text")}>עכשיו</button>
          <button onClick={() => setView("reports")} className={cx("h-9 px-4 text-sm", view === "reports" ? "bg-accent text-white" : "text-muted hover:text-text")}>דוחות</button>
        </div>
        <p className="text-xs text-muted">{view === "now" ? "מצב חי של המוקד ונתוני היום" : "נתונים לתקופה שנבחרה – ללא סטטוס נוכחי"}</p>
      </header>
      {view === "now" ? <LiveFloor /> : <ReportsView />}
    </div>
  );
}

function ReportsView() {
  const [data, setData] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState("");
  const [listId, setListId] = useState("");
  const [tab, setTab] = useState<"agents" | "lists" | "sources">("agents");

  const load = useCallback(async () => {
    try {
      const d = await api.get<Dash>(`/api/manager/dashboard${qs({ from: from ? new Date(from + "T00:00:00").toISOString() : "", to: to ? new Date(to + "T23:59:59").toISOString() : "", listId })}`);
      setData(d);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [from, to, listId]);

  useEffect(() => {
    load();
    const i = setInterval(load, 4000);
    return () => clearInterval(i);
  }, [load]);

  async function togglePause(scope: "business" | "list", paused: boolean, id?: string) {
    try {
      await api.post("/api/manager/pause", { scope, paused, listId: id });
      toast.success(paused ? "החיוג הושהה" : "החיוג חודש");
      load();
    } catch (e) { toast.error((e as Error).message); }
  }

  if (err && !data) return <ErrorState message={err} retry={load} />;
  if (!data) return <div className="flex justify-center p-10"><Spinner /></div>;
  const t = data.totals;
  const names = Object.fromEntries(data.lists.map((l) => [l.id, l.name]));

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">דוחות לתקופה</h2>
        {data.telephony.simulation && <Badge tone="warn">מצב הדמיה</Badge>}
        {data.dialingPaused ? (
          <Button size="sm" variant="good" onClick={() => togglePause("business", false)}>▶ חדש חיוגים לכל העסק</Button>
        ) : (
          <Button size="sm" variant="danger" onClick={() => togglePause("business", true)}>■ עצור חיוגים חדשים (כל העסק)</Button>
        )}
        <div className="ms-auto flex flex-wrap gap-2 items-end">
          <Input label="מתאריך" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" ltr />
          <Input label="עד תאריך" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" ltr />
          <Select label="רשימה" value={listId} onChange={(e) => setListId(e.target.value)} className="h-9 w-48"><option value="">כל הרשימות</option>{data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        </div>
      </div>

      {data.dialingPaused && <div className="rounded-lg bg-bad/10 text-bad text-sm p-3">החיוג היוצא מושהה ברמת העסק. שיחות פעילות לא הופסקו; נציגים לא יכולים לחייג או למשוך לידים.</div>}

      {data.alerts.length > 0 && (
        <ul className="space-y-1">
          {data.alerts.map((a, i) => <li key={i} className={cx("text-sm rounded-md px-3 py-2", a.severity === "bad" ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn")}>{a.text}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Stat label="ניסיונות חיוג" value={t.dials} sub={data.definitions.dials} />
        <Stat label="נענו" value={t.connected} sub={data.definitions.connected} tone="good" />
        <Stat label="אנשי קשר ייחודיים" value={t.uniqueContacts} sub={data.definitions.uniqueContacts} />
        <Stat label="אחוז מענה" value={`${t.connectRate}%`} sub={data.definitions.connectRate} />
        <Stat label="צלצול ממוצע" value={formatDuration(t.avgRingSeconds)} sub={data.definitions.avgRingSeconds} />
        <Stat label="שיחה ממוצעת" value={formatDuration(t.avgTalkSeconds)} sub={data.definitions.avgTalkSeconds} />
        <Stat label="תיעוד ממוצע" value={formatDuration(t.avgWrapUpSeconds)} sub={data.definitions.avgWrapUpSeconds} />
        <Stat label="בין שיחות" value={formatDuration(t.avgGapSeconds)} sub={data.definitions.avgGapSeconds} />
        <Stat label="מכירות" value={t.sales} sub={data.definitions.sales} tone="good" />
        <Stat label="חזרות שנקבעו" value={t.callbacks} tone="warn" />
        <Stat label="עמידה בחזרות" value={t.callbackAdherence?.rate == null ? "—" : `${t.callbackAdherence.rate}%`} sub={data.definitions.callbackAdherence} />
        <Stat label="חזרות באיחור" value={data.overdueTasks} tone={data.overdueTasks ? "bad" : undefined} />
        <Stat label="נכנסות / לא נענו" value={`${t.inbound} / ${t.inboundMissed}`} sub={data.definitions.inboundMissed} />
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {data.queues.map((q) => (
          <div key={q.id} className="bg-panel border border-line rounded-xl p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{q.name}</span>
              <div className="flex items-center gap-2">
                {q.isPaused && <Badge tone="bad">מושהית</Badge>}
                <Button size="sm" variant="ghost" onClick={() => togglePause("list", !q.isPaused, q.id)}>{q.isPaused ? "חדש" : "השהה"}</Button>
              </div>
            </div>
            <p className="text-xs text-muted mt-1">
              בתור עכשיו <b className="text-text tabular">{q.stats.dueNow}</b> מתוך <span className="tabular">{q.stats.total}</span> · ממתינים לניסיון חוזר {q.stats.unavailable.notDueYet as number} · בטיפול {q.stats.unavailable.inProgress as number} · מוצו {q.stats.unavailable.exhausted as number}
              {q.stats.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-1">מחוץ לחלון</Badge>}
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-1 border-b border-line">
        {([["agents", "נציגים"], ["lists", "לפי רשימה"], ["sources", "לפי מקור"]] as const).map(([k, v]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("h-9 px-4 text-sm border-b-2 -mb-px", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{v}</button>
        ))}
      </div>

      {tab === "agents" && (
        <div className="bg-panel border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3">
              <tr>
                <th className="text-start px-3 h-9 font-medium">נציג</th>
                <th className="text-start px-3 font-medium"><span title="ניסיונות יוצאים שהספק יצר בטווח">יוצאות</span></th><th className="text-start px-3 font-medium">ניסיונות (כולל נכנסות)</th><th className="text-start px-3 font-medium">נענו</th><th className="text-start px-3 font-medium">% מענה</th><th className="text-start px-3 font-medium">שיחה ממוצעת</th><th className="text-start px-3 font-medium">תיעוד ממוצע</th><th className="text-start px-3 font-medium">מכירות</th><th className="text-start px-3 font-medium">חזרות</th><th className="text-start px-3 font-medium">עמידה בחזרות</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.agents.map((a) => {
                const m = a.metrics;
                return (
                  <tr key={a.id}>
                    <td className="px-3 h-11"><p className="font-medium">{a.fullName}</p><p className="text-[11px] text-muted">{a.team?.name ?? (a.role === "manager" ? "מנהל" : "")}</p></td>
                    <td className="px-3 tabular">{(m as unknown as { outboundAttempts?: number })?.outboundAttempts ?? 0}</td>
                    <td className="px-3 tabular">{m?.dials ?? 0}</td>
                    <td className="px-3 tabular">{m?.connected ?? 0}</td>
                    <td className="px-3 tabular">{m ? `${m.connectRate}%` : "0%"}</td>
                    <td className="px-3 tabular">{formatDuration(m?.avgTalkSeconds ?? 0)}</td>
                    <td className="px-3 tabular">{formatDuration(m?.avgWrapUpSeconds ?? 0)}</td>
                    <td className="px-3 tabular text-good">{m?.sales ?? 0}</td>
                    <td className="px-3 tabular">{m?.callbacks ?? 0}</td>
                    <td className="px-3 tabular">{m?.callbackAdherence?.rate == null ? "—" : `${m.callbackAdherence.rate}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(tab === "lists" || tab === "sources") && (
        <div className="bg-panel border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">{tab === "lists" ? "רשימה" : "מקור"}</th><th className="text-start px-3 font-medium">ניסיונות</th><th className="text-start px-3 font-medium">נענו</th><th className="text-start px-3 font-medium">% מענה</th><th className="text-start px-3 font-medium">ייחודיים</th><th className="text-start px-3 font-medium">שיחה ממוצעת</th><th className="text-start px-3 font-medium">מכירות</th><th className="text-start px-3 font-medium">חזרות</th></tr></thead>
            <tbody className="divide-y divide-line">
              {Object.entries(tab === "lists" ? data.byList : data.bySource).map(([k, m]) => (
                <tr key={k}><td className="px-3 h-10">{tab === "lists" ? names[k] ?? k : k}</td><td className="px-3 tabular">{m.dials}</td><td className="px-3 tabular">{m.connected}</td><td className="px-3 tabular">{m.connectRate}%</td><td className="px-3 tabular">{m.uniqueContacts}</td><td className="px-3 tabular">{formatDuration(m.avgTalkSeconds)}</td><td className="px-3 tabular text-good">{m.sales}</td><td className="px-3 tabular">{m.callbacks}</td></tr>
              ))}
              {Object.keys(tab === "lists" ? data.byList : data.bySource).length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted">אין נתונים בטווח</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted">כל מדד מוגדר במפורש (ראה tooltip). &quot;נענו&quot; נקבע לפי אישור ספק הטלפוניה. אין נתוני עלות טלפוניה או הכנסות במערכת, ולכן לא מוצגים ROI או הכנסות.</p>
    </div>
  );
}
