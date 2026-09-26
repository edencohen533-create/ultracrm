"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, cx } from "@/components/ui";
import { CoachChat } from "@/components/coach/CoachChat";

type Providers = { llm: string; stt: string; embeddings: string; mock: boolean };
type Status = { enabled: boolean; reason?: string; providers: Providers; live: boolean };
type Rec = { id: string; objection: string | null; sayNow: string; why: string; confidence: number; basis: string; sources: { exampleIds?: string[]; exampleCalls?: string[]; knowledge?: string[]; model?: string; llmLatencyMs?: number }; latencyMs: number | null; createdAt: string };
type SessionState = { id: string; status: "listening" | "analyzing" | "ready" | "unavailable" | "ended"; stage: string | null; lastObjection: string | null; segmentsCount: number; recommendation: Rec | null; usage: { costUsd: number; avgLatencyMs: number | null } } | null;

const STAGE_LABEL: Record<string, string> = { opening: "פתיחה", discovery: "בירור צרכים", presentation: "הצגת הצעה", objection: "התנגדות", closing: "סגירה", wrap_up: "סיום" };
const CHUNK_MS = 5000;
const SILENCE_RMS = 0.01;

/**
 * Real-time sales coach card inside the call screen. Shows one recommendation at a time to the agent only.
 * Audio capture (layer 1) runs in the browser: the customer's track (remote audio element) and the agent's mic are
 * recorded in 5-second self-contained chunks and sent for transcription; silent chunks are skipped.
 * In telephony simulation there is no audio, so a labelled text input feeds the same pipeline.
 */
