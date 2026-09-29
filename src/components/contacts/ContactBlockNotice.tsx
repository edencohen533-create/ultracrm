"use client";

import { useT } from "@/components/i18n/LangProvider";

export interface BlockSummary {
  doNotContact?: boolean;
  fullyBlocked?: boolean;
  pendingReview?: boolean;
  marketingBlocked?: boolean;
  active: Array<{ kind?: string | null; source: string; reason: string | null; createdAt: string | Date; pendingReview?: boolean; scope: string }>;
}

const KIND: Record<string, [string, string]> = {
  unsubscribe: ["ביקש/ה הסרה", "Asked to unsubscribe"], do_not_call: ["ביקש/ה שלא להתקשר", "Asked not to be called"],
  wrong_person: ["מספר שגוי / לא האדם הנכון", "Wrong number / not the right person"], unclear: ["בקשה לא ברורה", "Unclear request"],
  complaint: ["תלונת ספאם", "Spam complaint"], unsubscribe_link: ["הסרה בקישור", "Unsubscribe link"], manual: ["נחסם ידנית", "Blocked manually"], import: ["סומן בייבוא", "Flagged in import"],
};
const SOURCE: Record<string, [string, string]> = { whatsapp: ["וואטסאפ", "WhatsApp"], sms: ["SMS", "SMS"], email: ["אימייל", "Email"], phone: ["טלפון", "Phone"], manual: ["נציג", "Agent"], import: ["ייבוא", "Import"], api: ["API", "API"] };

/**
 * Why this person may not be contacted – shown on the contact card, in the conversation and in the dialer.
 * Nothing is shown when there is no active request.
 */
export function ContactBlockNotice({ summary, isDnc, compact = false }: { summary: BlockSummary | null | undefined; isDnc?: boolean; compact?: boolean }) {
  const t = useT();
  if (!summary) return null;
  const confirmed = summary.active.filter((s) => !s.pendingReview);
  const blocked = summary.doNotContact || summary.fullyBlocked || isDnc || confirmed.length > 0;
  if (!blocked && !summary.pendingReview) return null;
  const latest = [...(blocked ? confirmed : summary.active)].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  const what = latest?.kind ? t(...(KIND[latest.kind] ?? [latest.kind, latest.kind])) : latest?.reason ?? (isDnc ? t("ברשימת לא ליצור קשר", "On the do-not-contact list") : "");
  const when = latest ? new Date(latest.createdAt).toLocaleDateString() : "";
  const via = latest ? t(...(SOURCE[latest.source] ?? [latest.source, latest.source])) : "";
  const title = !blocked ? t("ממתין לבירור – פנייה אוטומטית מושהית", "Under review – automatic outreach paused")
    : summary.fullyBlocked ? t("חסום לכל פנייה", "Blocked from all contact") : t("לא ליצור קשר", "Do not contact");
  const explain = !blocked
    ? t("הלקוח/ה כתב/ה משהו שנשמע כמו בקשת הסרה. קמפיינים, אוטומציות וחיוג אוטומטי נעצרו עד שמנהל יכריע. חיוג ידני עדיין אפשרי.", "The customer wrote something that may be a removal request. Campaigns, automations and auto-dialing are stopped until a manager decides. Manual dialing is still possible.")
    : summary.fullyBlocked
      ? t("לא מתקשרים ולא שולחים שום הודעה – גם לא הודעות שירות.", "No calls and no messages at all – not even service messages.")
      : t("לא מתקשרים, לא שולחים דיוור ואין פנייה אוטומטית בשום ערוץ. מענה ידני להודעה שהלקוח/ה שלח/ה אפשרי.", "No calls, no marketing and no automatic outreach on any channel. A manual reply to a message the customer sent is allowed.");
  return (
    <div role="status" data-testid="contact-block-notice" className={`rounded-md border ${blocked ? "border-bad/40 bg-bad/10" : "border-warn/40 bg-warn/10"} ${compact ? "px-2 py-1 text-xs" : "p-3 text-sm"}`}>
      <b>{title}</b>{what && <span> · {what}{via ? ` · ${via}` : ""}{when ? ` · ${when}` : ""}</span>}
      {!compact && <p className="mt-1 text-xs">{explain} {blocked && t("ביטול רק על ידי מנהל, עם תיעוד הסכמה מחודשת.", "Only a manager can lift it, with documented renewed consent.")}</p>}
    </div>
  );
}
