"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { cx } from "@/components/ui";
import { HelpTip } from "@/components/ai/HelpTip";
import { useT } from "@/components/i18n/LangProvider";

type T = ReturnType<typeof useT>;

/**
 * Explanations for dial-list settings and counters. Each text describes what the code actually does
 * (queue.ts / exhaustion.ts / numbers/selection.ts / api/lists) – change them together.
 */
export function listHelp(t: T) {
  return {
    priority: t(
      "1–10, כש-10 היא הגבוהה ביותר. העדיפות לא משנה את סדר הלידים בתוך הרשימה (אותו קובעים תעדוף הלידים בהגדרות והאסטרטגיה האישית של הנציג). היא קובעת את סדר הרשימות: במסך רשימות החיוג, וכשהלידים של נציג ברשימה נגמרים – ברשימות החלופיות שמוצעות לו (קודם לפי מספר הלידים הזמינים עכשיו, ובמספר זהה – לפי עדיפות). בעדיפות זהה – הרשימה שנוצרה מאוחר יותר מופיעה קודם.",
      "1–10, 10 is highest. Priority doesn't change the order of leads inside the list (lead prioritization in settings and the agent's personal strategy decide that). It orders lists: on the dial-lists screen, and when an agent runs out of leads in a list – among the alternative lists offered (first by leads available now, on a tie by priority). On equal priority the newer list comes first.",
    ),
    audience: t(
      "גיוס – לקוחות קיימים (שקנו) לא יחויגו מהרשימה. חידושים / מכירה נוספת – רק לקוחות קיימים, אצל הנציג המטפל שלהם. כולם – לידים ולקוחות.",
      "Acquisition – existing customers (who bought) are never dialed from this list. Renewals / upsell – existing customers only, by their handling agent. Everyone – leads and customers.",
    ),
    script: t("התסריט שמוצג לנציג בזמן שיחה מהרשימה. ברירת מחדל – התסריט של העסק.", "The script shown to the agent during calls from this list. Default – the business script."),
    number: t(
      "המספר שיוצג ללקוח בשיחות מהרשימה. ״ברירת מחדל של העסק״ – מספר ברירת המחדל של העסק, או רוטציית המספרים האישית של הנציג אם הוגדרה לו.",
      "The number the customer sees on calls from this list. \"Business default\" – the business's default number, or the agent's personal number rotation if one is set.",
    ),
    maxAttempts: t(
      "כמה פעמים לכל היותר לחייג לכל ליד. אחרי הניסיון האחרון שלא הצליח הליד מסומן ״מוצה״ ויוצא מהתור. ריק – לפי הגדרת העסק. הגדרה אישית של נציג יכולה רק להקטין את המספר.",
      "The maximum number of dial attempts per lead. After the last unsuccessful attempt the lead is marked \"Exhausted\" and leaves the queue. Empty – business setting. An agent's personal setting can only lower it.",
    ),
    unanswered: t(
      "אחרי כמה ניסיונות חיוג שלא נענו הליד מסומן ״לא רלוונטי״ ב-CRM. ״כבוי״ – לא מסמנים. ״לפי הגדרת העסק״ – ההגדרה הכללית. הגדרה אישית של נציג גוברת על הרשימה.",
      "After how many unanswered dial attempts the lead is marked \"Not relevant\" in the CRM. \"Off\" – never. \"Per business setting\" – the general setting. An agent's personal setting overrides the list.",
    ),
    retry: t(
      "כמה דקות לחכות אחרי שיחה שלא נענתה עד שהליד חוזר לתור. ריק – לפי הגדרת העסק. קו תפוס חוזר לפי הגדרת ״תפוס״ של העסק.",
      "How many minutes to wait after an unanswered call before the lead returns to the queue. Empty – business setting. A busy line follows the business's \"busy\" setting.",
    ),
    access: t(
      "כל הנציגים – כל נציג עם הרשאת חייגן בעסק יכול לעבוד על הרשימה. נציגים מסוימים – רק הנציגים שנבחרו. מנהלים רואים את כל הרשימות. נאכף בשרת.",
      "All agents – any agent with dialer permission can work the list. Specific agents – only the selected ones. Managers see all lists. Enforced on the server.",
    ),
    fill: t(
      "מוסיף לרשימה כבר עכשיו אנשי קשר מה-CRM שמתאימים לסינון. ״רק שטרם חויגו״ – רק אנשי קשר שאין להם אף שיחה.",
      "Adds matching CRM contacts to the list right away. \"Only never dialed\" – only contacts with no call at all.",
    ),
    dynamic: t(
      "דינמית – במסך הרשימה יופיע ״רענן מהסינון״, שמוסיף אנשי קשר חדשים שעונים לסינון. מוקפאת – הרשימה נשארת כפי שנוצרה. דינמית דורשת סינון.",
      "Dynamic – the list screen shows \"Refresh from filter\", which adds new contacts matching the filter. Frozen – the list stays as created. Dynamic requires a filter.",
    ),
    active: t(
      "פעילה – נציגים יכולים לשלוף ממנה לידים. השבתה עוצרת שליפת לידים חדשים ומשחררת לידים ששמורים לנציגים; שיחה פעילה ממשיכה עד סופה. הפעלה לא מתחילה שיחות – נציג מתחיל לחייג רק כשהוא מפעיל חייגן.",
      "Active – agents can take leads from it. Deactivating stops new leads and releases leads reserved for agents; a live call continues to its end. Activating starts no calls – an agent dials only after starting the dialer.",
    ),
    queue: t(
      "לידים שאפשר לחייג אליהם עכשיו: בסטטוס ״ממתין״ או ״חזרה״ שהזמן שלהם הגיע. לא נספרים: לידים שממתינים לניסיון חוזר או לחזרה מאוחרת יותר, לידים בשיחה או שמורים לנציג, שהושלמו, מוצו, חסומים או הוסרו. כשהרשימה מושבתת או מושהית, החיוג בעסק מושהה או מחוץ לשעות החיוג של העסק – 0. הספירה לא מפעילה כללים לפי נציג (מטרת הרשימה, בעלות על ליד, מכסות יומיות), ולכן נציג מסוים עשוי לקבל פחות.",
      "Leads that can be dialed now: \"Pending\" or \"Callback\" whose time has come. Not counted: leads waiting for a later retry or callback, in a call or reserved for an agent, completed, exhausted, blocked or removed. 0 when the list is inactive or paused, dialing is paused for the business, or outside the business's dialing hours. Per-agent rules (list purpose, lead ownership, daily caps) aren't applied, so a given agent may get fewer.",
    ),
    pending: t(
      "כל הלידים בסטטוס ״ממתין״ – שעוד לא חויגו או שממתינים לניסיון חוזר – גם אם הזמן שלהם עוד לא הגיע. לא נספרים: חזרות מתוזמנות, לידים בשיחה או שמורים לנציג, שהושלמו, מוצו, חסומים או הוסרו. ההבדל מ״בתור״: ״ממתינים״ כולל גם לידים שהזמן שלהם עוד לא הגיע ולא כולל חזרות; ״בתור״ סופר רק מי שאפשר לחייג עכשיו, כולל חזרות שהגיע זמנן. ליד ממתין שהגיע זמנו נספר בשניהם.",
      "All leads in \"Pending\" – not dialed yet or waiting for a retry – even if their time hasn't come. Not counted: scheduled callbacks, leads in a call or reserved, completed, exhausted, blocked or removed. The difference from \"In queue\": \"Pending\" also counts leads whose time hasn't come and excludes callbacks; \"In queue\" counts only who can be dialed now, including due callbacks. A due pending lead is counted in both.",
    ),
  };
}

