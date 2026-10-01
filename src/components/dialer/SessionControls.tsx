"use client";

import { useEffect, useState } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, Select, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import { MODE_LABEL } from "@/lib/client/format";
import type { DialMode } from "@/lib/client/types";
import { useT } from "@/components/i18n/LangProvider";

interface ListLite {
  id: string;
  name: string;
  isActive: boolean;
  stats: { dueNow: number; total: number };
}

/** Active-session bar (status, queue counters, countdown, pause/resume/end). The start form lives in StartSessionForm. */
export function SessionControls() {
  const t = useT();
  const { state, pauseSession, resumeSession, endSession, busy, countdown, cancelCountdown, sessionTakenOver } = useDialer();
  const session = state?.session;

  if (session && session.status !== "ended") {
    const q = state?.queue;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={session.status === "paused" ? "warn" : "accent"} dot>
          {MODE_LABEL[session.mode]}
          {session.list ? ` · ${session.list.name}` : ""}
        </Badge>
        {q && (
          <span className="text-xs text-muted" title={t(`לא זמינים: ממתינים לניסיון חוזר ${q.unavailable.notDueYet} · בטיפול ${q.unavailable.inProgress} · מוצו ${q.unavailable.exhausted} · DNC ${q.unavailable.dnc}`, `Unavailable: waiting for retry ${q.unavailable.notDueYet} · in progress ${q.unavailable.inProgress} · exhausted ${q.unavailable.exhausted} · DNC ${q.unavailable.dnc}`)}>
            {t("בתור עכשיו", "In queue now")} <b className="text-text tabular">{q.dueNow}</b> · {t("סה״כ", "Total")} <span className="tabular">{q.total}</span> · {t("הושלמו", "Completed")} <span className="tabular">{q.byStatus.completed ?? 0}</span>
            {q.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-2">{t("מחוץ לשעות החיוג של העסק", "Outside the business's dialing hours")}</Badge>}
            {q.unavailable.listPaused && <Badge tone="bad" className="ms-2">{t("הרשימה מושהית", "List paused")}</Badge>}
          </span>
        )}
        <span className="text-xs text-muted">
          {t("חיוגים בסשן:", "Session dials:")} <span className="tabular text-text">{session.dialsCount}</span>
        </span>
        {countdown && (
          <button onClick={cancelCountdown} className="flex items-center gap-2 h-8 px-3 rounded-md bg-warn/15 text-warn text-xs">
            {t("הליד הבא בעוד", "Next lead in")} <b className="tabular text-base">{countdown.secondsLeft}</b> · {t("לחץ לביטול", "click to cancel")}
          </button>
        )}
        {sessionTakenOver && <Badge tone="bad">{t("הסשן עבר ללשונית אחרת", "Session moved to another tab")}</Badge>}
        <div className="ms-auto flex items-center gap-2">
          {session.status === "active" ? (
            <Button size="sm" variant="secondary" onClick={pauseSession} disabled={sessionTakenOver}>
              {t("השהה", "Pause")}
            </Button>
          ) : (
            <Button size="sm" variant="good" onClick={resumeSession} disabled={sessionTakenOver}>
              {t("המשך", "Resume")}
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={endSession} loading={busy === "session"} disabled={Boolean(state?.activeCall)} title={state?.activeCall ? t("נתק את השיחה קודם", "Hang up the call first") : undefined}>
            {t("סיים סשן", "End session")}
          </Button>
        </div>
      </div>
    );
  }

  // A manual call (or its wrap-up) without a session: no start form in the workspace header – finish the call first.
  if (state?.activeCall) return <p className="text-xs text-muted">{t("שיחה ידנית – התיעוד מתבצע אוטומטית על ידי AI. הפעלת החייגן האוטומטי זמינה מראש מסך הלידים.", "Manual call – documentation is done automatically by AI. The auto-dialer can be started from the top of the leads screen.")}</p>;
  return <StartSessionForm />;
}

/**
 * Pre-flight for the auto dialer: which queue (dial list) will be dialed, how many leads are due in it right now,
 * the mode and the pause between calls. Rendered inside the "הפעל חייגן" dialog on the leads screen.
 */
export function StartSessionForm({ onStarted, compact, initialListId }: { onStarted?: () => void; compact?: boolean; initialListId?: string } = {}) {
  const t = useT();
  const { state, startSession, busy } = useDialer();
  const [lists, setLists] = useState<ListLite[] | null>(null);
  const [mode, setMode] = useState<DialMode>("power");
  const [listId, setListId] = useState(initialListId ?? "");
  const [cd, setCd] = useState<number>(5);
  const [source, setSource] = useState<"list" | "mine">("list");
  const [mine, setMine] = useState<ListLite | null>(null);
  const [mineBusy, setMineBusy] = useState(false);

  // Personal queue: build/refresh the agent's own dynamic list from their open leads (idempotent).
  const loadMine = async () => {
    setMineBusy(true);
    try { const r = await api.post<ListLite & { added: number }>("/api/dialer/personal-list", {}); setMine({ id: r.id, name: r.name, isActive: true, stats: r.stats }); }
    catch { setMine(null); }
    finally { setMineBusy(false); }
  };

  useEffect(() => {
    api.get<ListLite[]>("/api/lists").then((l) => {
      const active = l.filter((x) => x.isActive).sort((a, b) => b.stats.dueNow - a.stats.dueNow);
      setLists(active);
      if (!compact && !listId && active[0]) setListId(active[0].id);
      if (active.length === 0) { setSource("mine"); void loadMine(); }
    }).catch(() => { setLists([]); setSource("mine"); void loadMine(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state?.settings) setCd(state.settings.autoDialCountdownSeconds);
  }, [state?.settings]);

  const chosen = source === "mine" ? mine : (lists?.find((l) => l.id === listId) ?? null);
  const effectiveListId = source === "mine" ? (mine?.id ?? "") : listId;
  const blocked = Boolean(state?.activeCall);
  if (compact) {
    // The launcher card ("הפעלת חייגן אוטומטי"): one campaign picker + one start button; mode / pause under "more".
    const pick = source === "mine" ? "__mine" : listId;
    const start = async () => { await startSession(mode, mode === "manual" ? undefined : effectiveListId, mode === "power" ? cd : undefined); onStarted?.(); };
    return (
      <div className="space-y-3" data-testid="dialer-launch-form">
        <select aria-label={t("בחירת קמפיין", "Choose a campaign")} value={pick} onChange={(e) => { const v = e.target.value; if (v === "__mine") { setSource("mine"); if (!mine) void loadMine(); } else { setSource("list"); setListId(v); } }}
          className="h-12 w-full rounded-lg border border-line bg-panel px-3 text-sm" data-testid="launch-campaign" disabled={lists === null}>
          <option value="" disabled>{lists === null ? t("טוען קמפיינים…", "Loading campaigns…") : t("בחירת קמפיין", "Choose a campaign")}</option>
          <option value="__mine">{t("הלידים שלי (תור אישי)", "My leads (personal queue)")}</option>
          {(lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} ({t(`${l.stats.dueNow} בתור`, `${l.stats.dueNow} in queue`)})</option>)}
        </select>
        {source === "mine" && mineBusy ? <p className="text-xs text-muted">{t("בונה את התור מהלידים הפתוחים שלך…", "Building the queue from your open leads…")}</p>
          : source === "mine" && !mine ? <p className="text-xs text-muted">{t("לא נמצאו לידים פתוחים ששייכים לך.", "No open leads assigned to you were found.")}</p>
          : chosen ? <p className={cx("text-xs", chosen.stats.dueNow === 0 ? "text-warn" : "text-muted")} data-testid="launch-available">{chosen.stats.dueNow === 0 ? t("אין כרגע לידים זמינים בקמפיין זה.", "No leads are available in this campaign right now.") : t(`זמינים לחיוג עכשיו: ${chosen.stats.dueNow} מתוך ${chosen.stats.total}`, `Available to dial now: ${chosen.stats.dueNow} of ${chosen.stats.total}`)}</p>
          : lists?.length === 0 ? <p className="text-xs text-muted">{t("אין קמפיין פעיל שמשויך אליך – אפשר לחייג מ״הלידים שלי״.", "No active campaign is assigned to you – you can dial from \"My leads\".")}</p> : null}
        {blocked && <p className="text-xs text-warn">{t("יש שיחה פעילה – סיים אותה לפני הפעלת החייגן.", "There is an active call – finish it before starting the dialer.")}</p>}
        <Button size="md" variant="good" className="h-12 w-full text-base" loading={busy === "session"} disabled={blocked || mineBusy || (mode !== "manual" && !effectiveListId)} data-testid="start-dialer" onClick={start}>
          {mode === "power" ? t("הפעלת חייגן אוטומטי", "Start auto-dialer") : mode === "preview" ? t("הפעלת חייגן (Preview)", "Start dialer (Preview)") : t("התחלת סשן ידני", "Start manual session")}
        </Button>
        <details className="text-xs text-muted" data-testid="launch-more">
          <summary className="cursor-pointer select-none">{t("אפשרויות נוספות", "More options")}</summary>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className="flex rounded-lg border border-line overflow-hidden" role="radiogroup" aria-label={t("מצב חיוג", "Dial mode")}>
              {(["power", "preview", "manual"] as DialMode[]).map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx("h-9 px-3 text-xs transition-colors", mode === m ? "bg-accent text-white" : "text-muted hover:text-text")}>{MODE_LABEL[m]}</button>)}
            </div>
            {mode === "power" && <label className="block"><span className="block mb-1">{t("השהיה בין שיחות", "Pause between calls")}</span><select value={cd} onChange={(e) => setCd(Number(e.target.value))} className="h-9 px-3 rounded-lg bg-bg border border-line">{[0, 3, 5, 10, 15, 30].map((v) => <option key={v} value={v}>{t(`${v} שנ׳`, `${v}s`)}</option>)}</select></label>}
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex rounded-lg border border-line overflow-hidden">
        {(["manual", "preview", "power"] as DialMode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={cx("h-10 px-4 text-sm transition-colors", mode === m ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {mode !== "manual" && source === "list" && (
        <Select label={t("רשימת חיוג", "Dial list")} value={listId} onChange={(e) => setListId(e.target.value)} className="min-w-56">
          {(lists ?? []).length === 0 && <option value="">{t("אין רשימות פעילות", "No active lists")}</option>}
          {(lists ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({t(`${l.stats.dueNow} בתור`, `${l.stats.dueNow} in queue`)})
            </option>
          ))}
        </Select>
      )}
      {mode === "power" && (
        <label className="block">
          <span className="block text-xs text-muted mb-1">{t("השהיה בין שיחות", "Pause between calls")}</span>
          <select value={cd} onChange={(e) => setCd(Number(e.target.value))} className="h-10 px-3 rounded-lg bg-bg border border-line">
            {[0, 3, 5, 10, 15, 30].map((s) => (
              <option key={s} value={s}>
                {t(`${s} שנ׳`, `${s}s`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button size="md" variant="good" loading={busy === "session"} disabled={blocked || mineBusy || (mode !== "manual" && !effectiveListId)} data-testid="start-dialer" onClick={async () => { await startSession(mode, mode === "manual" ? undefined : effectiveListId, mode === "power" ? cd : undefined); onStarted?.(); }}>
        {mode === "power" ? t("▶ הפעל חיוג אוטומטי", "▶ Start auto-dial") : mode === "preview" ? t("▶ התחל Preview", "▶ Start Preview") : t("▶ התחל סשן ידני", "▶ Start manual session")}
      </Button>
    </div>
  );
}
