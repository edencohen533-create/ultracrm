"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

const fmt = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The dialer stopped because nothing is dialable for this agent in this campaign right now. Distinguishes:
 *  exhausted – no more work here · waiting – future follow-ups / retries (next time shown) · blocked – a reason that is
 *  NOT "no leads" (paused, permission, connection). Offers other campaigns the agent may work (available first);
 *  choosing one only loads it – dialing starts with an explicit "הפעל חייגן".
 */
export function NoLeadsPanel() {
  const t = useT();
  const { emptyState, refreshEmptyState, switchCampaign, nextLead, busy, state } = useDialer();
  // Re-check every minute while waiting (read-only: never dials by itself).
  useEffect(() => { const iv = setInterval(() => { void refreshEmptyState(); }, 60_000); return () => clearInterval(iv); }, [refreshEmptyState]);
  if (!emptyState) return null;
  const a = emptyState.availability;
  const blocked = a.state === "blocked";
  const others = emptyState.campaigns;
  return (
    <div className="p-5 space-y-4" data-testid="no-leads-panel" data-state={a.state}>
      {blocked ? (
        <div className="rounded-xl border border-bad/40 bg-bad/10 p-4" data-testid="no-leads-blocked">
          <p className="font-semibold">{t("לא ניתן לחייג כרגע בקמפיין", "Can't dial right now in campaign")} {a.listName}</p>
          <p className="text-sm mt-1">{a.reason ?? t("תקלה או חסימה", "Error or block")} {t("– זו לא הודעה שנגמרו הלידים.", "– this does not mean the leads ran out.")}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-panel-2 p-4 space-y-1">
          <p className="font-semibold" data-testid="no-leads-title">{t("אין כרגע לידים זמינים בקמפיין הזה. אפשר לעבור לקמפיין אחר.", "No leads are available in this campaign right now. You can switch to another campaign.")}</p>
          {a.state === "waiting" && a.nextAt && <p className="text-sm" data-testid="no-leads-next">{t(`החיוג הבא בקמפיין הזה צפוי ב־${fmt(a.nextAt, t.lang)}.`, `The next dial in this campaign is expected ${fmt(a.nextAt, t.lang)}.`)}{a.reason ? ` (${a.reason})` : ""}</p>}
          {a.state === "exhausted" && <p className="text-sm text-muted" data-testid="no-leads-exhausted">{t(`אין פולואפים או ניסיונות חוזרים עתידיים בקמפיין ${a.listName}.`, `No upcoming follow-ups or retries in campaign ${a.listName}.`)}</p>}
          {a.exhaustedCount > 0 && <p className="text-xs text-muted">{t("לידים שמוצו ניסיונות החיוג שלהם בקמפיין:", "Leads with exhausted dial attempts in the campaign:")} {a.exhaustedCount}</p>}
          <div className="pt-2"><Button size="sm" variant="secondary" loading={busy === "next"} disabled={!state?.session || state.session.status !== "active"} onClick={() => void nextLead()} data-testid="no-leads-recheck">{t("בדוק שוב בקמפיין הזה", "Check this campaign again")}</Button></div>
        </div>
      )}
      {emptyState.dueElsewhere.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="due-elsewhere">
          {emptyState.dueElsewhere.map((d) => <p key={d.listId}>⏰ {d.n === 1 ? t("הגיע מועד פולואפ בקמפיין", "A follow-up is due in campaign") : t(`הגיע מועד ${d.n} פולואפים בקמפיין`, `${d.n} follow-ups are due in campaign`)} <b>{d.listName}</b> · <button className="underline" onClick={() => void switchCampaign(d.listId)} disabled={busy === "switch"}>{t("חזרה לקמפיין", "Back to campaign")}</button></p>)}
        </div>
      )}
      <div>
        <p className="text-sm font-semibold mb-2">{t("קמפיינים אחרים שפתוחים עבורך", "Other campaigns open to you")}</p>
        {!others.length ? <p className="text-sm text-muted" data-testid="no-other-campaigns">{t("אין כרגע קמפיינים נוספים פתוחים עבורך. פנה למנהל.", "No other campaigns are open to you right now. Contact your manager.")}</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="other-campaigns">
            {others.map((c) => (
              <li key={c.id} className="flex items-center gap-3 p-3" data-testid="other-campaign">
                <span className="flex-1 font-medium">{c.name}</span>
                <Badge tone={c.availableNow ? "good" : "neutral"}>{t(`${c.availableNow} זמינים עכשיו`, `${c.availableNow} available now`)}</Badge>
                {!c.availableNow && c.nextAt && <span className="text-xs text-muted">{t("הבא:", "Next:")} {fmt(c.nextAt, t.lang)}</span>}
                <Button size="sm" variant={c.availableNow ? "primary" : "secondary"} loading={busy === "switch"} onClick={() => void switchCampaign(c.id)} data-testid={`switch-campaign-${c.id}`}>{t("עבור לקמפיין", "Switch to campaign")}</Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted mt-2">{t("המעבר רק טוען את הקמפיין – החיוג יתחיל רק בלחיצה על ״הפעל חייגן״. פולואפים שנקבעו לא משתנים.", "Switching only loads the campaign – dialing starts only when you click \"Start dialer\". Scheduled follow-ups are unchanged.")} <Link href="/lists" className="underline">{t("כל הקמפיינים", "All campaigns")}</Link></p>
      </div>
    </div>
  );
}
