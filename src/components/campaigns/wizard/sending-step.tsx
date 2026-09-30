"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/i18n/LangProvider";
import type { Throttle } from "@/lib/campaign-shared";
import { PaceEditor, type MetaLimit } from "./pace-editor";

export interface SendWindow { start: string; end: string; days: number[] }
export interface SendDefaults { timezone: string; window: SendWindow; maxPerMinute: number; minHoursBetweenMarketing: number }
type Data = { sendMode?: "now" | "schedule"; scheduleDate?: string; scheduleTime?: string; sendWindow?: SendWindow | null; throttle?: Throttle | null };

/** Business-local "YYYY-MM-DD" / "HH:MM" now. */
function zonedNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const DAY_NAMES = { he: ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };

/**
 * "שליחה": when (now after approval / a business-local date + time), this campaign's sending window (days + hours,
 * starting from the business default) and the pace (X recipients every Y). Saved in the draft; the business-wide
 * ceiling, frequency protection, Meta's limit, blocks and budget are enforced by the server queue on top of it.
 */
export function SendingStep({ data, patch, defaults, channel, metaLimit, problems }: { data: Data; patch: (d: Record<string, unknown>) => void; defaults: SendDefaults | null; channel: "whatsapp" | "sms" | "email"; metaLimit: MetaLimit | null; problems: Array<{ message: string }> }) {
  const t = useT();
  const days = t.lang === "en" ? DAY_NAMES.en : DAY_NAMES.he;
  const mode = data.sendMode ?? "now";
  const win = data.sendWindow ?? defaults?.window ?? null;
  // First visit: start from the business's default window, saved into this draft (visible, editable – never silent).
  useEffect(() => { if (defaults && data.sendWindow === undefined) patch({ sendWindow: defaults.window }); }, [defaults, data.sendWindow, patch]);
  const now = defaults ? zonedNow(defaults.timezone) : null;
  const past = mode === "schedule" && now && data.scheduleDate && data.scheduleTime && `${data.scheduleDate} ${data.scheduleTime}` < `${now.date} ${now.time}`;
  const [touched, setTouched] = useState(false);
  if (!defaults || !win) return <div className="wz-form" data-testid="wz-sending"><p className="wz-hint">{t("טוען…", "Loading…")}</p></div>;
  const setWin = (w: Partial<SendWindow>) => { setTouched(true); patch({ sendWindow: { ...win, ...w } }); };
  return (
    <div className="wz-form wide space-y-5" data-testid="wz-sending">
      <div><h2>{t("מתי ובאיזה קצב לשלוח", "When and how fast to send")}</h2><p className="wz-sub">{t(`כל הזמנים לפי אזור הזמן של העסק: ${defaults.timezone}. ההגדרות נשמרות בטיוטה ומוצגות בבקרה לפני ההפעלה.`, `All times are in the business's time zone: ${defaults.timezone}. Saved in the draft and shown at review before starting.`)}</p></div>

      <section className="space-y-2" aria-labelledby="wz-when">
        <h3 id="wz-when" className="wz-label">{t("מועד השליחה", "Send time")}</h3>
        <div className="flex flex-col gap-1.5"><label className="jr-check flex items-center gap-2"><input type="radio" name="send-mode" checked={mode === "now"} onChange={() => patch({ sendMode: "now" })} data-testid="send-now" /> {t("מיד אחרי האישור", "Right after approval")}</label>
        <label className="jr-check flex items-center gap-2"><input type="radio" name="send-mode" checked={mode === "schedule"} onChange={() => patch({ sendMode: "schedule", scheduleDate: data.scheduleDate ?? now!.date, scheduleTime: data.scheduleTime ?? "10:00" })} data-testid="send-schedule" /> {t("בתאריך ושעה", "At a date and time")}</label></div>
        {mode === "schedule" && <div className="flex flex-wrap items-end gap-2">
          <label className="wz-field inline"><span className="wz-label">{t("תאריך", "Date")}</span><input type="date" min={now!.date} value={data.scheduleDate ?? ""} onChange={(e) => patch({ scheduleDate: e.target.value })} data-testid="send-date" /></label>
          <label className="wz-field inline"><span className="wz-label">{t("שעה", "Time")}</span><input type="time" value={data.scheduleTime ?? ""} onChange={(e) => patch({ scheduleTime: e.target.value })} data-testid="send-time" /></label>
          <span className="wz-hint">{defaults.timezone}</span>
        </div>}
        {past && <p role="alert" className="wz-err">{t("המועד שנבחר כבר עבר", "The chosen time has passed")}</p>}
      </section>

      <section className="space-y-2" aria-labelledby="wz-window">
        <h3 id="wz-window" className="wz-label">{t("חלון שליחה – ימים ושעות מותרים", "Sending window – allowed days and hours")}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label={t("ימים", "Days")}>{days.map((d, i) => <button key={i} type="button" aria-pressed={win.days.includes(i)} onClick={() => setWin({ days: win.days.includes(i) ? win.days.filter((x) => x !== i) : [...win.days, i].sort() })} className={`h-8 w-9 rounded-md border text-xs ${win.days.includes(i) ? "border-accent bg-accent text-white" : "border-line"}`} data-testid={`window-day-${i}`}>{d}</button>)}</div>
          <label className="wz-field inline"><span className="wz-label">{t("מ-", "From")}</span><input type="time" value={win.start} onChange={(e) => setWin({ start: e.target.value })} data-testid="window-start" /></label>
          <label className="wz-field inline"><span className="wz-label">{t("עד", "To")}</span><input type="time" value={win.end} onChange={(e) => setWin({ end: e.target.value })} data-testid="window-end" /></label>
        </div>
        <p className="wz-hint">{t("מחוץ לחלון הודעות שיווקיות ממתינות ויוצאות בחלון הבא. ", "Outside the window marketing messages wait for the next window. ")}{!touched && t("(התחלנו מחלון ברירת המחדל של העסק.)", "(Started from the business default window.)")}</p>
      </section>

      <section className="space-y-2" aria-labelledby="wz-pace">
        <h3 id="wz-pace" className="wz-label">{t("קצב שליחה", "Sending pace")}</h3>
        <div className="[&_.jr-check]:flex [&_.jr-check]:items-center [&_.jr-check]:gap-2"><PaceEditor throttle={data.throttle ?? null} onChange={(tt) => patch({ throttle: tt })} eligible={null} metaLimit={channel === "whatsapp" ? metaLimit : null} /></div>
        <ul className="wz-hint list-disc ps-5" data-testid="send-limits">
          {defaults.maxPerMinute > 0 && <li>{t(`תקרת העסק: עד ${defaults.maxPerMinute} נמענים בדקה בכל הקמפיינים יחד – גם אם בחרתם קצב גבוה יותר.`, `Business ceiling: up to ${defaults.maxPerMinute} recipients a minute across all campaigns – even if you chose a faster pace.`)}</li>}
          {defaults.minHoursBetweenMarketing > 0 && <li>{t(`הגנת תדירות: נמען שקיבל הודעה שיווקית ב-${defaults.minHoursBetweenMarketing} השעות האחרונות מדולג.`, `Frequency protection: a recipient who got a marketing message in the last ${defaults.minHoursBetweenMarketing} hours is skipped.`)}</li>}
          <li>{t("הסכמה, הסרות, חסימות, מגבלות הספק ותקציב נבדקים לכל נמען בזמן השליחה, בתור בשרת – גם אם הדפדפן סגור.", "Consent, unsubscribes, blocks, provider limits and budget are checked per recipient at send time, in a server queue – even with the browser closed.")}</li>
        </ul>
      </section>
      {problems.length > 0 && <ul className="wz-blockers">{problems.map((p) => <li key={p.message}>{p.message}</li>)}</ul>}
    </div>
  );
}
