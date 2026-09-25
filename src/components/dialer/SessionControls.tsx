"use client";

import { useEffect, useState } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, Select, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import { MODE_LABEL } from "@/lib/client/format";
import type { DialMode } from "@/lib/client/types";

interface ListLite {
  id: string;
  name: string;
  isActive: boolean;
  stats: { dueNow: number; total: number };
}

/** Active-session bar (status, queue counters, countdown, pause/resume/end). The start form lives in StartSessionForm. */
export function SessionControls() {
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
          <span className="text-xs text-muted" title={`לא זמינים: ממתינים לניסיון חוזר ${q.unavailable.notDueYet} · בטיפול ${q.unavailable.inProgress} · מוצו ${q.unavailable.exhausted} · DNC ${q.unavailable.dnc}`}>
            בתור עכשיו <b className="text-text tabular">{q.dueNow}</b> · סה״כ <span className="tabular">{q.total}</span> · הושלמו <span className="tabular">{q.byStatus.completed ?? 0}</span>
            {q.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-2">מחוץ לחלון החיוג</Badge>}
            {q.unavailable.listPaused && <Badge tone="bad" className="ms-2">הרשימה מושהית</Badge>}
          </span>
        )}
        <span className="text-xs text-muted">
          חיוגים בסשן: <span className="tabular text-text">{session.dialsCount}</span>
        </span>
        {countdown && (
          <button onClick={cancelCountdown} className="flex items-center gap-2 h-8 px-3 rounded-md bg-warn/15 text-warn text-xs">
            הליד הבא בעוד <b className="tabular text-base">{countdown.secondsLeft}</b> · לחץ לביטול
          </button>
        )}
        {sessionTakenOver && <Badge tone="bad">הסשן עבר ללשונית אחרת</Badge>}
        <div className="ms-auto flex items-center gap-2">
          {session.status === "active" ? (
            <Button size="sm" variant="secondary" onClick={pauseSession} disabled={sessionTakenOver}>
              השהה
            </Button>
          ) : (
            <Button size="sm" variant="good" onClick={resumeSession} disabled={sessionTakenOver}>
              המשך
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={endSession} loading={busy === "session"} disabled={Boolean(state?.activeCall)} title={state?.activeCall ? "נתק את השיחה קודם" : undefined}>
            סיים סשן
          </Button>
        </div>
      </div>
    );
  }

  // A manual call (or its wrap-up) without a session: no start form in the workspace header – finish the call first.
  if (state?.activeCall || state?.wrapUpCall) return <p className="text-xs text-muted">שיחה ידנית – תעד את התוצאה בסיום ותחזור לרשימת הלידים. הפעלת החייגן האוטומטי זמינה מראש מסך הלידים.</p>;
  return <StartSessionForm />;
}

/**
 * Pre-flight for the auto dialer: which queue (dial list) will be dialed, how many leads are due in it right now,
 * the mode and the pause between calls. Rendered inside the "הפעל חייגן" dialog on the leads screen.
 */
