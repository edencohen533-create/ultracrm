"use client";

/**
 * Client-side brain of the dialer. Mounted once in the app layout so the
 * telephony connection and the call state survive page navigation.
 *
 *  - Registers the browser with Telnyx WebRTC (or runs in clearly-marked simulation).
 *  - Polls /api/dialer/state (fast while something is happening, slow when idle).
 *  - Sends heartbeats that renew the lead lock.
 *  - Drives the power-dialer loop: outcome saved → countdown → next lead → dial.
 *  - Enforces single-tab ownership of a session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/client/api";
import type { CallDto, DialerStateDto, DialMode, LeadDto, MonitorDto, OutcomeKey } from "@/lib/client/types";

type PhoneStatus = "idle" | "connecting" | "ready" | "error" | "simulation" | "disconnected";
type MicPermission = "unknown" | "granted" | "denied";

interface SdkCall {
  id: string;
  state: string;
  direction: "inbound" | "outbound";
  answer: () => Promise<void>;
  hangup: () => Promise<void>;
  muteAudio: () => void;
  unmuteAudio: () => void;
  dtmf: (d: string) => void;
}

interface SdkClient {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  off: (ev: string) => void;
  remoteElement: string | HTMLMediaElement;
  speaker: string;
  connected: boolean;
  getAudioInDevices: () => Promise<MediaDeviceInfo[]>;
  getAudioOutDevices: () => Promise<MediaDeviceInfo[]>;
  setAudioSettings: (s: { micId?: string; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }) => Promise<unknown>;
}

export interface DialInput {
  mode: DialMode;
  leadId?: string;
  lockToken?: string;
  contactId?: string;
  phone?: string;
  phoneNumberId?: string;
}

interface Ctx {
  state: DialerStateDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  browserSessionId: string;
  sessionTakenOver: boolean;
  phone: {
    status: PhoneStatus;
    error: string | null;
    micPermission: MicPermission;
    muted: boolean;
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
    micId: string;
    speakerId: string;
    canSelectSpeaker: boolean;
    setMic: (id: string) => Promise<void>;
    setSpeaker: (id: string) => void;
    toggleMute: () => void;
    reconnect: () => Promise<void>;
    requestMic: () => Promise<void>;
  };
  busy: string | null;
  startSession: (mode: DialMode, listId?: string, countdownSeconds?: number) => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
  nextLead: () => Promise<LeadDto | null>;
  skipLead: (reason: string) => Promise<void>;
  dial: (input: DialInput) => Promise<CallDto | null>;
  hangup: () => Promise<void>;
  sendDtmf: (digit: string) => Promise<void>;
  saveOutcome: (callId: string, outcome: OutcomeKey, opts?: { note?: string; callbackAt?: Date; contactUpdates?: Record<string, string | undefined> }) => Promise<void>;
  countdown: { secondsLeft: number; leadId: string | null } | null;
  cancelCountdown: () => void;
  lastError: { code: string; message: string } | null;
  acceptInbound: () => Promise<void>;
  rejectInbound: () => Promise<void>;
  sessionSummary: SessionSummary | null;
  dismissSummary: () => void;
  /** Supervisor (manager) listen / whisper. */
  supervisor: {
    monitor: MonitorDto | null;
    /** Browser-side media state of the supervisor leg: none | ringing | active | ended. */
    media: "none" | "ringing" | "active" | "ended";
    start: (callId: string) => Promise<MonitorDto | null>;
    stop: () => Promise<void>;
    whisperOn: () => Promise<void>;
    whisperOff: () => Promise<void>;
    refresh: () => Promise<MonitorDto | null>;
    setVolume: (v: number) => void;
    volume: number;
  };
}

export interface SessionSummary {
  session: { id: string; mode: DialMode; status: string; startedAt: string; endedAt: string | null; dialsCount: number };
  dials: number;
  connected: number;
  talkSeconds: number;
  avgWrapUpSeconds: number;
  outcomes: Array<{ key: string; label: string; count: number }>;
  queue: { dueNow: number; total: number; unavailable: Record<string, number | boolean> } | null;
  reason: "list_empty" | "ended";
}

const DialerContext = createContext<Ctx | null>(null);

