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

export function SessionControls() {
  const { state, startSession, pauseSession, resumeSession, endSession, busy, countdown, cancelCountdown, sessionTakenOver } = useDialer();
  const [lists, setLists] = useState<ListLite[]>([]);
  const [mode, setMode] = useState<DialMode>("power");
  const [listId, setListId] = useState("");
  const [cd, setCd] = useState<number>(5);
  const session = state?.session;

  useEffect(() => {
    api.get<ListLite[]>("/api/lists").then((l) => {
      const active = l.filter((x) => x.isActive);
      setLists(active);
      if (!listId && active[0]) setListId(active[0].id);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state?.settings) setCd(state.settings.autoDialCountdownSeconds);
  }, [state?.settings]);

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

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex rounded-lg border border-line overflow-hidden">
        {(["manual", "preview", "power"] as DialMode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={cx("h-10 px-4 text-sm transition-colors", mode === m ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {mode !== "manual" && (
        <Select label="רשימת חיוג" value={listId} onChange={(e) => setListId(e.target.value)} className="min-w-56">
          {lists.length === 0 && <option value="">אין רשימות פעילות</option>}
          {lists.map((l) => (
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
      <Button size="md" variant="good" loading={busy === "session"} disabled={mode !== "manual" && !listId} onClick={() => startSession(mode, mode === "manual" ? undefined : listId, mode === "power" ? cd : undefined)}>
        {mode === "power" ? "▶ התחל תותח שיחות" : mode === "preview" ? "▶ התחל Preview" : "▶ התחל סשן ידני"}
      </Button>
    </div>
  );
}
