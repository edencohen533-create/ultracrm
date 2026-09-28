"use client";

/**
 * "עכשיו" – live floor. Polls /api/manager/live every 1.5s (existing realtime
 * infrastructure is server polling). Rows are merged by agent id so the table
 * never re-orders under the cursor; timers run locally from server timestamps
 * with the server/client clock offset applied. Stale data is flagged, never
 * shown as live.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, Input, Phone, Select, cx } from "@/components/ui";
import { MODE_LABEL, formatDuration, formatPhone } from "@/lib/client/format";
import { MonitorPanel } from "./MonitorPanel";
import { useT } from "@/components/i18n/LangProvider";

type LiveStatus = "available" | "dialing" | "ringing" | "in_call" | "on_hold" | "wrap_up" | "break" | "idle" | "offline" | "unknown";
interface Metrics { outboundAttempts: number; outboundAnswered: number; outboundAnswerRate: number; dialSeconds: number; talkSeconds: number; avgTalkSeconds: number; sales: number; connected: number; dials: number }
interface Row {
  id: string; fullName: string; role: string; team: { id: string; name: string } | null; connected: boolean; lastSeenAt: string | null; presence: string; status: LiveStatus; sinceAt: string;
  session: { mode: string; status: string; list: { id: string; name: string } | null } | null;
  call: { id: string; status: string; direction: string; toE164: string; contact: { id: string; fullName: string } | null; list: { id: string; name: string } | null; createdAt: string; ringingAt: string | null; answeredAt: string | null; canMonitor: boolean; monitors: Array<{ id: string; managerId: string; mode: string; status: string; manager: { fullName: string } }> } | null;
  today: Metrics | null;
}
interface Live { serverNow: string; rows: Row[]; counts: Record<string, number>; today: Metrics & { failedBeforeProvider: number }; telephony: { simulation: boolean }; teams: Array<{ id: string; name: string }>; dialingPaused: boolean }

const STATUS: Record<LiveStatus, { label: string; en: string; tone: "neutral" | "good" | "warn" | "info" | "bad" | "accent"; icon: string }> = {
  available: { label: "זמין", en: "Available", tone: "info", icon: "●" },
  dialing: { label: "מחייג", en: "Dialing", tone: "warn", icon: "↗" },
  ringing: { label: "מצלצל אצל הלקוח", en: "Ringing customer", tone: "warn", icon: "☎" },
  in_call: { label: "בשיחה", en: "In call", tone: "good", icon: "▶" },
  on_hold: { label: "בהחזקה", en: "On hold", tone: "warn", icon: "❚❚" },
  wrap_up: { label: "בתיעוד", en: "Wrap-up", tone: "accent", icon: "✎" },
  break: { label: "בהפסקה", en: "On break", tone: "neutral", icon: "☕" },
  idle: { label: "מחובר, ללא סשן", en: "Online, no session", tone: "neutral", icon: "◌" },
  offline: { label: "מנותק", en: "Offline", tone: "neutral", icon: "○" },
  unknown: { label: "לא ידוע – אובדן חיבור", en: "Unknown – connection lost", tone: "bad", icon: "?" },
};

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return <span title={text} className="cursor-help border-b border-dotted border-muted/50">{children}</span>;
}

export function LiveFloor() {
  const t = useT();
  const { supervisor, phone } = useDialer();
  const [live, setLive] = useState<Live | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [offset, setOffset] = useState(0); // serverNow - clientNow
  const [now, setNow] = useState(() => Date.now());
  const [q, setQ] = useState("");
  const [team, setTeam] = useState("");
  const [statusF, setStatusF] = useState("");
  const [sort, setSort] = useState<"name" | "status" | "attempts" | "talk">("name");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [panelFor, setPanelFor] = useState<Row | null>(null);
  const [showCols, setShowCols] = useState(false);
  const rowsRef = useRef<Map<string, Row>>(new Map());
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const t0 = Date.now();
    try {
      const d = await api.get<Live>("/api/manager/live");
      // Merge by id (no full re-render of the row set; stable order kept by the sort below).
      const next = new Map(rowsRef.current);
      for (const r of d.rows) next.set(r.id, r);
      for (const id of [...next.keys()]) if (!d.rows.some((r) => r.id === id)) next.delete(id);
      rowsRef.current = next;
      setLive({ ...d, rows: [...next.values()] });
      setOffset(new Date(d.serverNow).getTime() - (t0 + (Date.now() - t0) / 2));
      setLastOk(Date.now());
      setFailures(0);
    } catch {
      setFailures((f) => f + 1);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    poll();
    const i = setInterval(poll, 1500);
    const tk = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(i); clearInterval(tk); };
  }, [poll]);

  const serverNow = now + offset;
  const conn: { label: string; tone: "good" | "warn" | "bad" } = !lastOk ? { label: t("מתחבר…", "Connecting…"), tone: "warn" } : failures >= 3 || now - lastOk > 10_000 ? { label: t("הנתונים אינם עדכניים", "Data is not up to date"), tone: "bad" } : failures > 0 ? { label: t("מתחבר מחדש…", "Reconnecting…"), tone: "warn" } : { label: t("מתעדכן בזמן אמת", "Updating in real time"), tone: "good" };

  const rows = useMemo(() => {
    if (!live) return [];
    const order: LiveStatus[] = ["in_call", "on_hold", "ringing", "dialing", "wrap_up", "available", "break", "idle", "unknown", "offline"];
    return live.rows
      .filter((r) => (!q || r.fullName.includes(q) || r.call?.contact?.fullName.includes(q) || r.call?.toE164.includes(q.replace(/\D/g, ""))) && (!team || r.team?.id === team) && (!statusF || r.status === statusF))
      .sort((a, b) => sort === "name" ? a.fullName.localeCompare(b.fullName, "he") : sort === "status" ? order.indexOf(a.status) - order.indexOf(b.status) || a.fullName.localeCompare(b.fullName, "he") : sort === "attempts" ? (b.today?.outboundAttempts ?? 0) - (a.today?.outboundAttempts ?? 0) : (b.today?.talkSeconds ?? 0) - (a.today?.talkSeconds ?? 0));
  }, [live, q, team, statusF, sort]);

  async function listen(r: Row) {
    if (!r.call?.canMonitor) return;
    try {
      await supervisor.start(r.call.id);
      setPanelFor(r);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const panelRow = panelFor ? live?.rows.find((x) => x.id === panelFor.id) ?? panelFor : null;
  const panelCallEnded = Boolean(panelRow && (!panelRow.call || panelRow.call.id !== supervisor.monitor?.callId));

  if (!live) return <div className="p-10 text-center text-muted">{t("טוען מצב מוקד…", "Loading floor status…")}</div>;
  const td = live.today;
  const locale = t.lang === "en" ? "en-GB" : "he-IL";
  const stale = conn.tone === "bad";

  return (
    <div className="flex min-h-0 flex-1">
      <div className={cx("flex-1 min-w-0 p-5 space-y-4", stale && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={conn.tone} dot>{conn.label}</Badge>
          {lastOk && <span className="text-xs text-muted">{t("עדכון אחרון", "Last update")} {new Date(lastOk).toLocaleTimeString(locale)}</span>}
          {live.telephony.simulation && <Badge tone="warn">{t("מצב הדמיה – אין אודיו אמיתי", "Simulation mode – no real audio")}</Badge>}
          {phone.status !== "ready" && phone.status !== "simulation" && <Badge tone="bad">{t("הדפדפן שלך לא רשום לטלפוניה – האזנה לא זמינה", "Your browser is not registered for telephony – listening unavailable")}</Badge>}
          <div className="ms-auto">
            {live.dialingPaused ? (
              <Button size="sm" variant="good" onClick={() => api.post("/api/manager/pause", { scope: "business", paused: false }).then(() => { toast.success(t("החיוג חודש", "Dialing resumed")); poll(); }).catch((e) => toast.error(e.message))}>{t("▶ חדש חיוגים לכל העסק", "▶ Resume dialing for the whole business")}</Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => api.post("/api/manager/pause", { scope: "business", paused: true }).then(() => { toast.success(t("החיוג הושהה", "Dialing paused")); poll(); }).catch((e) => toast.error(e.message))}>{t("■ עצור חיוגים חדשים (כל העסק)", "■ Stop new dials (whole business)")}</Button>
            )}
          </div>
        </div>
        {live.dialingPaused && <div className="rounded-lg bg-bad/10 text-bad text-sm p-3">{t("החיוג היוצא מושהה ברמת העסק. שיחות פעילות לא הופסקו; נציגים לא יכולים לחייג או למשוך לידים.", "Outbound dialing is paused for the business. Active calls were not stopped; agents can't dial or pull leads.")}</div>}

        <section>
          <h2 className="text-xs font-semibold text-muted mb-2">{t("מצב המוקד כרגע", "Current floor status")}</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {([["in_call", t("בשיחה", "In call"), t("נציגים שהלקוח ענה להם וכרגע מדברים", "Agents whose customer answered and are talking now")], ["dialing", t("מחייגים / ממתינים למענה", "Dialing / awaiting answer"), t("leg הנציג מחובר או הלקוח מצלצל, טרם ענה", "Agent leg connected or customer ringing, not answered yet")], ["available", t("זמינים", "Available"), t("מחוברים, לא בשיחה ולא בתיעוד", "Online, not in a call and not in wrap-up")], ["wrap_up", t("בתיעוד", "Wrap-up"), t("השיחה הסתיימה וטרם נשמרה תוצאה", "Call ended and no outcome saved yet")], ["break", t("בהפסקה", "On break"), t("סשן מושהה", "Session paused")]] as const).map(([k, label, tip]) => (
              <div key={k} className={cx("rounded-lg border px-3 py-2 h-16 flex flex-col justify-center", k === "in_call" && live.counts[k] ? "border-good/40 bg-good/5" : "border-line bg-panel")}>
                <p className="text-[11px] text-muted"><Tip text={tip}>{label}</Tip></p>
                <p className="text-2xl font-semibold tabular leading-tight">{live.counts[k]}</p>
              </div>
            ))}
          </div>
          {(live.counts.unknown > 0 || live.counts.offline > 0 || live.counts.idle > 0) && <p className="text-[11px] text-muted mt-1">{t("מחוברים ללא סשן", "Online without session")} {live.counts.idle} · {t("מנותקים", "Offline")} {live.counts.offline} · {t("לא ידוע (אובדן חיבור)", "Unknown (connection lost)")} {live.counts.unknown}</p>}
        </section>

        <section>
          <h2 className="text-xs font-semibold text-muted mb-2">{t("ביצועי היום", "Today's performance")}</h2>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            {[
              [t("שיחות יוצאות", "Outbound calls"), td.outboundAttempts, t("ניסיונות חיוג יוצאים שהספק יצר (agent leg קיים). לא נספרות לחיצות שנכשלו לפני יצירת שיחה.", "Outbound dial attempts created by the provider (agent leg exists). Clicks that failed before a call was created are not counted.")],
              [t("נכשלו לפני יצירה", "Failed before creation"), td.failedBeforeProvider, t("ניסיונות שנכשלו אצל הספק לפני שנוצרה שיחה – מוצגים בנפרד", "Attempts that failed at the provider before a call was created – shown separately")],
              [t("יוצאות שנענו", "Outbound answered"), td.outboundAnswered, t("שיחות יוצאות שהספק אישר שהלקוח ענה", "Outbound calls the provider confirmed the customer answered")],
              [t("שיעור מענה", "Answer rate"), `${td.outboundAnswerRate}%`, t("יוצאות שנענו ÷ שיחות יוצאות (אותו טווח)", "Outbound answered ÷ outbound calls (same range)")],
              [t("עסקאות", "Deals"), td.sales, t("תוצאת 'בוצעה מכירה' שנשמרה על ידי הנציג (מקור המכירות במערכת)", "'Sale made' outcome saved by the agent (the system's source of sales)")],
              [t("זמן שיחה מצטבר", "Total talk time"), formatDuration(td.talkSeconds), t("סכום זמן שיחה ממענה עד ניתוק. זמן חיוג/צלצול נמדד בנפרד", "Sum of talk time from answer to hang-up. Dial/ring time is measured separately")],
              [t("זמן שיחה ממוצע", "Average talk time"), formatDuration(td.avgTalkSeconds), t("זמן שיחה מצטבר ÷ שיחות שנענו", "Total talk time ÷ answered calls")],
              [t("זמן חיוג מצטבר", "Total dial time"), formatDuration(td.dialSeconds), t("מיצירת השיחה עד מענה (או ניתוק) – נפרד מזמן השיחה", "From call creation to answer (or hang-up) – separate from talk time")],
            ].map(([label, val, tip]) => (
              <div key={label as string} className="rounded-lg border border-line bg-panel px-3 py-2 h-16 flex flex-col justify-center">
                <p className="text-[11px] text-muted truncate"><Tip text={tip as string}>{label as string}</Tip></p>
                <p className="text-xl font-semibold tabular leading-tight">{val as string}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-2 items-center">
          <Input placeholder={t("חיפוש נציג / לקוח / טלפון", "Search agent / customer / phone")} value={q} onChange={(e) => setQ(e.target.value)} className="w-60 h-9" />
          <Select value={team} onChange={(e) => setTeam(e.target.value)} className="h-9 w-40"><option value="">{t("כל הצוותים", "All teams")}</option>{live.teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</Select>
          <Select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="h-9 w-44"><option value="">{t("כל הסטטוסים", "All statuses")}</option>{(Object.keys(STATUS) as LiveStatus[]).map((k) => <option key={k} value={k}>{t(STATUS[k].label, STATUS[k].en)}</option>)}</Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="h-9 w-40"><option value="name">{t("מיון: שם", "Sort: Name")}</option><option value="status">{t("מיון: סטטוס", "Sort: Status")}</option><option value="attempts">{t("מיון: שיחות יוצאות", "Sort: Outbound calls")}</option><option value="talk">{t("מיון: זמן שיחה", "Sort: Talk time")}</option></Select>
          <button onClick={() => setShowCols((s) => !s)} className="text-xs text-muted hover:text-text ms-auto">{showCols ? t("פחות עמודות", "Fewer columns") : t("עוד עמודות", "More columns")}</button>
        </div>

        <div className="bg-panel border border-line rounded-xl overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-panel sticky top-0 z-10 shadow-[0_1px_0_0_var(--line)]">
              <tr>
                <th className="text-start px-3 h-9 font-medium">{t("נציג", "Agent")}</th>
                <th className="text-start px-3 font-medium">{t("סטטוס", "Status")}</th>
                <th className="text-start px-3 font-medium">{t("לקוח", "Customer")}</th>
                <th className="text-start px-3 font-medium">{t("משך", "Duration")}</th>
                <th className="text-start px-3 font-medium">{t("רשימה", "List")}</th>
                <th className="text-start px-3 font-medium"><Tip text={t("ניסיונות יוצאים שהספק יצר היום", "Outbound attempts created by the provider today")}>{t("יוצאות", "Outbound")}</Tip></th>
                <th className="text-start px-3 font-medium"><Tip text={t("יוצאות שנענו ÷ יוצאות", "Outbound answered ÷ outbound")}>{t("נענו", "Answered")}</Tip></th>
                {showCols && <><th className="text-start px-3 font-medium">{t("עסקאות", "Deals")}</th><th className="text-start px-3 font-medium">{t("זמן שיחה", "Talk time")}</th><th className="text-start px-3 font-medium">{t("זמן חיוג", "Dial time")}</th></>}
                <th className="text-start px-3 font-medium">{t("פעולות", "Actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const st = STATUS[r.status];
                const since = Math.max(0, Math.round((serverNow - new Date(r.sinceAt).getTime()) / 1000));
                const c = r.call;
                const me = c?.monitors.find((m) => m.managerId === supervisor.monitor?.managerId);
                return (
                  <FragmentRow key={r.id}>
                    <tr className={cx("hover:bg-white/3", r.status === "in_call" && "bg-good/5")}>
                      <td className="px-3 h-12">
                        <div className="flex items-center gap-2">
                          <span className="w-8 h-8 rounded-full bg-accent/30 text-accent underline text-xs font-semibold flex items-center justify-center shrink-0">{r.fullName.split(" ").map((p) => p[0]).slice(0, 2).join("")}</span>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{r.fullName}</p>
                            <p className="text-[11px] text-muted truncate">{r.team?.name ?? (r.role === "manager" ? t("מנהל", "Manager") : "")}{!r.connected && r.call ? t(" · דפדפן מנותק, השיחה חיה אצל הספק", " · Browser disconnected, call is live at the provider") : ""}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3">
                        <Badge tone={st.tone}><span aria-hidden>{st.icon}</span> {t(st.label, st.en)} · <span className="tabular">{formatDuration(since)}</span></Badge>
                        {c && r.status !== "in_call" && <p className="text-[11px] text-muted mt-0.5">{c.direction === "inbound" ? t("נכנסת", "Inbound") : t("יוצאת", "Outbound")}</p>}
                      </td>
                      <td className="px-3">{c ? <div className="min-w-0"><p className="truncate">{c.contact ? <Link href={`/contacts/${c.contact.id}`} className="hover:underline">{c.contact.fullName}</Link> : t("לא מזוהה", "Unknown")}</p><Phone value={formatPhone(c.toE164)} className="text-[11px] text-muted" /><span className="text-[11px] text-muted ms-1">{c.direction === "inbound" ? t("↙ נכנסת", "↙ Inbound") : t("↗ יוצאת", "↗ Outbound")}</span></div> : <span className="text-muted">—</span>}</td>
                      <td className="px-3 tabular">{c?.answeredAt ? formatDuration(Math.max(0, Math.round((serverNow - new Date(c.answeredAt).getTime()) / 1000))) : c ? <span className="text-muted text-xs">{t("צלצול", "Ringing")} {formatDuration(Math.max(0, Math.round((serverNow - new Date(c.ringingAt ?? c.createdAt).getTime()) / 1000)))}</span> : "—"}</td>
                      <td className="px-3 text-xs text-muted">{c?.list?.name ?? r.session?.list?.name ?? (r.session ? MODE_LABEL[r.session.mode] : "—")}</td>
                      <td className="px-3 tabular">{r.today?.outboundAttempts ?? 0}</td>
                      <td className="px-3 tabular">{r.today?.outboundAnswered ?? 0} <span className="text-muted text-xs">({r.today?.outboundAnswerRate ?? 0}%)</span></td>
                      {showCols && <><td className="px-3 tabular text-good">{r.today?.sales ?? 0}</td><td className="px-3 tabular">{formatDuration(r.today?.talkSeconds ?? 0)}</td><td className="px-3 tabular">{formatDuration(r.today?.dialSeconds ?? 0)}</td></>}
                      <td className="px-3">
                        <div className="flex flex-wrap items-center gap-1 max-w-[260px]">
                          {c?.canMonitor && (
                            <>
                              <Button size="sm" variant={me ? "good" : "secondary"} onClick={() => (me ? setPanelFor(r) : listen(r))} title={t("האזנה – שומע את שני הצדדים, אף אחד לא שומע אותך", "Listen – hear both sides, nobody hears you")}>{me ? t("מחובר", "Connected") : t("האזנה", "Listen")}</Button>
                              <Button size="sm" variant="ghost" onClick={async () => { if (!me) await listen(r); else setPanelFor(r); }} title={t("לחישה – פתח את לוח ההאזנה ולחץ והחזק כדי לדבר לנציג בלבד", "Whisper – open the monitor panel and press and hold to speak to the agent only")}>{t("לחישה", "Whisper")}</Button>
                            </>
                          )}
                          {c && !c.canMonitor && c.status !== "answered" && <span className="text-[11px] text-muted">{t("ניתן להצטרף אחרי מענה", "Can join after answer")}</span>}
                          {c?.contact && <Link href={`/contacts/${c.contact.id}`}><Button size="sm" variant="ghost">{t("פתיחת לקוח", "Open customer")}</Button></Link>}
                          {c && <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>{t("פרטי שיחה", "Call details")}</Button>}
                        </div>
                        {c && c.monitors.length > 0 && <p className="text-[11px] text-warn mt-0.5">{c.monitors.map((m) => `${m.manager.fullName} (${m.status === "whispering" ? t("לוחש", "whispering") : m.status === "listening" ? t("מאזין", "listening") : t("מתחבר", "connecting")})`).join(", ")}</p>}
                      </td>
                    </tr>
                    {expanded === r.id && c && (
                      <tr className="bg-white/3"><td colSpan={showCols ? 11 : 8} className="px-4 py-2 text-xs text-muted">
                        {t("מזהה שיחה", "Call ID")} <span className="ltr">{c.id}</span> · {t("מצב ספק:", "Provider status:")} {c.status} · {t("נוצרה", "Created")} {new Date(c.createdAt).toLocaleTimeString(locale)}{c.ringingAt ? ` · ${t("צלצול", "Ringing")} ${new Date(c.ringingAt).toLocaleTimeString(locale)}` : ""}{c.answeredAt ? ` · ${t("מענה", "Answered")} ${new Date(c.answeredAt).toLocaleTimeString(locale)}` : ""} · {r.connected ? t("דפדפן מחובר", "Browser connected") : t("דפדפן מנותק", "Browser disconnected")} · {t("זמינות:", "Presence:")} {r.presence}
                      </td></tr>
                    )}
                  </FragmentRow>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-muted">{t("אין נציגים תואמים", "No matching agents")}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {panelRow && supervisor.monitor && (
        <MonitorPanel
          onClose={() => setPanelFor(null)}
          agentName={panelRow.fullName}
          contactName={panelRow.call?.contact?.fullName ?? formatPhone(panelRow.call?.toE164 ?? supervisor.monitor.call?.toE164 ?? "")}
          callAnsweredAt={panelRow.call?.answeredAt ?? supervisor.monitor.call?.answeredAt ?? null}
          callEnded={panelCallEnded}
          onOpenContact={panelRow.call?.contact ? () => window.open(`/contacts/${panelRow.call!.contact!.id}`, "_blank") : undefined}
        />
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
