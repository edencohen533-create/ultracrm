"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button } from "@/components/ui";

const fmt = (iso: string) => new Date(iso).toLocaleString("he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The dialer stopped because nothing is dialable for this agent in this campaign right now. Distinguishes:
 *  exhausted – no more work here · waiting – future follow-ups / retries (next time shown) · blocked – a reason that is
 *  NOT "no leads" (paused, permission, connection). Offers other campaigns the agent may work (available first);
 *  choosing one only loads it – dialing starts with an explicit "הפעל חייגן".
 */
export function NoLeadsPanel() {
  const { emptyState, refreshEmptyState, switchCampaign, nextLead, busy, state } = useDialer();
  // Re-check every minute while waiting (read-only: never dials by itself).
  useEffect(() => { const t = setInterval(() => { void refreshEmptyState(); }, 60_000); return () => clearInterval(t); }, [refreshEmptyState]);
  if (!emptyState) return null;
  const a = emptyState.availability;
  const blocked = a.state === "blocked";
  const others = emptyState.campaigns;
  return (
    <div className="p-5 space-y-4" data-testid="no-leads-panel" data-state={a.state}>
      {blocked ? (
        <div className="rounded-xl border border-bad/40 bg-bad/10 p-4" data-testid="no-leads-blocked">
          <p className="font-semibold">לא ניתן לחייג כרגע בקמפיין {a.listName}</p>
          <p className="text-sm mt-1">{a.reason ?? "תקלה או חסימה"} – זו לא הודעה שנגמרו הלידים.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-panel-2 p-4 space-y-1">
          <p className="font-semibold" data-testid="no-leads-title">אין כרגע לידים זמינים בקמפיין הזה. אפשר לעבור לקמפיין אחר.</p>
          {a.state === "waiting" && a.nextAt && <p className="text-sm" data-testid="no-leads-next">החיוג הבא בקמפיין הזה צפוי ב־{fmt(a.nextAt)}.{a.reason ? ` (${a.reason})` : ""}</p>}
          {a.state === "exhausted" && <p className="text-sm text-muted" data-testid="no-leads-exhausted">אין פולואפים או ניסיונות חוזרים עתידיים בקמפיין {a.listName}.</p>}
          {a.exhaustedCount > 0 && <p className="text-xs text-muted">לידים שמוצו ניסיונות החיוג שלהם בקמפיין: {a.exhaustedCount}</p>}
          <div className="pt-2"><Button size="sm" variant="secondary" loading={busy === "next"} disabled={!state?.session || state.session.status !== "active"} onClick={() => void nextLead()} data-testid="no-leads-recheck">בדוק שוב בקמפיין הזה</Button></div>
        </div>
      )}
      {emptyState.dueElsewhere.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="due-elsewhere">
          {emptyState.dueElsewhere.map((d) => <p key={d.listId}>⏰ הגיע מועד {d.n === 1 ? "פולואפ" : `${d.n} פולואפים`} בקמפיין <b>{d.listName}</b> · <button className="underline" onClick={() => void switchCampaign(d.listId)} disabled={busy === "switch"}>חזרה לקמפיין</button></p>)}
        </div>
      )}
      <div>
        <p className="text-sm font-semibold mb-2">קמפיינים אחרים שפתוחים עבורך</p>
        {!others.length ? <p className="text-sm text-muted" data-testid="no-other-campaigns">אין כרגע קמפיינים נוספים פתוחים עבורך. פנה למנהל.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="other-campaigns">
            {others.map((c) => (
              <li key={c.id} className="flex items-center gap-3 p-3" data-testid="other-campaign">
                <span className="flex-1 font-medium">{c.name}</span>
                <Badge tone={c.availableNow ? "good" : "neutral"}>{c.availableNow} זמינים עכשיו</Badge>
                {!c.availableNow && c.nextAt && <span className="text-xs text-muted">הבא: {fmt(c.nextAt)}</span>}
                <Button size="sm" variant={c.availableNow ? "primary" : "secondary"} loading={busy === "switch"} onClick={() => void switchCampaign(c.id)} data-testid={`switch-campaign-${c.id}`}>עבור לקמפיין</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted mt-2">המעבר רק טוען את הקמפיין – החיוג יתחיל רק בלחיצה על ״הפעל חייגן״. פולואפים שנקבעו לא משתנים. <Link href="/lists" className="underline">כל הקמפיינים</Link></p>
      </div>
    </div>
  );
}
