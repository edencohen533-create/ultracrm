"use client";

/**
 * Listen / whisper side panel. Status wording follows the server monitor state
 * AND the browser media state: "מאזין" is shown only when both confirm.
 * Whisper is push-to-talk (mouse / touch / Space); releasing, losing focus or
 * disconnecting always returns to listen-only.
 */
import { useEffect, useRef, useState } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, cx } from "@/components/ui";
import { formatDuration } from "@/lib/client/format";

export function MonitorPanel({ onClose, agentName, contactName, callAnsweredAt, callEnded, onOpenContact }: { onClose: () => void; agentName: string; contactName: string; callAnsweredAt: string | null; callEnded: boolean; onOpenContact?: () => void }) {
  const { supervisor, phone } = useDialer();
  const { monitor, media } = supervisor;
  const [now, setNow] = useState(() => Date.now());
  const [holding, setHolding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const holdRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(() => supervisor.refresh(), 1500);
    return () => { clearInterval(t); clearInterval(p); };
  }, [supervisor]);

  const simulation = phone.status === "simulation";
  const serverStatus = monitor?.status ?? "connecting";
  const ended = Boolean(monitor?.endedAt) || callEnded || media === "ended";
  // Derived display state: never claim "listening" before media is confirmed (or simulation, which has no media).
  const display: "connecting" | "listening" | "whispering" | "ended" | "error" =
    monitor?.status === "failed" ? "error"
    : ended ? "ended"
    : serverStatus === "connecting" || (!simulation && media !== "active") ? "connecting"
    : serverStatus === "whispering" ? "whispering"
    : "listening";
  const label: Record<typeof display, string> = { connecting: "מתחבר…", listening: "האזנה בלבד", whispering: "לחישה לנציג", ended: "השיחה / ההאזנה הסתיימה", error: "שגיאה" };
  const tone = display === "whispering" ? "warn" : display === "listening" ? "good" : display === "error" ? "bad" : "neutral";

  async function pressStart() {
    if (display !== "listening") return;
    holdRef.current = true;
    setHolding(true);
    try {
      await supervisor.whisperOn();
    } catch (e) {
      setErr((e as Error).message);
      holdRef.current = false;
      setHolding(false);
    }
  }
  async function pressEnd() {
    if (!holdRef.current) return;
    holdRef.current = false;
    setHolding(false);
    await supervisor.whisperOff().catch((e) => setErr((e as Error).message));
  }
  // Keyboard: hold Space to whisper (not while typing anywhere).
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !e.repeat && !(e.target as HTMLElement)?.matches("input,textarea,select")) { e.preventDefault(); pressStart(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") { e.preventDefault(); pressEnd(); } };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);
  // Safety: if the server dropped to listen (or ended) while we think we hold, release.
  useEffect(() => {
    if (holdRef.current && display !== "whispering" && display !== "listening") { holdRef.current = false; setHolding(false); }
  }, [display]);

  async function leave() {
    try {
      await supervisor.stop();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <aside className={cx("w-[340px] shrink-0 border-s border-line bg-panel flex flex-col", display === "whispering" && "ring-2 ring-warn")}>
      <header className="px-4 h-12 flex items-center justify-between border-b border-line">
        <h3 className="font-semibold">האזנה לשיחה</h3>
        <button onClick={leave} className="text-muted hover:text-text text-xl leading-none" aria-label="יציאה מהאזנה">×</button>
      </header>
      <div className="p-4 space-y-3 text-sm flex-1 overflow-y-auto">
        <div className="flex items-center gap-2">
          <Badge tone={tone} dot>{label[display]}</Badge>
          {simulation && <Badge tone="warn">הדמיה – אין אודיו</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-y-1 text-xs">
          <dt className="text-muted">נציג</dt><dd className="font-medium">{agentName}</dd>
          <dt className="text-muted">לקוח</dt><dd className="font-medium truncate">{contactName}</dd>
          <dt className="text-muted">משך השיחה</dt><dd className="tabular">{callAnsweredAt ? formatDuration(Math.round((now - new Date(callAnsweredAt).getTime()) / 1000)) : "—"}</dd>
          <dt className="text-muted">חיבור המנהל</dt><dd>{simulation ? "הדמיה" : media === "active" ? "מדיה מחוברת" : media === "ringing" ? "מחבר מדיה…" : media === "ended" ? "מנותק" : phone.status === "ready" ? "רשום, ממתין ל-leg" : "לא מחובר"}</dd>
          {monitor?.joinedAt && <><dt className="text-muted">מחובר מאז</dt><dd className="tabular">{formatDuration(Math.round((now - new Date(monitor.joinedAt).getTime()) / 1000))}</dd></>}
        </dl>
        {monitor?.error && <p className="text-xs text-bad">{monitor.error}</p>}
        {err && <p className="text-xs text-bad">{err}</p>}

        <div className="border-t border-line pt-3 space-y-2">
          <label className="block text-xs">
            <span className="text-muted">עוצמת שמע</span>
            <input type="range" min={0} max={1} step={0.05} value={supervisor.volume} onChange={(e) => supervisor.setVolume(Number(e.target.value))} className="w-full" />
          </label>
          <label className="block text-xs">
            <span className="text-muted">רמקול {phone.canSelectSpeaker ? "" : "(הדפדפן לא תומך)"}</span>
            <select disabled={!phone.canSelectSpeaker} value={phone.speakerId} onChange={(e) => phone.setSpeaker(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line disabled:opacity-50">
              <option value="">ברירת מחדל</option>
              {phone.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "רמקול"}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted">מיקרופון (ללחישה)</span>
            <select value={phone.micId} onChange={(e) => phone.setMic(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line">
              <option value="">ברירת מחדל</option>
              {phone.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "מיקרופון"}</option>)}
            </select>
          </label>
        </div>

        <div className="border-t border-line pt-3">
          <p className="text-xs text-muted mb-2">לחישה: רק הנציג שומע אותך. לחץ והחזק (או החזק רווח). שחרור, אובדן פוקוס או ניתוק מפסיקים את השידור.</p>
          <button
            type="button"
            disabled={display !== "listening" && display !== "whispering"}
            onMouseDown={pressStart}
            onMouseUp={pressEnd}
            onMouseLeave={pressEnd}
            onTouchStart={(e) => { e.preventDefault(); pressStart(); }}
            onTouchEnd={pressEnd}
            onBlur={pressEnd}
            className={cx("w-full h-14 rounded-xl font-semibold text-base select-none transition-colors disabled:opacity-40", holding || display === "whispering" ? "bg-warn text-black" : "bg-white/8 hover:bg-white/12 text-text")}
            aria-pressed={holding}
          >
            {holding || display === "whispering" ? "🎙 לוחש לנציג…" : "לחץ והחזק כדי ללחוש"}
          </button>
        </div>
      </div>
      <footer className="p-3 border-t border-line flex gap-2">
        {onOpenContact && <Button variant="secondary" size="sm" onClick={onOpenContact}>פתיחת לקוח</Button>}
        <Button variant="danger" size="sm" className="ms-auto" onClick={leave}>יציאה מהאזנה</Button>
      </footer>
    </aside>
  );
}