export function CoachCard({ callId, answered, simulation, onStatus }: { callId: string; answered: boolean; simulation: boolean; onStatus?: (s: Status | null) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [session, setSession] = useState<SessionState>(null);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  const [simText, setSimText] = useState("");
  const [simSpeaker, setSimSpeaker] = useState<"customer" | "agent">("customer");
  const [capture, setCapture] = useState<"off" | "on" | "error">("off");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const lastRecId = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await api.get<{ status: Status; session: SessionState; callEnded: boolean }>(`/api/coach/calls/${callId}/state`);
      setStatus(r.status); onStatus?.(r.status); setSession(r.session);
      if (r.session?.recommendation && r.session.recommendation.id !== lastRecId.current) { lastRecId.current = r.session.recommendation.id; setExpanded(false); }
    } catch { /* keep the last state; the call is unaffected */ }
  }, [callId, onStatus]);
  useEffect(() => { poll(); const t = setInterval(poll, 2000); return () => clearInterval(t); }, [poll]);

  // Layer 1 – browser audio capture (real calls only, when providers exist).
  useEffect(() => {
    if (!answered || simulation || !status?.live || status.providers.stt === "missing") { stopRef.current?.(); stopRef.current = null; setCapture("off"); return; }
    if (stopRef.current) return;
    let cancelled = false;
    const stops: Array<() => void> = [];
    const startTrack = async (stream: MediaStream, speaker: "customer" | "agent") => {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream); const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let peak = 0; const meter = setInterval(() => { analyser.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; peak = Math.max(peak, Math.sqrt(s / buf.length)); }, 200);
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const t0 = Date.now();
      let rec: MediaRecorder | null = null;
      const cycle = () => {
        if (cancelled) return;
        const chunkStart = Date.now();
        rec = new MediaRecorder(stream, { mimeType: mime });
        const parts: Blob[] = [];
        rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
        rec.onstop = () => {
          const blob = new Blob(parts, { type: mime }); const had = peak; peak = 0;
          if (!cancelled) cycle();
          if (had < SILENCE_RMS || blob.size < 2000) return; // silence – no STT cost
          const fd = new FormData(); fd.append("file", blob, "chunk.webm"); fd.append("speaker", speaker); fd.append("durationSeconds", String((Date.now() - chunkStart) / 1000)); fd.append("startMs", String(chunkStart - t0));
          fetch(`/api/coach/calls/${callId}/audio`, { method: "POST", body: fd }).then((r) => { if (r.ok) poll(); }).catch(() => undefined);
        };
        rec.start();
        setTimeout(() => { try { rec?.state === "recording" && rec.stop(); } catch { /* ignore */ } }, CHUNK_MS);
      };
      cycle();
      stops.push(() => { clearInterval(meter); try { rec?.state === "recording" && rec.stop(); } catch { /* ignore */ } ctx.close().catch(() => undefined); });
    };
    (async () => {
      try {
        const el = document.getElementById("remote-audio") as HTMLMediaElement | null;
        const remote = el?.srcObject instanceof MediaStream ? el.srcObject : null;
        if (!remote || remote.getAudioTracks().length === 0) throw new Error("אין ערוץ אודיו של הלקוח בדפדפן");
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        stops.push(() => mic.getTracks().forEach((t) => t.stop()));
        if (cancelled) return;
        await startTrack(new MediaStream(remote.getAudioTracks()), "customer");
        await startTrack(mic, "agent");
        setCapture("on"); setCaptureError(null);
      } catch (e) { setCapture("error"); setCaptureError((e as Error).message); }
    })();
    stopRef.current = () => { cancelled = true; stops.forEach((s) => s()); };
    return () => { stopRef.current?.(); stopRef.current = null; };
  }, [answered, simulation, status?.live, status?.providers.stt, callId, poll]);

  async function feedback(kind: "helpful" | "not_helpful" | "skipped" | "hidden") {
    const rec = session?.recommendation; if (!rec) return;
    setHidden(rec.id);
    try { await api.post(`/api/coach/recommendations/${rec.id}/feedback`, { feedback: kind }); } catch { /* ignore */ }
    poll();
  }
  async function sendSim() {
    if (!simText.trim()) return;
    try { await api.post(`/api/coach/calls/${callId}/segments`, { segments: [{ speaker: simSpeaker, text: simText.trim(), source: "simulation" }] }); setSimText(""); poll(); }
    catch (e) { setCaptureError((e as Error).message); }
  }

  if (!status) return null;
  if (!status.enabled) return null; // off for the business / agent – nothing to show, nothing to load
  const rec = session?.recommendation && session.recommendation.id !== hidden ? session.recommendation : null;
  const state: "unavailable" | "listening" | "analyzing" | "ready" = !status.live ? "unavailable" : rec ? "ready" : session?.status === "analyzing" ? "analyzing" : "listening";
  const stateLabel = { unavailable: "לא זמין", listening: "מאזין", analyzing: "מנתח…", ready: "יש המלצה" }[state];
  const basisLabel = rec ? (rec.basis === "examples" ? `מבוסס על ${rec.sources.exampleIds?.length ?? 0} דוגמאות מכירה שנבדקו בעסק` : rec.basis === "question" ? "שאלה לנציג – זיהוי לא ודאי" : "מבוסס על הידע העסקי המאושר בלבד – ללא דוגמאות מכירה מספיקות") : "";
  return (
    <section className="rounded-xl border border-line bg-panel p-3 space-y-2" data-testid="coach-card" aria-live="polite">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">מאמן מכירות</span>
        <Badge tone={state === "ready" ? "good" : state === "analyzing" ? "warn" : state === "unavailable" ? "bad" : "info"} dot>{stateLabel}</Badge>
        {session?.stage && <span className="text-[11px] text-muted">שלב: {STAGE_LABEL[session.stage] ?? session.stage}</span>}
        {status.providers.mock && <Badge tone="warn">ספק AI מדומה</Badge>}
        {simulation && <Badge tone="warn">הדמיה – אין אודיו</Badge>}
        {!simulation && capture === "on" && <span className="text-[11px] text-good">מקליט לתמלול</span>}
        {rec?.latencyMs != null && <span className="text-[11px] text-muted tabular" title="מסיום משפט הלקוח ועד ההמלצה">{(rec.latencyMs / 1000).toFixed(1)} שנ׳</span>}
        <span className="ms-auto"><CoachChat callId={callId} disabledReason={status.live ? null : status.reason ?? "המאמן לא זמין"} mock={status.providers.mock} /></span>
      </div>
      {state === "unavailable" && <p className="text-xs text-bad">{status.reason ?? "המאמן לא זמין"}</p>}
      {capture === "error" && !simulation && <p className="text-xs text-warn">תמלול חי לא פעיל: {captureError}</p>}
      {rec ? (
        <div className="space-y-1.5" data-testid="coach-recommendation">
          {rec.objection && <p className="text-xs"><span className="text-muted">התנגדות / שאלה: </span><span className="font-medium">{rec.objection}</span></p>}
          <p className="text-[15px] leading-snug font-medium" data-testid="coach-say-now"><span className="text-muted text-xs block">מה לומר עכשיו</span>{rec.sayNow}</p>
          <button onClick={() => setExpanded((e) => !e)} className="text-[11px] text-accent underline">{expanded ? "הסתר הסבר" : "למה זה מתאים?"}</button>
          {expanded && (
            <div className="text-xs text-muted space-y-0.5 rounded-md bg-panel-2 p-2">
              <p>{rec.why || "—"}</p>
              <p>{basisLabel} · ביטחון {Math.round(rec.confidence * 100)}%</p>
              {rec.sources.knowledge?.length ? <p>ידע עסקי: {rec.sources.knowledge.join(" · ")}</p> : null}
            </div>
          )}
          <div className="flex flex-wrap gap-1 pt-1">
            <Button size="sm" variant="secondary" onClick={() => feedback("helpful")}>מועיל</Button>
            <Button size="sm" variant="ghost" onClick={() => feedback("not_helpful")}>לא מועיל</Button>
            <Button size="sm" variant="ghost" onClick={() => feedback("skipped")}>דלג</Button>
            <Button size="sm" variant="ghost" onClick={() => feedback("hidden")}>הסתר</Button>
          </div>
        </div>
      ) : state !== "unavailable" ? (
        <p className="text-xs text-muted">{session?.segmentsCount ? "ממתין להתנגדות או לשאלה מהלקוח…" : answered ? "מאזין לשיחה. המלצה תופיע כשהלקוח מעלה התנגדות או שאלה." : "ההמלצות יתחילו כשהשיחה נענית."}</p>
      ) : null}
      {simulation && status.live && answered && (
        <div className="border-t border-line pt-2 space-y-1" data-testid="coach-sim">
          <p className="text-[11px] text-warn">הדמיה: אין אודיו אמיתי – הזן מה נאמר כדי להפעיל את אותו צינור ניתוח.</p>
          <div className="flex gap-1">
            <select value={simSpeaker} onChange={(e) => setSimSpeaker(e.target.value as "customer" | "agent")} className="h-8 rounded-md border border-line bg-bg text-xs px-1" aria-label="דובר"><option value="customer">לקוח</option><option value="agent">נציג</option></select>
            <Input value={simText} onChange={(e) => setSimText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendSim()} placeholder="למשל: זה יקר לי" className={cx("h-8 text-xs")} aria-label="טקסט הדמיה" />
            <Button size="sm" onClick={sendSim} disabled={!simText.trim()} data-testid="coach-sim-send">שלח</Button>
          </div>
        </div>
      )}
    </section>
  );
}