export function StartSessionForm({ onStarted, compact }: { onStarted?: () => void; compact?: boolean } = {}) {
  const { state, startSession, busy } = useDialer();
  const [lists, setLists] = useState<ListLite[] | null>(null);
  const [mode, setMode] = useState<DialMode>("power");
  const [listId, setListId] = useState("");
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
      if (!listId && active[0]) setListId(active[0].id);
      if (active.length === 0) { setSource("mine"); void loadMine(); }
    }).catch(() => { setLists([]); setSource("mine"); void loadMine(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state?.settings) setCd(state.settings.autoDialCountdownSeconds);
  }, [state?.settings]);

  const chosen = source === "mine" ? mine : (lists?.find((l) => l.id === listId) ?? null);
  const effectiveListId = source === "mine" ? (mine?.id ?? "") : listId;
  const blocked = Boolean(state?.activeCall || state?.wrapUpCall);
  return (
    <div className={compact ? "space-y-3" : "flex flex-wrap items-end gap-3"}>
      {compact && (
        <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm space-y-1">
          <div className="flex rounded-lg border border-line overflow-hidden w-fit mb-1" role="radiogroup" aria-label="מקור התור">
            <button role="radio" aria-checked={source === "mine"} onClick={() => { setSource("mine"); if (!mine) void loadMine(); }} className={cx("h-8 px-3 text-xs", source === "mine" ? "bg-accent text-white" : "text-muted hover:text-text")} data-testid="source-mine">הלידים שלי</button>
            <button role="radio" aria-checked={source === "list"} onClick={() => setSource("list")} disabled={!lists?.length} className={cx("h-8 px-3 text-xs disabled:opacity-40", source === "list" ? "bg-accent text-white" : "text-muted hover:text-text")} data-testid="source-list">רשימת חיוג</button>
          </div>
          {source === "mine" && mineBusy && !mine ? <p className="text-muted">בונה את התור מהלידים הפתוחים שלך…</p> : source === "mine" && !mine ? (
            <p className="text-muted">לא נמצאו לידים פתוחים ששייכים לך. ליד שמשויך אליך בסטטוס חדש/נוצר קשר/מתאים ייכנס לתור אוטומטית.</p>
          ) : source === "list" && lists === null ? <p className="text-muted">טוען רשימות…</p> : source === "list" && lists?.length === 0 ? (
            <p className="text-muted">אין רשימת חיוג פעילה שמשויכת אליך – בחר &quot;הלידים שלי&quot;.</p>
          ) : chosen ? (
            <>
              <p>יחויגו לידים מהתור <b>{chosen.name}</b>.</p>
              <p className="text-muted">זמינים לחיוג עכשיו: <b className="text-text tabular">{chosen.stats.dueNow}</b> מתוך <span className="tabular">{chosen.stats.total}</span>. לידים בטיפול אצל נציג אחר, חסומים (DNC), עם חזרה מתוזמנת עתידית או מחוץ לחלון החיוג אינם נכללים.</p>
              {chosen.stats.dueNow === 0 && <p className="text-warn">אין כרגע לידים זמינים ברשימה זו.</p>}
            </>
          ) : null}
          {blocked && <p className="text-warn">יש שיחה פעילה או שיחה שממתינה לתיעוד – סיים אותה לפני הפעלת החייגן.</p>}
        </div>
      )}
      <div className="flex rounded-lg border border-line overflow-hidden">
        {(["manual", "preview", "power"] as DialMode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={cx("h-10 px-4 text-sm transition-colors", mode === m ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {mode !== "manual" && source === "list" && (
        <Select label="רשימת חיוג" value={listId} onChange={(e) => setListId(e.target.value)} className="min-w-56">
          {(lists ?? []).length === 0 && <option value="">אין רשימות פעילות</option>}
          {(lists ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.stats.dueNow} בתור)
            </option>
          ))}
        </Select>
      )}
      {mode === "power" && (
        <label className="block">
          <span className="block text-xs text-muted mb-1">השהיה בין שיחות</span>
          <select value={cd} onChange={(e) => setCd(Number(e.target.value))} className="h-10 px-3 rounded-lg bg-bg border border-line">
            {[0, 3, 5, 10, 15, 30].map((s) => (
              <option key={s} value={s}>
                {s} שנ׳
              </option>
            ))}
          </select>
        </label>
      )}
      <Button size="md" variant="good" loading={busy === "session"} disabled={blocked || mineBusy || (mode !== "manual" && !effectiveListId)} data-testid="start-dialer" onClick={async () => { await startSession(mode, mode === "manual" ? undefined : effectiveListId, mode === "power" ? cd : undefined); onStarted?.(); }}>
        {mode === "power" ? "▶ הפעל חיוג אוטומטי" : mode === "preview" ? "▶ התחל Preview" : "▶ התחל סשן ידני"}
      </Button>
    </div>
  );
}
