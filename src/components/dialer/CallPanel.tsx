"use client";

import { useEffect, useState } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { callElapsed, useTicker } from "@/components/telephony/CallBar";
import { Badge, Button, Input, Kbd, Phone, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import { CALL_STATUS_LABEL, TELEPHONY_RESULT_LABEL, formatDuration, formatPhone, relativeTime } from "@/lib/client/format";
import type { CallDto } from "@/lib/client/types";

interface Recent {
  id: string;
  toE164: string;
  createdAt: string;
  telephonyResult: string | null;
  contact: { id: string; fullName: string } | null;
}

export function CallPanel({ onDialManual, canDialLead, onDialLead, onSkip }: { onDialManual: (phone: string) => void; canDialLead: boolean; onDialLead: () => void; onSkip?: () => void }) {
  const { state, phone, hangup, sendDtmf, busy, countdown, acceptInbound, rejectInbound } = useDialer();
  const call = state?.activeCall ?? null;
  const [manual, setManual] = useState("");
  const [keypad, setKeypad] = useState(false);
  const [devices, setDevices] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [numbers, setNumbers] = useState<Array<{ id: string; e164: string; label: string | null; isDefault: boolean }>>([]);
  useTicker(Boolean(call));

  useEffect(() => {
    api.get<Recent[]>("/api/dialer/recent").then(setRecent).catch(() => undefined);
    api.get<typeof numbers>("/api/phone-numbers").then((n) => setNumbers(n.filter((x) => (x as { isActive?: boolean }).isActive !== false))).catch(() => undefined);
  }, [call?.id]);

  const answered = call?.status === "answered";
  const inProgress = Boolean(call && !call.endedAt);
  const inboundRinging = Boolean(call && call.direction === "inbound" && !call.answeredAt && !call.endedAt);
  const connOk = phone.status === "ready" || phone.status === "simulation";
  const defaultNumber = numbers.find((n) => n.isDefault) ?? numbers[0];

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      {/* Connection */}
      <div className="p-3 border-b border-line space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">חיבור טלפוניה</span>
          <div className="flex items-center gap-2">
            {phone.status === "simulation" && <Badge tone="warn">מצב הדמיה – אין שיחות אמיתיות</Badge>}
            {phone.status === "ready" && <Badge tone="good" dot>מחובר</Badge>}
            {phone.status === "connecting" && <Badge tone="info">מתחבר…</Badge>}
            {(phone.status === "error" || phone.status === "disconnected") && <Badge tone="bad">{phone.status === "error" ? "שגיאה" : "מנותק"}</Badge>}
          </div>
        </div>
        {phone.error && (
          <div className="text-xs text-bad bg-bad/10 rounded-md p-2 flex items-center justify-between gap-2">
            <span>{phone.error}</span>
            <button onClick={phone.reconnect} className="underline shrink-0">התחבר מחדש</button>
          </div>
        )}
        {phone.micPermission === "denied" && !phone.error && (
          <div className="text-xs text-bad bg-bad/10 rounded-md p-2">אין הרשאת מיקרופון. אפשר גישה בדפדפן ולחץ <button onClick={phone.requestMic} className="underline">בקש שוב</button>.</div>
        )}
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">מספר יוצא</span>
          {defaultNumber ? <Phone value={formatPhone(defaultNumber.e164)} className="text-text" /> : <span className="text-bad">לא הוגדר מספר מורשה</span>}
        </div>
        <button onClick={() => setDevices((d) => !d)} className="text-[11px] text-muted hover:text-text">{devices ? "הסתר התקני שמע ▴" : "התקני שמע ▾"}</button>
        {devices && (
          <div className="space-y-2 text-xs">
            <label className="block">
              <span className="text-muted">מיקרופון</span>
              <select value={phone.micId} onChange={(e) => phone.setMic(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line">
                <option value="">ברירת מחדל</option>
                {phone.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "מיקרופון"}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-muted">רמקול {phone.canSelectSpeaker ? "" : "(הדפדפן לא תומך בבחירה)"}</span>
              <select disabled={!phone.canSelectSpeaker} value={phone.speakerId} onChange={(e) => phone.setSpeaker(e.target.value)} className="w-full h-8 mt-1 px-2 rounded-md bg-bg border border-line disabled:opacity-50">
                <option value="">ברירת מחדל</option>
                {phone.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "רמקול"}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Live call */}
      <div className={cx("p-4 border-b border-line", answered && "bg-good/5")}>
        {call ? (
          <CallStatusBlock call={call} />
        ) : countdown ? (
          <div className="text-center py-3">
            <p className="text-xs text-muted">חיוג אוטומטי בעוד</p>
            <p className="text-4xl font-semibold tabular text-warn">{countdown.secondsLeft}</p>
          </div>
        ) : (
          <div className="text-center py-3 text-muted text-xs">אין שיחה פעילה</div>
        )}

        {inboundRinging && (
          <div className="mt-3 rounded-lg border border-info/40 bg-info/10 p-3 text-center">
            <p className="text-sm font-semibold text-info">📞 שיחה נכנסת</p>
            <p className="text-xs text-muted mt-0.5">{call?.routingNote === "routed_to_owner" ? "הלקוח משויך אליך" : "נותבה אליך כנציג זמין"}</p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Button variant="good" onClick={acceptInbound} loading={busy === "accept"}>קבל</Button>
              <Button variant="danger" onClick={rejectInbound} loading={busy === "reject"}>דחה</Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 mt-3">
          {inboundRinging ? null : inProgress ? (
            <>
              <Button variant="danger" size="lg" className="col-span-2" onClick={hangup} loading={busy === "hangup"}>
                נתק <Kbd>H</Kbd>
              </Button>
              <Button variant={phone.muted ? "warn" : "secondary"} onClick={phone.toggleMute} disabled={!answered || phone.status === "simulation"}>
                {phone.muted ? "בטל השתקה" : "השתק"} <Kbd>M</Kbd>
              </Button>
              <Button variant="secondary" onClick={() => setKeypad((k) => !k)} disabled={!answered}>
                לוח מקשים
              </Button>
            </>
          ) : (
            <>
              <Button variant="good" size="lg" className="col-span-2" onClick={onDialLead} disabled={!canDialLead || !connOk || busy === "dial"} loading={busy === "dial"}>
                חייג לליד <Kbd>D</Kbd>
              </Button>
              {onSkip && (
                <Button variant="secondary" className="col-span-2" onClick={onSkip} disabled={!canDialLead}>
                  דלג עם סיבה <Kbd>S</Kbd>
                </Button>
              )}
            </>
          )}
        </div>

        {keypad && answered && (
          <div className="grid grid-cols-3 gap-1.5 mt-3" dir="ltr">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
              <button key={d} onClick={() => sendDtmf(d)} className="h-11 rounded-lg bg-white/6 hover:bg-white/12 text-lg font-medium tabular">
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Manual dial */}
      <div className="p-3 border-b border-line">
        <p className="text-xs text-muted mb-2">חיוג ידני</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) onDialManual(manual.trim());
          }}
          className="flex gap-2"
        >
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="050-1234567" inputMode="tel" ltr className="h-9" onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t) { e.preventDefault(); setManual(t.replace(/[^\d+]/g, "")); } }} />
          <Button type="submit" size="sm" className="h-9" disabled={inProgress || !connOk || !manual.trim()}>
            חייג
          </Button>
        </form>
        {!inProgress && (
          <div className="grid grid-cols-3 gap-1 mt-2" dir="ltr">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"].map((d) => (
              <button key={d} type="button" onClick={() => setManual((m) => (d === "⌫" ? m.slice(0, -1) : m + d))} className="h-9 rounded-md bg-white/5 hover:bg-white/10 text-sm tabular">
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recent */}
      <div className="p-3">
        <p className="text-xs text-muted mb-2">שיחות אחרונות</p>
        {recent.length === 0 ? (
          <p className="text-xs text-muted">—</p>
        ) : (
          <ul className="space-y-1">
            {recent.slice(0, 8).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate">{r.contact?.fullName ?? "לא מזוהה"}</p>
                  <p className="text-muted"><Phone value={formatPhone(r.toE164)} /> · {relativeTime(r.createdAt)} · {r.telephonyResult ? TELEPHONY_RESULT_LABEL[r.telephonyResult] : ""}</p>
                </div>
                <button onClick={() => onDialManual(r.toE164)} disabled={inProgress || !connOk} className="text-[#aab3ff] hover:underline disabled:opacity-40 shrink-0">חייג שוב</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CallStatusBlock({ call }: { call: CallDto }) {
  const answered = call.status === "answered";
  const ended = Boolean(call.endedAt);
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-2">
        <span className={cx("w-2.5 h-2.5 rounded-full", answered ? "bg-good pulse-good" : ended ? "bg-muted" : "bg-warn animate-pulse")} />
        <span className="text-sm font-medium">{ended ? (call.telephonyResult ? TELEPHONY_RESULT_LABEL[call.telephonyResult] : "הסתיימה") : CALL_STATUS_LABEL[call.status]}</span>
        {call.provider === "mock" && <Badge tone="warn">הדמיה</Badge>}
      </div>
      <p className="text-lg font-semibold mt-1 truncate">{call.contact?.fullName ?? "—"}</p>
      <Phone value={formatPhone(call.toE164)} className="text-muted" />
      <p className={cx("text-3xl font-semibold tabular mt-1", answered ? "text-good" : "text-text/70")}>{answered || ended ? formatDuration(ended ? call.talkSeconds : callElapsed(call)) : "--:--"}</p>
      {call.dialPendingSince && !ended && <p className="text-[11px] text-warn mt-1">ממתין לאישור מהספק…</p>}
      {call.direction === "inbound" && <Badge tone="info" className="mt-1">שיחה נכנסת</Badge>}
      {call.amdResult === "machine" && <p className="text-[11px] text-warn mt-1">זוהה תא קולי (ייתכן זיהוי שגוי) – החלט בעצמך</p>}
      {call.failureReason && ended && <p className="text-[11px] text-bad mt-1">{call.failureReason}</p>}
    </div>
  );
}
