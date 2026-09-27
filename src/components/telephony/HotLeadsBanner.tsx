"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import type { HotSignal } from "@/lib/client/types";

const time = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });

/**
 * WhatsApp availability replies for the agent (from the dialer state poll – no refresh needed).
 * Active: the lead already leads the queue; a running power dialer dials it next by itself. Otherwise the agent gets
 * "חייג עכשיו" – the dialer is never started automatically. Review / expired / blocked items explain what to do.
 */
export function HotLeadsBanner() {
  const { state, dial, busy } = useDialer();
  const [confirm, setConfirm] = useState<HotSignal | null>(null); const [when, setWhen] = useState({ date: "", time: "" });
  const items = state?.hot ?? [];
  if (!items.length) return null;
  const session = state?.session;
  const autoDialing = Boolean(session && session.mode === "power" && session.status === "active" && session.ownedByThisTab !== false);
  const inCall = Boolean(state?.activeCall || state?.wrapUpCall);
  async function act(h: HotSignal, body: Record<string, unknown>, msg: string) {
    try { await api.post(`/api/dialer/hot/${h.id}`, body); toast.success(msg); setConfirm(null); } catch (e) { toast.error((e as Error).message); }
  }
  async function dialNow(h: HotSignal) {
    if (inCall) return toast.error("יש שיחה פעילה – הליד יחויג אחריה");
    await dial({ mode: "manual", contactId: h.contactId });
  }
  return (
    <div className="border-b border-line bg-good/10 px-4 py-2 space-y-1.5 text-sm" data-testid="hot-leads">
      {items.map((h) => (
        <div key={h.id} className="flex flex-wrap items-center gap-2" data-testid="hot-lead" data-status={h.status}>
          {h.status === "active" && <span className="rounded-md bg-good text-white px-2 py-0.5 text-xs font-semibold" data-testid="hot-tag">זמינה עכשיו — התקבלה תשובה בוואטסאפ</span>}
          {h.status === "needs_review" && <span className="rounded-md bg-warn/80 text-white px-2 py-0.5 text-xs font-semibold">לבדיקה</span>}
          {h.status === "expired" && <span className="rounded-md bg-bad/80 text-white px-2 py-0.5 text-xs font-semibold">לא טופל בזמן</span>}
          {h.status === "ineligible" && <span className="rounded-md bg-bad/80 text-white px-2 py-0.5 text-xs font-semibold">לא ניתן לחייג</span>}
          <b>{h.contact?.fullName ?? "לקוח"}</b>
          <span className="text-muted text-xs">{time(h.requestedAt)}</span>
          <span className="italic truncate max-w-[340px]" title={h.text}>״{h.text}״</span>
          {h.reason && <span className="text-xs text-muted">· {h.reason}</span>}
          {!h.mine && <span className="text-xs text-muted">(של נציג אחר)</span>}
          {h.analyzer === "basic" && <span className="text-[10px] text-muted">(זיהוי בסיסי)</span>}
          <span className="ms-auto flex gap-2">
            {h.status === "active" && h.mine && (autoDialing ? <span className="text-xs text-good font-medium">{inCall ? "הבאה בתור אחרי השיחה הנוכחית" : "החייגן מחייג אליה עכשיו"}</span>
              : <button className="rounded-md bg-good text-white px-2 py-0.5 text-xs font-semibold disabled:opacity-50" disabled={busy === "dial" || inCall} onClick={() => dialNow(h)} data-testid="hot-dial">חייג עכשיו</button>)}
            {h.status === "expired" && h.mine && <button className="rounded-md bg-accent text-white px-2 py-0.5 text-xs" disabled={inCall} onClick={() => dialNow(h)}>חייג עכשיו</button>}
            {h.status === "needs_review" && <button className="underline text-xs" onClick={() => setConfirm(h)} data-testid="hot-review">אישור</button>}
            {h.conversationId && <Link className="underline text-xs" href={`/inbox/${h.conversationId}`}>פתח שיחה</Link>}
            {(h.status === "active" || h.status === "needs_review") && <button className="underline text-xs" onClick={() => act(h, { action: "cancel" }, "העדיפות בוטלה")} data-testid="hot-cancel">בטל עדיפות</button>}
            {(h.status === "expired" || h.status === "ineligible") && <button className="underline text-xs" onClick={() => act(h, { action: "ack" }, "סומן כנקרא")}>הבנתי</button>}
          </span>
        </div>
      ))}
      {confirm && <div className="rounded-md border border-line bg-panel p-2 flex flex-wrap items-center gap-2 text-xs" data-testid="hot-confirm">
        <span>״{confirm.text}״ – מה לעשות?</span>
        <button className="rounded-md bg-good text-white px-2 py-0.5" onClick={() => act(confirm, { action: "confirm", now: true }, "הועברה לראש התור")}>זמינה עכשיו – לראש התור</button>
        <span>או פולואפ:</span><input type="date" className="h-7 px-1 rounded border border-line bg-bg ltr" value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} />
        <input type="time" className="h-7 px-1 rounded border border-line bg-bg ltr" value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} />
        <button className="rounded-md bg-accent text-white px-2 py-0.5 disabled:opacity-50" disabled={!when.date || !when.time} onClick={() => act(confirm, { action: "confirm", date: when.date, time: when.time }, "הפולואפ נקבע")}>קבע</button>
        <button className="underline" onClick={() => act(confirm, { action: "ack" }, "נסגר")}>אין צורך</button>
        <button className="underline" onClick={() => setConfirm(null)}>סגור</button>
      </div>}
    </div>
  );
}
