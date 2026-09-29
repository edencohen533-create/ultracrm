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
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/client/api";
import type { CallDto, DialerStateDto, DialMode, LeadDto, MonitorDto, OutcomeKey } from "@/lib/client/types";
import { useT } from "@/components/i18n/LangProvider";

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
  saveOutcome: (callId: string, outcome: OutcomeKey, opts?: { note?: string; callbackAt?: Date; callbackUserId?: string; contactUpdates?: Record<string, string | undefined> }) => Promise<void>;
  /** After a hang-up: save the outcome and dial the next lead of the session right away (no wrap-up screen, no countdown). */
  continueToNext: (callId: string, outcome: OutcomeKey, opts?: { note?: string }) => Promise<void>;
  countdown: { secondsLeft: number; leadId: string | null } | null;
  cancelCountdown: () => void;
  lastError: { code: string; message: string } | null;
  acceptInbound: () => Promise<void>;
  rejectInbound: () => Promise<void>;
  sessionSummary: SessionSummary | null;
  dismissSummary: () => void;
  /** "No leads available right now" for this agent in the session's campaign (server-classified). */
  emptyState: EmptyState | null;
  refreshEmptyState: () => Promise<EmptyState | null>;
  /** Re-check permission on the server, end the session (never during a call) and open the launcher on that campaign. */
  switchCampaign: (listId: string) => Promise<void>;
  /** Supervisor (manager) listen / whisper. */
  supervisor: {
    monitor: MonitorDto | null;
    /** Browser-side media state of the supervisor leg: none | ringing | active | ended. */
    media: "none" | "ringing" | "active" | "ended";
    start: (callId: string) => Promise<MonitorDto | null>;
    stop: () => Promise<void>;
    whisperOn: () => Promise<void>;
    joinConversation: () => Promise<void>;
    whisperOff: () => Promise<void>;
    refresh: () => Promise<MonitorDto | null>;
    setVolume: (v: number) => void;
    volume: number;
  };
}

export interface EmptyState {
  availability: { state: "available" | "waiting" | "exhausted" | "blocked"; availableNow: number; waiting: number; nextAt: string | null; reason: string | null; exhaustedCount: number; listId: string; listName: string };
  campaigns: Array<{ id: string; name: string; availableNow: number; nextAt: string | null; state: string }>;
  dueElsewhere: Array<{ listId: string; listName: string; n: number }>;
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

/** `enabled=false` (telephony module off): no WebRTC registration and no state polling; the context still renders. */
/** Zadarma's official widget scripts (zadarma.com/en/support/instructions/crm-zadarma/, checked 2026-09-29). */
const ZADARMA_WIDGET_SCRIPTS = ["https://my.zadarma.com/webphoneWebRTCWidget/v8/js/loader-phone-lib.js?v=17", "https://my.zadarma.com/webphoneWebRTCWidget/v8/js/loader-phone-fn.js?v=17"];
let zadarmaScripts: Promise<void> | null = null;
function loadZadarmaWidget(): Promise<void> {
  if (!zadarmaScripts) zadarmaScripts = ZADARMA_WIDGET_SCRIPTS.reduce((prev, src) => prev.then(() => new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = false;
    el.onload = () => resolve();
    el.onerror = () => { zadarmaScripts = null; reject(new Error("script blocked or unreachable")); };
    document.body.appendChild(el);
  })), Promise.resolve());
  return zadarmaScripts;
}

