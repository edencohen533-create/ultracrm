"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";

/** A follow-up came due in another campaign: tell the agent, with a way back. Never interrupts a call or dials. */
export function DueElsewhereBanner() {
  const { state, switchCampaign, busy, emptyState } = useDialer();
  const [items, setItems] = useState<Array<{ listId: string; listName: string; n: number }>>([]);
  const active = Boolean(state?.session && state.session.status !== "ended" && state.session.listId);
  useEffect(() => {
    if (!active) return;
    const load = () => api.get<{ items: typeof items }>("/api/dialer/due-elsewhere").then((r) => setItems(r.items)).catch(() => undefined);
    void load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, [active, state?.session?.listId]);
  if (!active || !items.length || emptyState) return null; // the empty-queue panel already lists them
  const inCall = Boolean(state?.activeCall || state?.wrapUpCall);
  return (
    <div className="mx-3 mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs" role="status" data-testid="due-elsewhere-banner">
      {items.map((d) => <span key={d.listId} className="me-3">⏰ הגיע מועד {d.n === 1 ? "פולואפ" : `${d.n} פולואפים`} בקמפיין <b>{d.listName}</b>{" "}
        {inCall ? <span className="text-muted">(אפשר לחזור אחרי סיום השיחה ותיעודה)</span> : <button className="underline" disabled={busy === "switch"} onClick={() => void switchCampaign(d.listId)}>חזרה לקמפיין</button>}</span>)}
    </div>
  );
}
