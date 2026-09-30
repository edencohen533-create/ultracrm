"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Panel, Select, Spinner } from "@/components/ui";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useT } from "@/components/i18n/LangProvider";

type Check = "not_run" | "ok" | "fail" | "running";
interface Ready { license: { telephony: boolean }; telephony: { simulation: boolean }; numbers: Array<{ e164: string; label: string | null; isDefault: boolean; verified: boolean }>; usableNumbers: number; lists: Array<{ id: string; name: string; availableNow: number; waiting: number; nextAt: string | null; reason: string | null; blocked?: boolean }>; followUpsDue: number; blockers: Array<{ code: string; text: string; fix: string }>; checkedAt: string }

/**
 * פתיחת משמרת – a short check the agent can open anytime (never a mandatory wizard). Browser checks run only when the
 * agent presses them and show "לא נבדק" until then; the local audio test never calls anyone.
 */
export function ShiftReadiness() {
  const t = useT(); const { phone } = useDialer();
  const [r, setR] = useState<Ready | null>(null); const [err, setErr] = useState("");
  const [mic, setMic] = useState<Check>("not_run"); const [micMsg, setMicMsg] = useState(""); const [devices, setDevices] = useState<MediaDeviceInfo[]>([]); const [device, setDevice] = useState("");
  const [level, setLevel] = useState(0); const [speaker, setSpeaker] = useState<Check>("not_run"); const [online, setOnline] = useState(true);
  const stop = useRef<(() => void) | null>(null);
  const load = useCallback(() => api.get<Ready>("/api/dialer/readiness").then((x) => { setR(x); setErr(""); }).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); setOnline(navigator.onLine); const on = () => setOnline(true), off = () => setOnline(false); window.addEventListener("online", on); window.addEventListener("offline", off); return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); stop.current?.(); }; }, [load]);

  async function testMic() {
    setMic("running"); setMicMsg(""); stop.current?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true });
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); setDevices(list);
      const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount); let peak = 0; let raf = 0;
      const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); peak = Math.max(peak, m); setLevel(Math.min(100, Math.round((m / 128) * 300))); raf = requestAnimationFrame(tick); };
      tick();
      stop.current = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((x) => x.stop()); void ctx.close(); };
      setTimeout(() => { stop.current?.(); stop.current = null; setLevel(0); if (peak > 4) { setMic("ok"); setMicMsg(t("המיקרופון קולט קול", "The microphone picks up sound")); } else { setMic("fail"); setMicMsg(t("לא נקלט קול – בדקו שהמיקרופון הנכון נבחר ולא מושתק", "No sound picked up – check the right microphone is selected and not muted")); } }, 4000);
    } catch (e) { setMic("fail"); setMicMsg((e as Error).name === "NotAllowedError" ? t("הדפדפן חסם את המיקרופון – אשרו גישה בסמל המנעול בשורת הכתובת", "The browser blocked the microphone – allow it from the lock icon in the address bar") : (e as Error).message); }
  }
  async function testSpeaker() {
    setSpeaker("running");
    try { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.08; o.frequency.value = 660; o.connect(g).connect(ctx.destination); o.start(); setTimeout(() => { o.stop(); void ctx.close(); }, 700); }
    catch { setSpeaker("fail"); return; }
    setTimeout(() => setSpeaker("not_run"), 60_000);
  }
  const badge = (c: Check, okText: string) => c === "ok" ? <Badge tone="good">{okText}</Badge> : c === "fail" ? <Badge tone="bad">{t("נכשל", "Failed")}</Badge> : c === "running" ? <Badge tone="info">{t("בודק…", "Checking…")}</Badge> : <Badge tone="neutral">{t("לא נבדק", "Not checked")}</Badge>;
  const phoneOk = phone.status === "ready" || phone.status === "simulation";

  return (
    <div className="p-4 md:p-5 space-y-3 max-w-3xl" data-testid="shift-ready">
      <div className="flex items-center gap-2"><h1 className="text-lg font-semibold">{t("פתיחת משמרת", "Start of shift")}</h1><Button size="sm" variant="ghost" onClick={() => void load()}>{t("רענון", "Refresh")}</Button></div>
      {err && <p role="alert" className="text-bad text-sm">{err}</p>}
      {!r ? <Spinner /> : (
        <>
          {r.blockers.length > 0 ? <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 space-y-1" data-testid="ready-blockers"><p className="font-semibold text-sm">{t("חסמים שמונעים עבודה", "Blockers")}</p>{r.blockers.map((b) => <p key={b.code} className="text-sm">• {b.text} – <span className="text-muted">{b.fix}</span></p>)}</div> : <p className="rounded-lg border border-good/40 bg-good/10 p-3 text-sm" data-testid="ready-ok">{t("אין חסמים מצד השרת. בדקו מיקרופון ושמע לפני שמתחילים.", "No server-side blockers. Check microphone and audio before starting.")}</p>}
          <Panel title={t("מכשיר ושמע (בדיקה מקומית – לא מתקשרת לאף אחד)", "Device & audio (local check – calls no one)")}>
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-32">{t("מיקרופון", "Microphone")}</span>{badge(mic, t("תקין", "OK"))}{devices.length > 0 && <Select aria-label={t("בחירת מיקרופון", "Choose microphone")} value={device} onChange={(e) => setDevice(e.target.value)} className="h-8 w-56"><option value="">{t("ברירת מחדל", "Default")}</option>{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}</Select>}<Button size="sm" variant="secondary" onClick={testMic} data-testid="ready-test-mic">{t("בדיקת מיקרופון (4 שניות – דברו)", "Test microphone (4s – speak)")}</Button></div>
              {mic === "running" && <div className="h-2 rounded bg-panel-2 overflow-hidden"><div className="h-2 bg-good transition-all" style={{ width: `${level}%` }} /></div>}
              {micMsg && <p className="text-xs text-muted">{micMsg}</p>}
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-32">{t("רמקול / אוזניות", "Speaker / headset")}</span><Button size="sm" variant="secondary" onClick={testSpeaker}>{t("השמע צליל בדיקה", "Play a test tone")}</Button>{speaker === "running" && <><span className="text-xs">{t("שמעתם?", "Did you hear it?")}</span><Button size="sm" variant="ghost" onClick={() => setSpeaker("ok")}>{t("כן", "Yes")}</Button><Button size="sm" variant="ghost" onClick={() => setSpeaker("fail")}>{t("לא", "No")}</Button></>}{speaker !== "running" && badge(speaker, t("תקין", "OK"))}</div>
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-32">{t("אינטרנט", "Internet")}</span>{online ? <Badge tone="good">{t("מחובר", "Online")}</Badge> : <Badge tone="bad">{t("מנותק", "Offline")}</Badge>}</div>
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-32">{t("טלפוניה בדפדפן", "Browser telephony")}</span>{phoneOk ? <Badge tone="good">{phone.status === "simulation" ? t("מחובר (הדמיה – ללא שיחות אמיתיות)", "Connected (simulation – no real calls)") : t("מחובר", "Connected")}</Badge> : <Badge tone={phone.status === "connecting" ? "info" : "bad"}>{phone.status === "connecting" ? t("מתחבר…", "Connecting…") : t("לא מחובר – רעננו את הדף", "Not connected – refresh the page")}</Badge>}</div>
            </div>
          </Panel>
          <Panel title={t("עבודה זמינה", "Available work")}>
            <div className="space-y-2 text-sm">
              <p>{t("מספר יוצא", "Outbound number")}: {r.numbers.length ? r.numbers.map((n) => <span key={n.e164} className="ltr me-2">{n.e164}{n.isDefault ? " ★" : ""}{!n.verified ? t(" (לא מאומת)", " (unverified)") : ""}</span>) : <b className="text-bad">{t("אין", "None")}</b>}</p>
              <p>{t("פולואפים שהגיע זמנם", "Follow-ups due")}: <b>{r.followUpsDue}</b></p>
              <ul className="space-y-1" data-testid="ready-lists">{r.lists.map((l) => <li key={l.id} className="flex flex-wrap items-center gap-2">{l.blocked ? <Badge tone="neutral">{t("לא זמינה", "Unavailable")}</Badge> : <Badge tone={l.availableNow ? "good" : "warn"}>{t(`${l.availableNow} זמינים עכשיו`, `${l.availableNow} available now`)}</Badge>}<Link href={`/calling/lists/${l.id}`} className="underline">{l.name}</Link>{l.waiting > 0 && <span className="text-xs text-muted">{t(`${l.waiting} ממתינים`, `${l.waiting} waiting`)}</span>}{l.reason && <span className="text-xs text-muted">{l.reason}</span>}</li>)}</ul>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