export function DialerProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const t = useT();
  const [state, setState] = useState<DialerStateDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<Ctx["lastError"]>(null);
  const [sessionTakenOver, setSessionTakenOver] = useState(false);
  const [countdown, setCountdown] = useState<Ctx["countdown"]>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [emptyState, setEmptyState] = useState<EmptyState | null>(null);
  const [monitor, setMonitor] = useState<MonitorDto | null>(null);
  const [supMedia, setSupMedia] = useState<"none" | "ringing" | "active" | "ended">("none");
  const [volume, setVolumeState] = useState(1);
  const monitorRef = useRef<MonitorDto | null>(null);
  const whisperingRef = useRef(false);
  const speakingGeneration = useRef(0);
  const modeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const browserSessionId = useMemo(() => getBrowserSessionId(), []);
  const router = useRouter();

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
  /** Provider this browser is registered with – sent with every dial so the server can ask for a reconnect after a switch. */
  const agentProviderRef = useRef<string | null>(null);
  const zadarmaLoadedRef = useRef(false);
  const canSelectSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const handleErr = useCallback((err: unknown, fallback = t("שגיאה", "Error")) => {
    const e = err instanceof ApiClientError ? { code: err.code, message: err.message } : { code: "error", message: fallback };
    setLastError(e);
    toast.error(e.message);
    return e;
  }, [t]);

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
      setError(t("אין חיבור לשרת", "No server connection"));
    } finally {
      setLoading(false);
    }
  }, [browserSessionId, t]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
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
  }, [refresh, enabled]);

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
      stream.getTracks().forEach((tr) => tr.stop());
      setMicPermission("granted");
      await loadDevices();
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMicPermission("denied");
      setPhoneError(name === "NotFoundError" ? t("לא נמצא מיקרופון במחשב", "No microphone found on this computer") : t("הדפדפן חסם גישה למיקרופון – אפשר הרשאה בסרגל הכתובת ורענן", "The browser blocked microphone access – allow it in the address bar and refresh"));
    }
  }, [loadDevices, t]);

  const connectPhone = useCallback(async () => {
    if (typeof window === "undefined") return;
    const generation = ++connectionGeneration.current;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
    setPhoneError(null);
    setPhoneStatus("connecting");
    let tok: { provider: string; agentClient?: string; simulation: boolean; token: string; sipUsername: string };
    try {
      tok = await api.post("/api/telephony/token");
    } catch (err) {
      setPhoneStatus("error");
      setPhoneError(err instanceof ApiClientError ? err.message : t("לא ניתן לקבל אסימון טלפוניה", "Could not get a telephony token"));
      return;
    }
    if (generation !== connectionGeneration.current) return;
    const previousProvider = agentProviderRef.current;
    agentProviderRef.current = tok.provider;
    // The Zadarma widget cannot be unloaded from a page: going back to Telnyx needs a clean page.
    if (zadarmaLoadedRef.current && tok.agentClient !== "zadarma-widget") { window.location.reload(); return; }
    if (!tok.simulation && tok.agentClient === "zadarma-widget") {
      // Backup provider (Zadarma): its official WebRTC widget registers this browser on the agent's PBX extension.
      // Zadarma rings the extension first; the agent answers and hangs up in the widget (no server-side control).
      try {
        if (clientRef.current) { try { const prev = clientRef.current; clientRef.current = null; await prev.disconnect(); } catch { /* ignore */ } }
        await loadZadarmaWidget();
        if (generation !== connectionGeneration.current) return;
        (window as unknown as { zadarmaWidgetFn: (...a: unknown[]) => void }).zadarmaWidgetFn(tok.token, tok.sipUsername, "square", "en", true, "{right:'10px',bottom:'5px'}");
        zadarmaLoadedRef.current = true;
        await requestMic();
        setPhoneStatus("ready");
        setPhoneError(null);
        if (previousProvider !== tok.provider) toast.warning(t("הטלפוניה עברה לספק הגיבוי Zadarma: עונים ומנתקים בחלון הטלפון של Zadarma בפינת המסך. אין האזנת מנהל ואין ניתוק מהמערכת.", "Telephony moved to the backup provider Zadarma: answer and hang up in the Zadarma phone in the corner. No supervisor listening and no hang-up from the app."), { duration: 15000 });
      } catch (err) {
        setPhoneStatus("error");
        setPhoneError(t(`טעינת הטלפון של Zadarma נכשלה: ${(err as Error).message}`, `Loading the Zadarma phone failed: ${(err as Error).message}`));
      }
      return;
    }
    // Only the Telnyx WebRTC and Zadarma widget clients exist. Another provider needs its own client – never fall back to Telnyx silently.
    if (!tok.simulation && tok.agentClient && tok.agentClient !== "telnyx-webrtc") {
      setPhoneStatus("error");
      setPhoneError(t(`ספק הטלפוניה "${tok.provider}" דורש לקוח דפדפן (${tok.agentClient}) שעדיין לא מומש – לא ניתן לשמוע שיחות דרכו`, `Telephony provider "${tok.provider}" needs a browser client (${tok.agentClient}) that is not implemented yet – calls cannot be heard through it`));
      return;
    }
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
        const msg = (e as { message?: string })?.message ?? t("שגיאת טלפוניה", "Telephony error");
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
          setPhoneError(t("אין גישה למיקרופון", "No microphone access"));
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
            call.answer().then(() => { try { call.muteAudio(); } catch { /* ignore */ } }).catch(() => setPhoneError(t("לא ניתן לענות ל-leg ההאזנה", "Could not answer the monitoring leg")));
            return;
          }
          // Customer-initiated (inbound) calls are NOT auto-answered – the agent accepts or rejects in the UI.
          const isCustomerInbound = s?.activeCall?.direction === "inbound";
          if (ownsCall && !isCustomerInbound) call.answer().catch(() => setPhoneError(t("לא ניתן לענות לשיחה בדפדפן", "Could not answer the call in the browser")));
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
      setPhoneError((err as Error)?.message ?? t("שגיאה בחיבור הטלפוניה", "Telephony connection error"));
    }
  }, [requestMic, t]);

  useEffect(() => {
    connectPhoneRef.current = connectPhone;
  }, [connectPhone]);

  useEffect(() => {
    if (enabled) connectPhone();
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
          agentProvider: agentProviderRef.current ?? undefined,
        });
        ownsCallRef.current.clear();
        ownsCallRef.current.add(call.id);
        setMuted(false);
        await refresh();
        return call;
      } catch (err) {
        const e = handleErr(err, t("שגיאה בחיוג", "Dial error"));
        if (e.code === "call_active") await refresh();
        // New calls moved to another provider: re-register this browser there, then the agent dials again.
        if (e.code === "agent_reregister_required") void connectPhoneRef.current();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [browserSessionId, cancelCountdown, handleErr, refresh, t],
  );

  const nextLead = useCallback(async (): Promise<LeadDto | null> => {
    const s = stateRef.current;
    if (!s?.session) return null;
    setBusy("next");
    try {
      const lead = await api.post<LeadDto | null>("/api/dialer/next-lead", { sessionId: s.session.id, browserSessionId });
      await refresh();
      if (lead) setEmptyState(null);
      else setEmptyState(await api.get<EmptyState>("/api/dialer/empty-state").catch(() => null));
      return lead;
    } catch (err) {
      const e = handleErr(err, t("שגיאה במשיכת ליד", "Error pulling a lead"));
      if (e.code === "session_taken") setSessionTakenOver(true);
      await refresh();
      return null;
    } finally {
      setBusy(null);
    }
  }, [browserSessionId, handleErr, refresh, t]);

  const refreshEmptyState = useCallback(async () => {
    const r = await api.get<EmptyState>("/api/dialer/empty-state").catch(() => null);
    setEmptyState(r && r.availability.state !== "available" ? r : null);
    return r;
  }, []);
  const switchCampaign = useCallback(async (listId: string) => {
    setBusy("switch");
    try {
      await api.post("/api/dialer/campaigns/switch", { listId, browserSessionId });
      setEmptyState(null);
      await refresh();
      router.push(`/dialer?listId=${encodeURIComponent(listId)}`);
    } catch (err) { handleErr(err, t("לא ניתן לעבור לקמפיין", "Could not switch campaign")); } finally { setBusy(null); }
  }, [browserSessionId, handleErr, refresh, router, t]);

  /** Power loop step: pull the next lead and dial it. */
  const advancePower = useCallback(async () => {
    const s = stateRef.current;
    if (!s?.session || s.session.mode !== "power" || s.session.status !== "active") return;
    const lead = s.lead && s.lead.status === "locked" ? s.lead : await nextLead();
    if (!lead) {
      // Nothing dialable now: the dialer STOPS in "אין לידים זמינים כרגע" (see emptyState – exhausted / waiting /
      // blocked). It never re-dials just to use up attempts and never moves the agent to another campaign by itself.
      if (emptyQueueRetry.current) clearTimeout(emptyQueueRetry.current);
      return;
    }
    const latest = stateRef.current;
    if (!latest?.session || latest.session.status !== "active" || latest.session.ownedByThisTab === false || latest.activeCall) return;
    await dial({ mode: "power", leadId: lead.id, lockToken: lead.lockToken ?? undefined });
  }, [dial, nextLead]);
  // A "זמינה עכשיו" reply arrived while the power dialer sits idle (queue was empty): dial her now – once per signal.
  // During a call / wrap-up nothing happens here: she is simply the next claim when the current call is documented.
  const autoDialed = useRef(new Set<string>());
  useEffect(() => {
    const s = state;
    const hot = s?.hot?.find((h) => h.status === "active" && h.mine && !autoDialed.current.has(h.id));
    if (!hot || !s?.session || s.session.mode !== "power" || s.session.status !== "active" || s.session.ownedByThisTab === false) return;
    if (s.activeCall || (s.lead && s.lead.status === "locked") || countdown || busy) return;
    autoDialed.current.add(hot.id);
    void advancePowerRef.current();
  }, [state, countdown, busy]);

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
        handleErr(err, t("שגיאה בהתחלת סשן", "Error starting session"));
      } finally {
        setBusy(null);
      }
    },
    [advancePower, browserSessionId, handleErr, nextLead, refresh, startCountdown, t],
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
      if (st?.session?.mode === "power" && !st.activeCall) startCountdown(st.session.countdownSeconds, st.lead?.id ?? null, () => advancePower());
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
      handleErr(err, t("שגיאה בקבלת השיחה", "Error accepting the call"));
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh, t]);

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
      handleErr(err, t("שגיאה בדחיית השיחה", "Error rejecting the call"));
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh, t]);

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
        handleErr(err, t("שגיאה בדילוג", "Error skipping"));
        await refresh();
      }
    },
    [advancePower, cancelCountdown, handleErr, nextLead, refresh, startCountdown, t],
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
      handleErr(err, t("שגיאה בניתוק", "Error hanging up"));
    } finally {
      setBusy(null);
    }
  }, [handleErr, refresh, t]);

  const sendDtmf = useCallback(
    async (digit: string) => {
      const s = stateRef.current;
      if (!s?.activeCall || s.activeCall.status !== "answered") return;
      // One transport per keypress: sending through both SDK and server duplicates tones.
      try {
        await api.post(`/api/dialer/call/${s.activeCall.id}/dtmf`, { digits: digit });
      } catch (err) {
        handleErr(err, t("שליחת מקש לשיחה נכשלה", "Sending a key to the call failed"));
      }
    },
    [handleErr, t],
  );

  const saveOutcome = useCallback<Ctx["saveOutcome"]>(
    async (callId, outcome, opts) => {
      setBusy("outcome");
      try {
        await api.post(`/api/dialer/call/${callId}/outcome`, { outcome, note: opts?.note, callbackAt: opts?.callbackAt?.toISOString(), callbackUserId: opts?.callbackUserId, contactUpdates: opts?.contactUpdates });
        await refresh();
        const s = stateRef.current;
        if (s?.session?.mode === "power" && s.session.status === "active" && !s.activeCall) {
          startCountdown(s.session.countdownSeconds, null, () => advancePower());
        } else if (s?.session?.mode === "preview" && s.session.status === "active" && !s.lead) {
          await nextLead();
        }
      } catch (err) {
        handleErr(err, t("שגיאה בשמירת תוצאה", "Error saving outcome"));
        throw err;
      } finally {
        setBusy(null);
      }
    },
    [advancePower, handleErr, nextLead, refresh, startCountdown, t],
  );

  const continueToNext = useCallback<Ctx["continueToNext"]>(
    async (callId, outcome, opts) => {
      setBusy("outcome");
      try {
        await api.post(`/api/dialer/call/${callId}/outcome`, { outcome, note: opts?.note });
      } catch (err) { handleErr(err, t("שגיאה בשמירת תוצאה", "Error saving outcome")); setBusy(null); throw err; }
      setBusy(null);
      await refresh();
      cancelCountdown();
      const s = stateRef.current;
      if (!s?.session || s.session.status !== "active" || s.session.mode === "manual" || s.activeCall) return;
      const lead = s.lead && s.lead.status === "locked" ? s.lead : await nextLead();
      if (!lead) { toast.info(t("אין כרגע לידים זמינים לחיוג בתור", "No leads available to dial in the queue right now")); return; }
      const latest = stateRef.current;
      if (!latest?.session || latest.session.status !== "active" || latest.activeCall) return;
      await dial({ mode: latest.session.mode, leadId: lead.id, lockToken: lead.lockToken ?? undefined });
    },
    [cancelCountdown, dial, handleErr, nextLead, refresh, t],
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
      throw new ApiClientError(t("אתה כבר מחובר לשיחה אחרת – צא ממנה קודם", "You are already connected to another call – leave it first"), 409, "monitor_active");
    }
    setSupMedia("none");
    const m = await api.post<MonitorDto>("/api/manager/monitor", { callId });
    monitorRef.current = m;
    setMonitor(m);
    if (phoneStatus === "simulation") setSupMedia("active"); // no real media in simulation – marked as such in the UI
    return m;
  }, [phoneStatus, t]);
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
  const supSpeak = useCallback(async (mode: "whisper" | "barge") => {
    const m = monitorRef.current;
    if (!m || m.endedAt || m.status === "connecting" || whisperingRef.current) return;
    whisperingRef.current = true;
    const generation = ++speakingGeneration.current;
    const request = modeQueue.current.catch(() => {}).then(() => api.patch<MonitorDto>(`/api/manager/monitor/${m.id}`, { mode }));
    modeQueue.current = request;
    try {
      const upd = await request;
      if (generation !== speakingGeneration.current || monitorRef.current?.id !== m.id || monitorRef.current.endedAt) return;
      monitorRef.current = upd; setMonitor(upd);
      if (whisperingRef.current) sdkCallRef.current?.unmuteAudio();
    } catch (err) {
      if (generation === speakingGeneration.current) { whisperingRef.current = false; try { sdkCallRef.current?.muteAudio(); } catch {} }
      throw err;
    }
  }, []);
  const supWhisperOn = useCallback(() => supSpeak("whisper"), [supSpeak]);
  const supJoinConversation = useCallback(() => supSpeak("barge"), [supSpeak]);
  const supWhisperOff = useCallback(async () => {
    const m = monitorRef.current;
    try { sdkCallRef.current?.muteAudio(); } catch {} // Stop local audio before any network wait.
    if (!m || m.endedAt) return;
    whisperingRef.current = false;
    const generation = ++speakingGeneration.current;
    const request = modeQueue.current.catch(() => {}).then(() => api.patch<MonitorDto>(`/api/manager/monitor/${m.id}`, { mode: "listen" }));
    modeQueue.current = request;
    const upd = await request;
    if (generation === speakingGeneration.current && monitorRef.current?.id === m.id && !monitorRef.current.endedAt) { monitorRef.current = upd; setMonitor(upd); }
  }, []);
  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    const el = document.getElementById("remote-audio") as HTMLMediaElement | null;
    if (el) el.volume = Math.max(0, Math.min(1, v));
  }, []);
  // Any loss of focus / page hide ends a whisper (mic must never stay open by accident).
  useEffect(() => {
    const off = () => { if (whisperingRef.current) void supWhisperOff().catch(() => {}); };
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
    continueToNext,
    countdown,
    cancelCountdown,
    lastError,
    acceptInbound,
    rejectInbound,
    sessionSummary,
    emptyState,
    refreshEmptyState,
    switchCampaign,
    dismissSummary: () => setSessionSummary(null),
    supervisor: { monitor, media: supMedia, start: supStart, stop: supStop, whisperOn: supWhisperOn, joinConversation: supJoinConversation, whisperOff: supWhisperOff, refresh: supRefresh, setVolume, volume },
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