/** A field label with its "?" explanation (hover / keyboard focus on desktop, tap on phones). */
export function HelpLabel({ text, help, testId }: { text: string; help: string; testId?: string }) {
  return <span className="mb-1 flex items-center text-xs text-muted">{text}<HelpTip label={text} hover testId={testId}>{help}</HelpTip></span>;
}

const DAY_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const DAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function formatHours(h: { start: string; end: string; days: number[] }, t: T) {
  const names = t.lang === "en" ? DAY_EN : DAY_HE;
  const days = [...h.days].sort((a, b) => a - b);
  const consecutive = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? t("כל הימים", "every day") : consecutive ? `${names[days[0]]}–${names[days[days.length - 1]]}` : days.map((d) => names[d]).join(", ");
  return `${h.start}–${h.end}, ${dayText}`;
}

export interface BusinessDialState { businessHours: { start: string; end: string; days: number[]; nextOpening: string | null } | null; unavailable: { outsideDialWindow: boolean; businessPaused?: boolean } }

/** Business-wide rules that stop dialing right now (they are not list settings) – said once, with where to change them. */
export function BusinessDialingNote({ stats, isManager }: { stats: BusinessDialState | undefined; isManager: boolean }) {
  const t = useT();
  if (!stats?.businessHours) return null;
  const { businessPaused, outsideDialWindow } = stats.unavailable;
  if (!businessPaused && !outsideDialWindow) return null;
  const hours = formatHours(stats.businessHours, t);
  const next = stats.businessHours.nextOpening ? new Date(stats.businessHours.nextOpening).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" role="status" data-testid="business-dialing-note">
      {businessPaused
        ? <p>{t("החיוג בעסק מושהה כרגע על ידי מנהל – לא ניתן לחייג מאף רשימה עד שהחיוג יחודש.", "Dialing is paused for the whole business by a manager – no list can be dialed until it's resumed.")}</p>
        : <p>{t(`עכשיו מחוץ לשעות החיוג של העסק (${hours}) – רשימות פעילות לא מספקות לידים עד ${next ?? "הפתיחה הבאה"}.`, `It's outside the business's dialing hours (${hours}) – active lists supply no leads until ${next ?? "the next opening"}.`)}</p>}
      <p className="mt-1 text-xs text-muted">{t("זו הגדרה כללית של העסק, לא של הרשימה.", "This is a business-wide setting, not a list setting.")}{isManager && <> <Link href="/settings?tab=general" className="underline">{t("שינוי בהגדרות ← חייגן", "Change in settings → Dialer")}</Link></>}</p>
    </div>
  );
}