function getBrowserSessionId() {
  if (typeof window === "undefined") return "ssr";
  try {
    let id = sessionStorage.getItem("dialer.browserSessionId");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("dialer.browserSessionId", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function DialerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialerStateDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<Ctx["lastError"]>(null);
  const [sessionTakenOver, setSessionTakenOver] = useState(false);
  const [countdown, setCountdown] = useState<Ctx["countdown"]>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [monitor, setMonitor] = useState<MonitorDto | null>(null);
  const [supMedia, setSupMedia] = useState<"none" | "ringing" | "active" | "ended">("none");
  const [volume, setVolumeState] = useState(1);
  const monitorRef = useRef<MonitorDto | null>(null);
  const whisperingRef = useRef(false);
  const browserSessionId = useMemo(() => getBrowserSessionId(), []);

  // ── Phone (WebRTC) state ─────────────────────────────────────────────
  const connectionGeneration = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phoneStatus, setPhoneStatus] = useState<PhoneStatus>("idle");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [micPermission, setMicPermission] = useState<MicPermission>("unknown");
  const [muted, setMuted] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("");
  const [speakerId, setSpeakerId] = useState<string>("");
  const clientRef = useRef<SdkClient | null>(null);
  const sdkCallRef = useRef<SdkCall | null>(null);
  const stateRef = useRef<DialerStateDto | null>(null);
  const ownsCallRef = useRef<Set<string>>(new Set());
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const emptyQueueRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advancePowerRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshSeq = useRef(0);
  const appliedSeq = useRef(0);
  const connectPhoneRef = useRef<() => Promise<void>>(async () => undefined);
  const canSelectSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const handleErr = useCallback((err: unknown, fallback = "שגיאה") => {
    const e = err instanceof ApiClientError ? { code: err.code, message: err.message } : { code: "error", message: fallback };
    setLastError(e);
    toast.error(e.message);
    return e;
  }, []);

  // ── State polling ────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const s = await api.get<DialerStateDto>(`/api/dialer/state?browserSessionId=${browserSessionId}`);
      // Responses can arrive out of order on a slow network – never let an older one win.
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      // Keep the ref in sync immediately: callers read stateRef right after awaiting refresh().
      stateRef.current = s;
      setState(s);
      setError(null);
      if (s.session && s.session.ownedByThisTab === false) setSessionTakenOver(true);
      else setSessionTakenOver(false);
      if (s.monitor) { monitorRef.current = s.monitor; setMonitor(s.monitor); }
      else if (monitorRef.current && !monitorRef.current.endedAt) {
        // server says no active monitor any more (call ended / left elsewhere) – fetch the final record once
        api.get<MonitorDto>(`/api/manager/monitor/${monitorRef.current.id}`).then((m) => { monitorRef.current = m; setMonitor(m); whisperingRef.current = false; setSupMedia((x) => (x === "active" || x === "ringing" ? "ended" : x)); }).catch(() => { monitorRef.current = null; setMonitor(null); });
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) return;
      setError("אין חיבור לשרת");
    } finally {
      setLoading(false);
    }
  }, [browserSessionId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (!alive) return;
      const s = stateRef.current;
      const active = Boolean(s?.activeCall) || (s?.session && s.session.status !== "ended");
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      timer = setTimeout(loop, s?.activeCall ? 1200 : active ? 2500 : hidden ? 15000 : 6000);
    };
    loop();
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // ── Heartbeat (renews lead lock, proves the tab is alive) ────────────
  useEffect(() => {
    const t = setInterval(async () => {
      const s = stateRef.current;
      if (!s) return;
      if (!s.session && !s.lead) return;
      if (s.session && s.session.ownedByThisTab === false) return;
      try {
        const r = await api.post<{ sessionOk: boolean; reason?: string }>("/api/dialer/heartbeat", { sessionId: s.session?.id ?? null, browserSessionId });
        if (!r.sessionOk && r.reason === "session_taken") setSessionTakenOver(true);
      } catch {
        /* next tick */
      }
    }, 15000);
    return () => clearInterval(t);
  }, [browserSessionId]);

  // ── Cross-tab notification ───────────────────────────────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("dialer");
    ch.onmessage = (ev) => {
      if (ev.data?.type === "session-started" && ev.data.browserSessionId !== browserSessionId) {
        setSessionTakenOver(true);
        refresh();
      }
    };
    return () => ch.close();
  }, [browserSessionId, refresh]);

  // ── WebRTC connection ────────────────────────────────────────────────
  const loadDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all.filter((d) => d.kind === "audioinput"));
      setOutputs(all.filter((d) => d.kind === "audiooutput"));
    } catch {
      /* ignore */
    }
  }, []);

  const requestMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicPermission("granted");
      await loadDevices();
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMicPermission("denied");
      setPhoneError(name === "NotFoundError" ? "לא נמצא מיקרופון במחשב" : "הדפדפן חסם גישה למיקרופון – אפשר הרשאה בסרגל הכתובת ורענן");
    }
  }, [loadDevices]);

  const connectPhone = useCallback(async () => {
    if (typeof window === "undefined") return;
    const generation = ++connectionGeneration.current;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
    setPhoneError(null);
    setPhoneStatus("connecting");
    let tok: { provider: string; simulation: boolean; token: string; sipUsername: string };
    try {
      tok = await api.post("/api/telephony/token");
    } catch (err) {
      setPhoneStatus("error");
      setPhoneError(err instanceof ApiClientError ? err.message : "לא ניתן לקבל אסימון טלפוניה");
      return;
    }
    if (generation !== connectionGeneration.current) return;
    if (tok.simulation) {
      setPhoneStatus("simulation");
      await requestMic();
      return;
    }
    await requestMic();
    try {
      const mod = await import("@telnyx/webrtc");
      if (generation !== connectionGeneration.current) return;
      const TelnyxRTC = mod.TelnyxRTC as unknown as new (o: { login_token: string; prefetchIceCandidates?: boolean }) => SdkClient;
      if (clientRef.current) {
        try {
          const previous = clientRef.current;
          clientRef.current = null;
          for (const event of ["telnyx.ready", "telnyx.error", "telnyx.socket.close", "telnyx.notification"]) previous.off(event);
          await previous.disconnect();
        } catch {
          /* ignore */
        }
      }
      const client = new TelnyxRTC({ login_token: tok.token, prefetchIceCandidates: true });
      client.remoteElement = "remote-audio";
      client.on("telnyx.ready", () => {
        setPhoneStatus("ready");
        setPhoneError(null);
      });
      client.on("telnyx.error", (e: unknown) => {
        const msg = (e as { message?: string })?.message ?? "שגיאת טלפוניה";
        setPhoneError(msg);
        setPhoneStatus("error");
      });
      client.on("telnyx.socket.close", () => {
        setPhoneStatus("disconnected");
        if (clientRef.current !== client || generation !== connectionGeneration.current) return;
        reconnectTimer.current = setTimeout(() => {
          if (clientRef.current === client && generation === connectionGeneration.current) connectPhoneRef.current();
        }, 3000);
      });
      client.on("telnyx.notification", (n: unknown) => {
        const note = n as { type: string; call?: SdkCall; error?: { message?: string } };
        if (note.type === "userMediaError") {
          setMicPermission("denied");
          setPhoneError("אין גישה למיקרופון");
          return;
        }
        if (note.type !== "callUpdate" || !note.call) return;
        const call = note.call;
        sdkCallRef.current = call;
        // The server dials the agent leg; the browser must answer it – but only in the tab that drives the session/call.
        if (call.direction === "inbound" && call.state === "ringing") {
          const s = stateRef.current;
          const ownsSession = s?.session ? s.session.ownedByThisTab !== false : true;
          const ownsCall = s?.activeCall ? ownsCallRef.current.has(s.activeCall.id) || ownsSession : ownsSession;
          // Supervisor leg: the manager asked to listen – answer and keep the mic muted (provider enforces monitor role too).
          const m = monitorRef.current;
          if (m && !m.endedAt && m.status === "connecting") {
            setSupMedia("ringing");
            call.answer().then(() => { try { call.muteAudio(); } catch { /* ignore */ } }).catch(() => setPhoneError("לא ניתן לענות ל-leg ההאזנה"));
            return;
          }
          // Customer-initiated (inbound) calls are NOT auto-answered – the agent accepts or rejects in the UI.
          const isCustomerInbound = s?.activeCall?.direction === "inbound";
          if (ownsCall && !isCustomerInbound) call.answer().catch(() => setPhoneError("לא ניתן לענות לשיחה בדפדפן"));
        }
        if (monitorRef.current && !monitorRef.current.endedAt) {
          if (call.state === "active") setSupMedia("active");
          if (call.state === "hangup" || call.state === "destroy") setSupMedia("ended");
        }
        if (call.state === "hangup" || call.state === "destroy") {
          if (sdkCallRef.current?.id === call.id) sdkCallRef.current = null;
          setMuted(false);
        }
      });
      clientRef.current = client;
      await client.connect();
      // Token lasts 24h – refresh the registration well before that.
      if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
      tokenRefreshTimer.current = setTimeout(() => clientRef.current === client && connectPhoneRef.current(), 20 * 3600 * 1000);
    } catch (err) {
      setPhoneStatus("error");
      setPhoneError((err as Error)?.message ?? "שגיאה בחיבור הטלפוניה");
    }
  }, [requestMic]);

  useEffect(() => {
    connectPhoneRef.current = connectPhone;
  }, [connectPhone]);

  useEffect(() => {
    connectPhone();
    return () => {
      // Invalidate all pending registrations, including reconnects started after mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      connectionGeneration.current++;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
      try {
        const client = clientRef.current;
        clientRef.current = null;
        if (client) {
          for (const event of ["telnyx.ready", "telnyx.error", "telnyx.socket.close", "telnyx.notification"]) client.off(event);
          client.disconnect().catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMic = useCallback(async (id: string) => {
    setMicId(id);
    try {
      localStorage.setItem("dialer.micId", id);
    } catch {
      /* ignore */
    }
    if (clientRef.current) await clientRef.current.setAudioSettings({ micId: id, echoCancellation: true, noiseSuppression: true, autoGainControl: true }).catch(() => undefined);
  }, []);

  const setSpeaker = useCallback((id: string) => {
    setSpeakerId(id);
    try {
      localStorage.setItem("dialer.speakerId", id);
    } catch {
      /* ignore */
    }
    if (clientRef.current) clientRef.current.speaker = id;
    const el = document.getElementById("remote-audio") as (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    el?.setSinkId?.(id).catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      const m = localStorage.getItem("dialer.micId");
      const s = localStorage.getItem("dialer.speakerId");
      if (m) setMicId(m);
      if (s) setSpeakerId(s);
    } catch {
      /* ignore */
    }
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
  }, [loadDevices]);

  const toggleMute = useCallback(() => {
    const c = sdkCallRef.current;
    setMuted((m) => {
      const next = !m;
      if (c) (next ? c.muteAudio : c.unmuteAudio).call(c);
      return next;
    });
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────
  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(null);
  }, []);

  const dial = useCallback(
    async (input: DialInput): Promise<CallDto | null> => {
      cancelCountdown();
      const s = stateRef.current;
      const idempotencyKey = crypto.randomUUID();
      setBusy("dial");
      try {
        const call = await api.post<CallDto>("/api/dialer/call", {
          idempotencyKey,
          ...input,
          sessionId: s?.session && s.session.status !== "ended" ? s.session.id : undefined,
          browserSessionId,
        });
        ownsCallRef.current.clear();
        ownsCallRef.current.add(call.id);
        setMuted(false);
        await refresh();
        return call;
      } catch (err) {
        const e = handleErr(err, "שגיאה בחיוג");
        if (e.code === "call_active") await refresh();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [browserSessionId, cancelCountdown, handleErr, refresh],
  );

  const nextLead = useCallback(async (): Promise<LeadDto | null> => {
    const s = stateRef.current;
    if (!s?.session) return null;
    setBusy("next");
    try {
      const lead = await api.post<LeadDto | null>("/api/dialer/next-lead", { sessionId: s.session.id, browserSessionId });
      await refresh();
      return lead;
    } catch (err) {
      const e = handleErr(err, "שגיאה במשיכת ליד");
      if (e.code === "session_taken") setSessionTakenOver(true);
      await refresh();
      return null;
    } finally {
      setBusy(null);
    }
  }, [browserSessionId, handleErr, refresh]);

  /** Power loop step: pull the next lead and dial it. */
  const advancePower = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.session || s.session.mode !== "power" || s.session.status !== "active") return;
    const lead = s.lead && s.lead.status === "locked" ? s.lead : await nextLead();
    if (!lead) {
      // Nothing due. If the list is truly exhausted (nothing waiting for a retry window either) end the session with a real summary.
      const q = stateRef.current?.queue;
      const nothingLater = !q || (q.total > 0 && q.dueIgnoringWindow === 0 && (q.unavailable?.notDueYet ?? 0) === 0 && !q.unavailable?.outsideDialWindow && (q.unavailable?.inProgress ?? 0) === 0);
      if (nothingLater && s.session) {
        try {
          const sum = await api.get<SessionSummary>(`/api/dialer/session/summary?sessionId=${s.session.id}`);
          await api.delete("/api/dialer/session", { sessionId: s.session.id, browserSessionId });
          await refresh();
          setSessionSummary({ ...sum, reason: "list_empty" });
        } catch (err) {
          handleErr(err);
        }
        return;
      }
      toast.info(q?.unavailable?.outsideDialWindow ? "מחוץ לחלון החיוג של הרשימה – בודק שוב בעוד 30 שניות" : "אין לידים זמינים כרגע – בודק שוב בעוד 30 שניות");
      if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
      emptyQueueRetry.current = setTimeout(() => advancePowerRef.current(), 30000);
      return;
    }
    const latest = stateRef.current;
    if (!latest?.session || latest.session.status !== "active" || latest.session.ownedByThisTab === false || latest.activeCall || latest.wrapUpCall) return;
    await dial({ mode: "power", leadId: lead.id, lockToken: lead.lockToken ?? undefined });
  }, [dial, nextLead, browserSessionId, handleErr, refresh]);
  useEffect(() => {
    advancePowerRef.current = advancePower;
  }, [advancePower]);

  const startCountdown = useCallback(
    (seconds: number, leadId: string | null, then: () => void) => {
      cancelCountdown();
      if (seconds <= 0) {
        then();
        return;
      }
      let left = seconds;
      setCountdown({ secondsLeft: left, leadId });
      countdownTimer.current = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          cancelCountdown();
          then();
        } else setCountdown({ secondsLeft: left, leadId });
      }, 1000);
    },
    [cancelCountdown],
  );

  const startSession = useCallback(
    async (mode: DialMode, listId?: string, countdownSeconds?: number) => {
      setBusy("session");
      try {
        await api.post("/api/dialer/session", { mode, listId, browserSessionId, countdownSeconds });
        setSessionTakenOver(false);
        try {
          const channel = new BroadcastChannel("dialer");
          channel.postMessage({ type: "session-started", browserSessionId });
          channel.close();
        } catch {
          /* ignore */
        }
        await refresh();
        if (mode === "power") {
          const secs = stateRef.current?.session?.countdownSeconds ?? countdownSeconds ?? 3;
          startCountdown(Math.min(secs, 3), null, () => advancePower());
        } else if (mode === "preview") {
          await nextLead();
        }
      } catch (err) {
        handleErr(err, "שגיאה בהתחלת סשן");
      } finally {
        setBusy(null);
      }
    },
    [advancePower, browserSessionId, handleErr, nextLead, refresh, startCountdown],
  );

  const pauseSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.session) return;
    cancelCountdown();
    if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
    try {
      await api.patch("/api/dialer/session", { sessionId: s.session.id, browserSessionId, action: "pause" });
      await refresh();
    } catch (err) {
      handleErr(err);
    }
  }, [browserSessionId, cancelCountdown, handleErr, refresh]);

  const resumeSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.session) return;
    try {
      await api.patch("/api/dialer/session", { sessionId: s.session.id, browserSessionId, action: "resume" });
      await refresh();
      const st = stateRef.current;
      if (st?.session?.mode === "power" && !st.activeCall && !st.wrapUpCall) startCountdown(st.session.countdownSeconds, st.lead?.id ?? null, () => advancePower());
    } catch (err) {
      handleErr(err);
    }
  }, [advancePower, browserSessionId, handleErr, refresh, startCountdown]);

  const endSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.session) return;
    cancelCountdown();
    if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
    try {
      const sum = await api.get<SessionSummary>(`/api/dialer/session/summary?sessionId=${s.session.id}`).catch(() => null);
      await api.delete("/api/dialer/session", { sessionId: s.session.id, browserSessionId });
      await refresh();
      if (sum && sum.dials > 0) setSessionSummary({ ...sum, reason: "ended" });
    } catch (err) {
      handleErr(err);
    }
  }, [browserSessionId, cancelCountdown, handleErr, refresh]);

  const acceptInbound = useCallback(async () => {
    const c = stateRef.current?.activeCall;
    if (!c || c.direction !== "inbound") return;
    setBusy("accept");
    try {
      try {
        await sdkCallRef.current?.answer();
      } catch {
        /* simulation has no SDK leg */
      }
      await api.post(`/api/dialer/call/${c.id}/accept`);
      await refresh();
    } catch (err) {
      handleErr(err, "שגיאה בקבלת השיחה");
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh]);

  const rejectInbound = useCallback(async () => {
    const c = stateRef.current?.activeCall;
    if (!c || c.direction !== "inbound") return;
    setBusy("reject");
    try {
      try {
        await sdkCallRef.current?.hangup();
      } catch {
        /* ignore */
      }
      await api.post(`/api/dialer/call/${c.id}/reject`);
      await refresh();
    } catch (err) {
      handleErr(err, "שגיאה בדחיית השיחה");
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh]);

  const skipLead = useCallback(
    async (reason: string) => {
      const s = stateRef.current;
      if (!s?.lead) return;
      cancelCountdown();
      try {
        await api.post("/api/dialer/skip", { leadId: s.lead.id, lockToken: s.lead.lockToken, reason });
        await refresh();
        if (s.session?.mode === "preview") await nextLead();
        else if (s.session?.mode === "power" && s.session.status === "active") startCountdown(s.session.countdownSeconds, null, () => advancePower());
      } catch (err) {
        handleErr(err, "שגיאה בדילוג");
        await refresh();
      }
    },
    [advancePower, cancelCountdown, handleErr, nextLead, refresh, startCountdown],
  );

  const hangup = useCallback(async () => {
    const s = stateRef.current;
    const call = s?.activeCall;
    if (!call) return;
    setBusy("hangup");
    try {
      try {
        await sdkCallRef.current?.hangup();
      } catch {
        /* server hangup below is authoritative */
      }
      await api.post(`/api/dialer/call/${call.id}/hangup`);
      await refresh();
    } catch (err) {
      handleErr(err, "שגיאה בניתוק");
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh]);

  const sendDtmf = useCallback(
    async (digit: string) => {
      const s = stateRef.current;
      if (!s?.activeCall || s.activeCall.status !== "answered") return;
      // One transport per keypress: sending through both SDK and server duplicates tones.
      try {
        await api.post(`/api/dialer/call/${s.activeCall.id}/dtmf`, { digits: digit });
      } catch (err) {
        handleErr(err, "שליחת מקש לשיחה נכשלה");
      }
    },
    [handleErr],
  );

  const saveOutcome = useCallback<Ctx["saveOutcome"]>(
    async (callId, outcome, opts) => {
      setBusy("outcome");
      try {
        await api.post(`/api/dialer/call/${callId}/outcome`, { outcome, note: opts?.note, callbackAt: opts?.callbackAt?.toISOString(), contactUpdates: opts?.contactUpdates });
        await refresh();
        const s = stateRef.current;
        if (s?.session?.mode === "power" && s.session.status === "active" && !s.activeCall) {
          startCountdown(s.session.countdownSeconds, null, () => advancePower());
        } else if (s?.session?.mode === "preview" && s.session.status === "active" && !s.lead) {
          await nextLead();
        }
      } catch (err) {
        handleErr(err, "שגיאה בשמירת תוצאה");
        throw err;
      } finally {
        setBusy(null);
      }
    },
    [advancePower, handleErr, nextLead, refresh, startCountdown],
  );

  // Stop any pending auto-advance if the tab lost the session, the session ended, or a call (e.g. inbound) is live.
  useEffect(() => {
    if (sessionTakenOver || !state?.session || state.session.status !== "active" || state.activeCall) {
      if (countdownTimer.current) cancelCountdown();
      if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
    }
  }, [sessionTakenOver, state?.session, state?.activeCall, cancelCountdown]);

  const supRefresh = useCallback(async () => {
    const m = monitorRef.current;
    if (!m) return null;
    try {
      const fresh = await api.get<MonitorDto>(`/api/manager/monitor/${m.id}`);
      monitorRef.current = fresh;
      setMonitor(fresh);
      if (fresh.endedAt) { whisperingRef.current = false; setSupMedia((x) => (x === "none" ? x : "ended")); }
      return fresh;
    } catch {
      return m;
    }
  }, []);
  const supStart = useCallback(async (callId: string) => {
    if (monitorRef.current && !monitorRef.current.endedAt) {
      if (monitorRef.current.callId === callId) return monitorRef.current;
      throw new ApiClientError("אתה כבר מחובר לשיחה אחרת – צא ממנה קודם", 409, "monitor_active");
    }
    setSupMedia("none");
    const m = await api.post<MonitorDto>("/api/manager/monitor", { callId });
    monitorRef.current = m;
    setMonitor(m);
    if (phoneStatus === "simulation") setSupMedia("active"); // no real media in simulation – marked as such in the UI
    return m;
  }, [phoneStatus]);
  const supStop = useCallback(async () => {
    const m = monitorRef.current;
    if (!m) return;
    whisperingRef.current = false;
    try { sdkCallRef.current?.muteAudio(); } catch { /* ignore */ }
    try { await sdkCallRef.current?.hangup(); } catch { /* server hangup below is authoritative */ }
    try {
      const done = await api.delete<MonitorDto>(`/api/manager/monitor/${m.id}`);
      monitorRef.current = done;
      setMonitor(done);
    } catch (err) {
      // A failed server disconnect leaves a retryable active monitor.
      setSupMedia("none");
      throw err;
    }
    setSupMedia("ended");
    sdkCallRef.current = null;
  }, []);
  const supWhisperOn = useCallback(async () => {
    const m = monitorRef.current;
    if (!m || m.endedAt || m.status === "connecting" || whisperingRef.current) return;
    whisperingRef.current = true;
    let upd: MonitorDto;
    try { upd = await api.patch<MonitorDto>(`/api/manager/monitor/${m.id}`, { mode: "whisper" }); }
    catch (err) { whisperingRef.current = false; throw err; }
    monitorRef.current = upd; setMonitor(upd);
    if (whisperingRef.current) { try { sdkCallRef.current?.unmuteAudio(); } catch { /* ignore */ } }
  }, []);
  const supWhisperOff = useCallback(async () => {
    const m = monitorRef.current;
    try { sdkCallRef.current?.muteAudio(); } catch { /* ignore */ } // mic off immediately
    if (!m || m.endedAt || !whisperingRef.current) return;
    whisperingRef.current = false;
    try {
      const upd = await api.patch<MonitorDto>(`/api/manager/monitor/${m.id}`, { mode: "listen" });
      monitorRef.current = upd; setMonitor(upd);
    } catch { /* refresh will resync */ }
  }, []);
  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    const el = document.getElementById("remote-audio") as HTMLMediaElement | null;
    if (el) el.volume = Math.max(0, Math.min(1, v));
  }, []);
  // Any loss of focus / page hide ends a whisper (mic must never stay open by accident).
  useEffect(() => {
    const off = () => { if (whisperingRef.current) supWhisperOff(); };
    window.addEventListener("blur", off);
    document.addEventListener("visibilitychange", off);
    window.addEventListener("pagehide", off);
    return () => { window.removeEventListener("blur", off); document.removeEventListener("visibilitychange", off); window.removeEventListener("pagehide", off); };
  }, [supWhisperOff]);

  const value: Ctx = {
    state,
    loading,
    error,
    refresh,
    browserSessionId,
    sessionTakenOver,
    phone: {
      status: phoneStatus,
      error: phoneError,
      micPermission,
      muted,
      inputs,
      outputs,
      micId,
      speakerId,
      canSelectSpeaker,
      setMic,
      setSpeaker,
      toggleMute,
      reconnect: connectPhone,
      requestMic,
    },
    busy,
    startSession,
    pauseSession,
    resumeSession,
    endSession,
    nextLead,
    skipLead,
    dial,
    hangup,
    sendDtmf,
    saveOutcome,
    countdown,
    cancelCountdown,
    lastError,
    acceptInbound,
    rejectInbound,
    sessionSummary,
    dismissSummary: () => setSessionSummary(null),
    supervisor: { monitor, media: supMedia, start: supStart, stop: supStop, whisperOn: supWhisperOn, whisperOff: supWhisperOff, refresh: supRefresh, setVolume, volume },
  };

  return (
    <DialerContext.Provider value={value}>
      {/* Remote audio sink for the WebRTC agent leg. Must exist before the SDK connects. */}
      <audio id="remote-audio" autoPlay playsInline />
      {children}
    </DialerContext.Provider>
  );
}

export function useDialer() {
  const ctx = useContext(DialerContext);
  if (!ctx) throw new Error("useDialer must be used inside DialerProvider");
  return ctx;
}
