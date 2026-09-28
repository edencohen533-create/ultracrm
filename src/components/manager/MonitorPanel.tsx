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
import { useT } from "@/components/i18n/LangProvider";

export function MonitorPanel({ onClose, agentName, contactName, callAnsweredAt, callEnded, onOpenContact, embedded = false }: { embedded?: boolean; onClose: () => void; agentName: string; contactName: string; callAnsweredAt: string | null; callEnded: boolean; onOpenContact?: () => void }) {
  const t = useT();
  const { supervisor, phone } = useDialer();
  const { monitor, media } = supervisor;
  const [now, setNow] = useState(() => Date.now());
  const [holding, setHolding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const holdRef = useRef(false);

  useEffect(() => {
    const tk = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(() => supervisor.refresh(), 1500);
    return () => { clearInterval(tk); clearInterval(p); };
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
  const label: Record<typeof display, string> = { connecting: t("מתחבר…", "Connecting…"), listening: t("האזנה בלבד", "Listen only"), whispering: t("לחישה לנציג", "Whispering to agent"), ended: t("השיחה / ההאזנה הסתיימה", "Call / monitoring ended"), error: t("שגיאה", "Error") };
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
    <aside className={cx("shrink-0 border-s border-line bg-panel flex flex-col", embedded ? "w-full" : "w-[340px]", display === "whispering" && "ring-2 ring-warn")}>
      <header className="px-4 h-12 flex items-center justify-between border-b border-line">
        <h3 className="font-semibold">{t("האזנה לשיחה", "Call monitoring")}</h3>
        <button onClick={leave} className="text-muted hover:text-text text-xl leading-none" aria-label={t("יציאה מהאזנה", "Stop monitoring")}>×</button>
      </header>
      <div className="p-4 space-y-3 text-sm flex-1 overflow-y-auto">
        <div className="flex items-center gap-2">
          <Badge tone={tone} dot>{label[display]}</Badge>
          {simulation && <Badge tone="warn">{t("הדמיה – אין אודיו", "Simulation – no audio")}</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-y-1 text-xs">
          <dt className="text-muted">{t("נציג", "Agent")}</dt><dd className="font-medium">{agentName}</dd>
          <dt className="text-muted">{t("לקוח", "Customer")}</dt><dd className="font-medium truncate">{contactName}</dd>
          <dt className="text-muted">{t("משך השיחה", "Call duration")}</dt><dd className="tabular">{callAnsweredAt ? formatDuration(Math.round((now - new Date(callAnsweredAt).getTime()) / 1000)) : "—"}</dd>
          <dt className="text-muted">{t("חיבור המנהל", "Manager connection")}</dt><dd>{simulation ? t("הדמיה", "Simulation") : media === "active" ? t("מדיה מחוברת", "Media connected") : media === "ringing" ? t("מחבר מדיה…", "Connecting media…") : media === "ended" ? t("מנותק", "Disconnected") : phone.status === "ready" ? t("רשום, ממתין ל-leg", "Registered, waiting for leg") : t("לא מחובר", "Not connected")}</dd>
          {monitor?.joinedAt && <><dt className="text-muted">{t("מחובר מאז", "Connected for")}</dt><dd className="tabular">{formatDuration(Math.round((now - new Date(monitor.joinedAt).getTime()) / 1000))}</dd></>}
        </dl>
        {monitor?.error && <p className="text-xs text-bad">{monitor.error}</p>}
        {err && <p className="text-xs text-bad">{err}</p>}

        <div className="border-t border-line pt-3 space-y-2">
          <label className="block text-xs">
            <span className="text-muted">{t("עוצמת שמע", "Volume")}</span>
            <input type="range" min={0} max={1} step={0.05} value={supervisor.volume} onChange={(e) => supervisor.setVolume(Number(e.target.value))} className="w-full" />
          </label>
          <label className="block text-xs">
            <span className="text-muted">{t("רמקול", "Speaker")} {phone.canSelectSpeaker ? "" : t("(הדפדפן לא תומך)", "(browser doesn't support it)")}</span>
            <select disabled={!phone.canSelectSpeaker} value={phone.speakerId} onChange={(e) => phone.setSpeaker(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line disabled:opacity-50">
              <option value="">{t("ברירת מחדל", "Default")}</option>
              {phone.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("רמקול", "Speaker")}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted">{t("מיקרופון (ללחישה)", "Microphone (for whisper)")}</span>
            <select value={phone.micId} onChange={(e) => phone.setMic(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line">
              <option value="">{t("ברירת מחדל", "Default")}</option>
              {phone.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("מיקרופון", "Microphone")}</option>)}
            </select>
          </label>
        </div>

        <div className="border-t border-line pt-3">
          <p className="text-xs text-muted mb-2">{t("לחישה: רק הנציג שומע אותך. לחץ והחזק (או החזק רווח). שחרור, אובדן פוקוס או ניתוק מפסיקים את השידור.", "Whisper: only the agent hears you. Press and hold (or hold Space). Releasing, losing focus or disconnecting stops transmitting.")}</p>
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
            {holding || display === "whispering" ? t("🎙 לוחש לנציג…", "🎙 Whispering to agent…") : t("לחץ והחזק כדי ללחוש", "Press and hold to whisper")}
          </button>
        </div>
      </div>
      <footer className="p-3 border-t border-line flex gap-2">
        {onOpenContact && <Button variant="secondary" size="sm" onClick={onOpenContact}>{t("פתיחת לקוח", "Open customer")}</Button>}
        <Button variant="danger" size="sm" className="ms-auto" onClick={leave}>{t("יציאה מהאזנה", "Stop monitoring")}</Button>
      </footer>
    </aside>
  );
}
