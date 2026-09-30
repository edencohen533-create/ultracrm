"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { zoned } from "@/components/leads/LeadActions";
import { useT } from "@/components/i18n/LangProvider";
import type { OutcomeKey } from "@/lib/client/types";

/** What the agent chose at wrap-up: a CRM status (business handling) or a technical telephony result. */
export interface WrapUpPick { statusId?: string; kind?: string; outcome?: OutcomeKey; followUp?: { date: string; time: string }; callbackUserId?: string }

/**
 * The CRM's active statuses offered at wrap-up (all but "new" – after a call the lead is no longer new). Re-read at
 * every wrap-up, so a status the owner added / renamed / deleted meanwhile (another screen or user) shows right away.
 */
export function useWrapUpStatuses(callId?: string) {
  const statuses = useLeadStatuses();
  const { refresh } = statuses;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (callId) refresh(); }, [callId]);
  return { ...statuses, wrapUp: statuses.active.filter((s) => s.kind !== "new") };
}

/** A pick is complete when a follow-up status has its date + time. */
export const pickReady = (p: WrapUpPick | null) => Boolean(p && (p.outcome || (p.statusId && (p.kind !== "follow_up" || (p.followUp?.date && p.followUp.time)))));

/**
 * Follow-up time for a follow-up status: date + time in the BUSINESS time zone (shown), quick picks, and – when the
 * agent may assign follow-ups – the agent who will call. The server checks it is in the future and inside the
 * business's dialing hours (and suggests the next allowed time otherwise).
 */
export function FollowUpFields({ value, onChange, callId }: { value: WrapUpPick; onChange: (p: WrapUpPick) => void; callId: string }) {
  const t = useT();
  const { timezone } = useLeadStatuses();
  const [peers, setPeers] = useState<Array<{ id: string; fullName: string }>>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ peers: Array<{ id: string; fullName: string }>; allowed: boolean }>("/api/crm-settings/follow-ups?peers=1").then((r) => { if (alive) setPeers(r.allowed ? r.peers : []); }).catch(() => undefined);
    return () => { alive = false; };
  }, [callId]);
  const today = zoned(timezone, new Date()).date;
  const setAt = (at: Date) => onChange({ ...value, followUp: zoned(timezone, at) });
  const tomorrowAt10 = () => { const d = new Date(Date.now() + 24 * 3600_000); const z = zoned(timezone, d); onChange({ ...value, followUp: { date: z.date, time: "10:00" } }); };
  return (
    <div className="mt-2 rounded-lg border border-accent/40 bg-accent/5 p-2 text-sm" data-testid="wrapup-followup">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs">{t("תאריך", "Date")}<input type="date" className="h-9 rounded-md border border-line bg-bg px-2" min={today} value={value.followUp?.date ?? ""} onChange={(e) => onChange({ ...value, followUp: { date: e.target.value, time: value.followUp?.time ?? "" } })} data-testid="wrapup-followup-date" /></label>
        <label className="flex flex-col text-xs">{t("שעה", "Time")}<input type="time" className="h-9 rounded-md border border-line bg-bg px-2" value={value.followUp?.time ?? ""} onChange={(e) => onChange({ ...value, followUp: { date: value.followUp?.date ?? today, time: e.target.value } })} data-testid="wrapup-followup-time" /></label>
        {[1, 3].map((h) => <button key={h} type="button" className="h-9 rounded-md border border-line px-2 text-xs" onClick={() => setAt(new Date(Date.now() + h * 3600_000))}>{t(`בעוד ${h} שע׳`, `In ${h}h`)}</button>)}
        <button type="button" className="h-9 rounded-md border border-line px-2 text-xs" onClick={tomorrowAt10}>{t("מחר 10:00", "Tomorrow 10:00")}</button>
        {peers.length > 0 && <label className="flex flex-col text-xs">{t("מי יחזור", "Who calls back")}<select className="h-9 rounded-md border border-line bg-bg px-2" value={value.callbackUserId ?? ""} onChange={(e) => onChange({ ...value, callbackUserId: e.target.value || undefined })}><option value="">{t("אני", "Me")}</option>{peers.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>}
      </div>
      <p className="mt-1 text-[11px] text-muted" data-testid="wrapup-followup-tz">{t(`לפי שעון העסק (${timezone}). הפולואפ נכנס לחייגן של הנציג כשהזמן מגיע – לא לפני, ורק בשעות החיוג.`, `In the business's time (${timezone}). The follow-up enters the agent's dialer when it's due – not before, and only within dialing hours.`)}</p>
    </div>
  );
}
