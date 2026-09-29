"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useT } from "@/components/i18n/LangProvider";

/** A follow-up came due in another campaign: tell the agent, with a way back. Never interrupts a call or dials. */
export function DueElsewhereBanner() {
  const t = useT();
  const { state, switchCampaign, busy, emptyState } = useDialer();
  const [items, setItems] = useState<Array<{ listId: string; listName: string; n: number }>>([]);
  const active = Boolean(state?.session && state.session.status !== "ended" && state.session.listId);
  useEffect(() => {
    if (!active) return;
    const load = () => api.get<{ items: typeof items }>("/api/dialer/due-elsewhere").then((r) => setItems(r.items)).catch(() => undefined);
    void load(); const iv = setInterval(load, 60_000); return () => clearInterval(iv);
  }, [active, state?.session?.listId]);
  if (!active || !items.length || emptyState) return null; // the empty-queue panel already lists them
  const inCall = Boolean(state?.activeCall);
  return (
    <div className="mx-3 mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs" role="status" data-testid="due-elsewhere-banner">
      {items.map((d) => <span key={d.listId} className="me-3">⏰ {d.n === 1 ? t("הגיע מועד פולואפ בקמפיין", "A follow-up is due in campaign") : t(`הגיע מועד ${d.n} פולואפים בקמפיין`, `${d.n} follow-ups are due in campaign`)} <b>{d.listName}</b>{" "}
        {inCall ? <span className="text-muted">{t("(אפשר לחזור אחרי סיום השיחה ותיעודה)", "(you can go back after the call is ended and logged)")}</span> : <button className="underline" disabled={busy === "switch"} onClick={() => void switchCampaign(d.listId)}>{t("חזרה לקמפיין", "Back to campaign")}</button>}</span>)}
    </div>
  );
}
