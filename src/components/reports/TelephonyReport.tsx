"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, ErrorState, Input, Select, Spinner, Stat, cx } from "@/components/ui";
import { formatDuration } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

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


/** Telephony reports for a period (agents / lists / sources) – formerly the "דוחות" tab of the live floor. */
export function TelephonyReport() {
  const t = useT();
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
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    tick();
    const i = setInterval(tick, 4000);
    const onVis = tick;
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(i); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  async function togglePause(scope: "business" | "list", paused: boolean, id?: string) {
    try {
      await api.post("/api/manager/pause", { scope, paused, listId: id });
      toast.success(paused ? t("החיוג הושהה", "Dialing paused") : t("החיוג חודש", "Dialing resumed"));
      load();
    } catch (e) { toast.error((e as Error).message); }
  }

  if (err && !data) return <ErrorState message={err} retry={load} />;
  if (!data) return <div className="flex justify-center p-10"><Spinner /></div>;
  const tot = data.totals;
  const names = Object.fromEntries(data.lists.map((l) => [l.id, l.name]));

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{t("דוחות לתקופה", "Period reports")}</h2>
        {data.telephony.simulation && <Badge tone="warn">{t("מצב הדמיה", "Simulation mode")}</Badge>}
        {data.dialingPaused ? (
          <Button size="sm" variant="good" onClick={() => togglePause("business", false)}>▶ {t("חדש חיוגים לכל העסק", "Resume dialing for the whole business")}</Button>
        ) : (
          <Button size="sm" variant="danger" onClick={() => togglePause("business", true)}>■ {t("עצור חיוגים חדשים (כל העסק)", "Stop new dialing (whole business)")}</Button>
        )}
        <div className="ms-auto flex flex-wrap gap-2 items-end">
          <Input label={t("מתאריך", "From")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" ltr />
          <Input label={t("עד תאריך", "To")} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" ltr />
          <Select label={t("רשימה", "List")} value={listId} onChange={(e) => setListId(e.target.value)} className="h-9 w-48"><option value="">{t("כל הרשימות", "All lists")}</option>{data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        </div>
      </div>

      {data.dialingPaused && <div className="rounded-lg bg-bad/10 text-bad text-sm p-3">{t("החיוג היוצא מושהה ברמת העסק. שיחות פעילות לא הופסקו; נציגים לא יכולים לחייג או למשוך לידים.", "Outbound dialing is paused for the business. Active calls were not stopped; agents cannot dial or pull leads.")}</div>}

      {data.alerts.length > 0 && (
        <ul className="space-y-1">
          {data.alerts.map((a, i) => <li key={i} className={cx("text-sm rounded-md px-3 py-2", a.severity === "bad" ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn")}>{a.text}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Stat label={t("ניסיונות חיוג", "Dial attempts")} value={tot.dials} sub={data.definitions.dials} />
        <Stat label={t("נענו", "Answered")} value={tot.connected} sub={data.definitions.connected} tone="good" />
        <Stat label={t("אנשי קשר ייחודיים", "Unique contacts")} value={tot.uniqueContacts} sub={data.definitions.uniqueContacts} />
        <Stat label={t("אחוז מענה", "Answer rate")} value={`${tot.connectRate}%`} sub={data.definitions.connectRate} />
        <Stat label={t("צלצול ממוצע", "Avg. ring")} value={formatDuration(tot.avgRingSeconds)} sub={data.definitions.avgRingSeconds} />
        <Stat label={t("שיחה ממוצעת", "Avg. call")} value={formatDuration(tot.avgTalkSeconds)} sub={data.definitions.avgTalkSeconds} />
        <Stat label={t("תיעוד ממוצע", "Avg. wrap-up")} value={formatDuration(tot.avgWrapUpSeconds)} sub={data.definitions.avgWrapUpSeconds} />
        <Stat label={t("בין שיחות", "Between calls")} value={formatDuration(tot.avgGapSeconds)} sub={data.definitions.avgGapSeconds} />
        <Stat label={t("מכירות", "Sales")} value={tot.sales} sub={data.definitions.sales} tone="good" />
        <Stat label={t("חזרות שנקבעו", "Callbacks scheduled")} value={tot.callbacks} tone="warn" />
        <Stat label={t("עמידה בחזרות", "Callback adherence")} value={tot.callbackAdherence?.rate == null ? "—" : `${tot.callbackAdherence.rate}%`} sub={data.definitions.callbackAdherence} />
        <Stat label={t("חזרות באיחור", "Overdue callbacks")} value={data.overdueTasks} tone={data.overdueTasks ? "bad" : undefined} />
        <Stat label={t("נכנסות / לא נענו", "Inbound / missed")} value={`${tot.inbound} / ${tot.inboundMissed}`} sub={data.definitions.inboundMissed} />
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {data.queues.map((q) => (
          <div key={q.id} className="bg-panel border border-line rounded-xl p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{q.name}</span>
              <div className="flex items-center gap-2">
                {q.isPaused && <Badge tone="bad">{t("מושהית", "Paused")}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => togglePause("list", !q.isPaused, q.id)}>{q.isPaused ? t("חדש", "Resume") : t("השהה", "Pause")}</Button>
              </div>
            </div>
            <p className="text-xs text-muted mt-1">
              {t("בתור עכשיו", "In queue now")} <b className="text-text tabular">{q.stats.dueNow}</b> {t("מתוך", "of")} <span className="tabular">{q.stats.total}</span> · {t("ממתינים לניסיון חוזר", "Awaiting retry")} {q.stats.unavailable.notDueYet as number} · {t("בטיפול", "In progress")} {q.stats.unavailable.inProgress as number} · {t("מוצו", "Exhausted")} {q.stats.unavailable.exhausted as number}
              {q.stats.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-1">{t("מחוץ לחלון", "Outside window")}</Badge>}
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-1 border-b border-line">
        {([["agents", "נציגים", "Agents"], ["lists", "לפי רשימה", "By list"], ["sources", "לפי מקור", "By source"]] as const).map(([k, v, en]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("h-9 px-4 text-sm border-b-2 -mb-px", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{t(v, en)}</button>
        ))}
      </div>

      {tab === "agents" && (
        <div className="bg-panel border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3">
              <tr>
                <th className="text-start px-3 h-9 font-medium">{t("נציג", "Agent")}</th>
                <th className="text-start px-3 font-medium"><span title={t("ניסיונות יוצאים שהספק יצר בטווח", "Outbound attempts created by the provider in the range")}>{t("יוצאות", "Outbound")}</span></th><th className="text-start px-3 font-medium">{t("ניסיונות (כולל נכנסות)", "Attempts (incl. inbound)")}</th><th className="text-start px-3 font-medium">{t("נענו", "Answered")}</th><th className="text-start px-3 font-medium">{t("% מענה", "Answer %")}</th><th className="text-start px-3 font-medium">{t("שיחה ממוצעת", "Avg. call")}</th><th className="text-start px-3 font-medium">{t("תיעוד ממוצע", "Avg. wrap-up")}</th><th className="text-start px-3 font-medium">{t("מכירות", "Sales")}</th><th className="text-start px-3 font-medium">{t("חזרות", "Callbacks")}</th><th className="text-start px-3 font-medium">{t("עמידה בחזרות", "Callback adherence")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.agents.map((a) => {
                const m = a.metrics;
                return (
                  <tr key={a.id}>
                    <td className="px-3 h-11"><p className="font-medium">{a.fullName}</p><p className="text-[11px] text-muted">{a.team?.name ?? (a.role === "manager" ? t("מנהל", "Manager") : "")}</p></td>
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
            <thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">{tab === "lists" ? t("רשימה", "List") : t("מקור", "Source")}</th><th className="text-start px-3 font-medium">{t("ניסיונות", "Attempts")}</th><th className="text-start px-3 font-medium">{t("נענו", "Answered")}</th><th className="text-start px-3 font-medium">{t("% מענה", "Answer %")}</th><th className="text-start px-3 font-medium">{t("ייחודיים", "Unique")}</th><th className="text-start px-3 font-medium">{t("שיחה ממוצעת", "Avg. call")}</th><th className="text-start px-3 font-medium">{t("מכירות", "Sales")}</th><th className="text-start px-3 font-medium">{t("חזרות", "Callbacks")}</th></tr></thead>
            <tbody className="divide-y divide-line">
              {Object.entries(tab === "lists" ? data.byList : data.bySource).map(([k, m]) => (
                <tr key={k}><td className="px-3 h-10">{tab === "lists" ? names[k] ?? k : k}</td><td className="px-3 tabular">{m.dials}</td><td className="px-3 tabular">{m.connected}</td><td className="px-3 tabular">{m.connectRate}%</td><td className="px-3 tabular">{m.uniqueContacts}</td><td className="px-3 tabular">{formatDuration(m.avgTalkSeconds)}</td><td className="px-3 tabular text-good">{m.sales}</td><td className="px-3 tabular">{m.callbacks}</td></tr>
              ))}
              {Object.keys(tab === "lists" ? data.byList : data.bySource).length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted">{t("אין נתונים בטווח", "No data in range")}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted">{t("כל מדד מוגדר במפורש (ראה tooltip). \"נענו\" נקבע לפי אישור ספק הטלפוניה. אין נתוני עלות טלפוניה או הכנסות במערכת, ולכן לא מוצגים ROI או הכנסות.", "Every metric is explicitly defined (see tooltip). \"Answered\" is determined by the telephony provider's confirmation. There is no telephony cost or revenue data in the system, so ROI and revenue are not shown.")}</p>
    </div>
  );
}
