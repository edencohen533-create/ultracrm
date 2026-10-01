"use client";

import { useEffect, useState } from "react";
import { api, qs } from "@/lib/client/api";
import { Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { HelpTip } from "@/components/ai/HelpTip";

type Channel = "whatsapp" | "sms" | "email";
interface Row { id: string; label: string; channel: Channel; isActive: boolean; sent: number; delivered: number | null; read: number | null; failed: number; unknown: number; pending: number }
interface Data { from: string; to: string; timezone: string; partial: boolean; channels: Channel[]; rows: Row[]; totals: Row[] }
const CH: Record<Channel, [string, string]> = { whatsapp: ["וואטסאפ", "WhatsApp"], sms: ["SMS", "SMS"], email: ["אימייל", "Email"] };

/** שיווק ומכירות ← ביצועי דיוור: delivery statuses per sender and channel for the report's period. */
export function MessagingPerformance({ from, to }: { from: string; to: string }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to) return;
    let live = true; setError("");
    api.get<Data>(`/api/reports/messaging${qs({ from, to })}`).then((d) => live && setData(d)).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [from, to]);
  const na = <span className="text-muted" title={t("הערוץ לא מדווח על סטטוס זה", "The channel doesn't report this status")}>{t("לא זמין", "N/A")}</span>;
  const n = (v: number | null, of?: number) => v === null ? na : <span dir="ltr">{v.toLocaleString(loc)}{of ? <span className="text-muted text-xs"> ({Math.round((v / of) * 100)}%)</span> : null}</span>;
  const line = (r: Row, total = false) => (
    <tr key={r.id} className={total ? "font-semibold bg-panel-2" : ""} data-testid={`msgperf-row-${r.id}`}>
      <td className="px-3 h-10">{total ? t(`סה״כ ${CH[r.channel][0]}`, `Total ${CH[r.channel][1]}`) : <><span>{r.label}</span>{!r.isActive && <span className="ms-1 text-xs text-muted">({t("לא פעיל", "inactive")})</span>}</>}</td>
      <td className="px-2">{t(...CH[r.channel])}</td>
      <td className="px-2 tabular-nums">{n(r.sent)}</td>
      <td className="px-2 tabular-nums">{n(r.delivered, r.sent)}</td>
      <td className="px-2 tabular-nums">{n(r.read, r.sent)}</td>
      <td className="px-2 tabular-nums">{n(r.failed)}</td>
      <td className="px-2 tabular-nums">{n(r.unknown)}</td>
    </tr>
  );
  return (
    <section className="rounded-xl border border-line bg-panel" aria-label={t("ביצועי דיוור", "Messaging performance")} data-testid="msgperf">
      <h2 className="flex items-center gap-1 border-b border-line px-3 py-2 text-sm font-semibold">{t("ביצועי דיוור", "Messaging performance")}
        <HelpTip label={t("ביצועי דיוור", "Messaging performance")} hover>{t("הודעות יוצאות בתקופה לפי מספר / שולח וערוץ, כולל דיוורים, אוטומציות והודעות נציגים. נשלחו = התקבלו אצל הספק. נמסרו ונקראו לפי אישורי הספק. ‏SMS ואימייל לא מדווחים קריאה – מוצג ״לא זמין״ ולא 0.", "Outbound messages in the period per number / sender and channel – campaigns, automations and agents. Sent = accepted by the provider. Delivered / read per provider receipts. SMS and email don't report reads – shown as N/A, not 0.")}</HelpTip>
        {data && <span className="ms-auto text-xs font-normal text-muted" dir="ltr">{data.from} – {data.to}</span>}
      </h2>
      {error ? <p role="alert" className="p-3 text-sm text-bad">{t("טעינת ביצועי הדיוור נכשלה: ", "Failed to load: ")}{error}</p>
        : !data ? <div className="flex justify-center p-6"><Spinner /></div>
        : !data.channels.length ? <p className="p-4 text-sm text-muted" data-testid="msgperf-none">{t("אין ערוצי הודעות זמינים לך בעסק זה.", "No messaging channels available to you in this business.")}</p>
        : !data.rows.length ? <p className="p-4 text-sm text-muted" data-testid="msgperf-empty">{t("לא נשלחו הודעות בתקופה.", "No messages were sent in the period.")}</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm" data-testid="msgperf-table">
            <thead className="text-xs text-muted"><tr>
              <th className="px-3 h-9 text-start font-medium">{t("מספר / שולח", "Number / sender")}</th><th className="px-2 text-start font-medium">{t("ערוץ", "Channel")}</th>
              <th className="px-2 text-start font-medium">{t("נשלחו", "Sent")}</th><th className="px-2 text-start font-medium">{t("נמסרו", "Delivered")}</th><th className="px-2 text-start font-medium">{t("נקראו", "Read")}</th>
              <th className="px-2 text-start font-medium">{t("נכשלו", "Failed")}</th><th className="px-2 text-start font-medium" title={t("הספק לא החזיר תוצאה ודאית", "The provider returned no definite result")}>{t("לא ידוע", "Unknown")}</th>
            </tr></thead>
            <tbody className="divide-y divide-line">{data.rows.map((r) => line(r))}</tbody>
            {data.totals.filter((r) => data.rows.some((x) => x.channel === r.channel)).length > 0 && <tfoot className="divide-y divide-line border-t border-line">{data.totals.filter((r) => data.rows.some((x) => x.channel === r.channel)).map((r) => line(r, true))}</tfoot>}
          </table></div>}
      {data?.partial && <p className="border-t border-line px-3 py-1.5 text-[11px] text-muted">{t("התקופה עוד לא הסתיימה – הנתונים עד עכשיו.", "The period hasn't ended – data up to now.")}</p>}
    </section>
  );
}