/**
 * Active / inactive as one clear switch: one click changes and saves. While saving it can't be clicked again; on
 * failure it returns to the real (server) state and shows the error. Enforced on the server (manager + permission).
 */
export function ListActiveSwitch({ list, onChanged, compact = false }: { list: { id: string; isActive: boolean }; onChanged: () => void; compact?: boolean }) {
  const t = useT();
  const [active, setActive] = useState(list.isActive);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  useEffect(() => { if (!inflight.current) setActive(list.isActive); }, [list.isActive]);
  async function toggle() {
    if (inflight.current) return; // a second click while saving does nothing
    inflight.current = true; setBusy(true);
    const next = !active; setActive(next);
    try {
      const r = await api.patch<{ isActive: boolean }>(`/api/lists/${list.id}`, { isActive: next });
      setActive(r.isActive);
      toast.success(next ? t("הרשימה הופעלה – נציגים יכולים לשלוף ממנה לידים כשהם מפעילים חייגן", "List activated – agents can take leads from it when they start the dialer") : t("הרשימה הושבתה – לא יסופקו ממנה לידים חדשים. שיחה פעילה ממשיכה עד סופה", "List deactivated – no new leads will be supplied. A live call continues to its end"));
      onChanged();
    } catch (e) {
      // Back to what the server really has (the save may have failed before or after the change).
      try { const fresh = await api.get<{ isActive: boolean }>(`/api/lists/${list.id}`); setActive(fresh.isActive); } catch { setActive(!next); }
      toast.error((e as Error).message);
    } finally { inflight.current = false; setBusy(false); }
  }
  const label = active ? t("פעילה", "Active") : t("לא פעילה", "Inactive");
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" role="switch" aria-checked={active} aria-busy={busy} aria-label={t(`רשימה ${label} – לחיצה ${active ? "משביתה" : "מפעילה"}`, `List ${label} – click to ${active ? "deactivate" : "activate"}`)}
        // The second click of a double click is ignored (it would switch straight back); keyboard activation has detail 0.
        onClick={(e) => { if (e.detail > 1) return; void toggle(); }} disabled={busy} data-testid="list-active-toggle"
        className={cx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait", active ? "justify-end bg-good" : "justify-start bg-line", busy && "opacity-70")}>
        <span className="h-5 w-5 rounded-full bg-white shadow" aria-hidden="true" />
      </button>
      <span className={cx("text-xs font-medium", active ? "text-good" : "text-muted")} data-testid="list-active-label">{busy ? t("שומר…", "Saving…") : label}</span>
      {!compact && <HelpTip label={t("פעילה / לא פעילה", "Active / inactive")} hover testId="list-active-help">{listHelp(t).active}</HelpTip>}
    </span>
  );
}
