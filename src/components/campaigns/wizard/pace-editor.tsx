"use client";

import { useState } from "react";
import { useT } from "@/components/i18n/LangProvider";
import type { Throttle } from "@/lib/campaign-shared";

export interface MetaLimit { limit: number | null; tier: string | null; source: "meta" | "default"; used: number; remaining: number | null }

const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;
const MAX_BATCH = 100000;

/** "שלח ל-X נמענים כל Y דקות/שעות" – validated, with the estimated finish (user pace and Meta's 24h limit). */
export function PaceEditor({ throttle, onChange, eligible, metaLimit }: { throttle: Throttle | null; onChange: (t: Throttle | null) => void; eligible: number | null; metaLimit: MetaLimit | null }) {
  const t = useT();
  const initUnit = throttle && throttle.intervalMinutes % 60 === 0 && throttle.intervalMinutes >= 60 ? "hours" : "minutes";
  const [batch, setBatch] = useState(String(throttle?.batchSize ?? 100));
  const [every, setEvery] = useState(String(throttle ? (initUnit === "hours" ? throttle.intervalMinutes / 60 : throttle.intervalMinutes) : 1));
  const [unit, setUnit] = useState<"minutes" | "hours">(throttle ? initUnit : "hours");

  const b = Number(batch), e = Number(every);
  const minutes = unit === "hours" ? e * 60 : e;
  const errBatch = !Number.isInteger(b) || b < 1 || b > MAX_BATCH ? t(`כמות בין 1 ל-${MAX_BATCH.toLocaleString("he-IL")}`, `A number between 1 and ${MAX_BATCH.toLocaleString("en-GB")}`) : null;
  const errEvery = !Number.isInteger(e) || e < 1 || minutes < MIN_MINUTES || minutes > MAX_MINUTES ? t("מרווח בין 5 דקות ל-24 שעות", "An interval between 5 minutes and 24 hours") : null;
  const apply = (nb: string, ne: string, nu: "minutes" | "hours") => {
    const bb = Number(nb), ee = Number(ne), mm = nu === "hours" ? ee * 60 : ee;
    if (Number.isInteger(bb) && bb >= 1 && bb <= MAX_BATCH && Number.isInteger(ee) && ee >= 1 && mm >= MIN_MINUTES && mm <= MAX_MINUTES) onChange({ batchSize: bb, intervalMinutes: mm });
  };

  const fmt = (mins: number) => mins < 60 ? t(`${Math.max(1, Math.round(mins))} דקות`, `${Math.max(1, Math.round(mins))} minutes`) : mins < 48 * 60 ? t(`${Math.round(mins / 6) / 10} שעות`, `${Math.round(mins / 6) / 10} hours`) : t(`${Math.round(mins / 144) / 10} ימים`, `${Math.round(mins / 144) / 10} days`);
  const limit = metaLimit?.limit ?? null;
  const remaining = metaLimit?.remaining ?? null;
  let eta: number | null = null;
  if (eligible != null && eligible > 0) {
    const paceMins = throttle ? (Math.ceil(eligible / throttle.batchSize) - 1) * throttle.intervalMinutes : 0;
    const capMins = limit != null && remaining != null && eligible > remaining ? Math.ceil((eligible - remaining) / limit) * 1440 : 0;
    eta = Math.max(paceMins, capMins);
  }
  const paceAboveLimit = limit != null && throttle && throttle.batchSize * (1440 / throttle.intervalMinutes) > limit;

  return (
    <div className="space-y-2" data-testid="pace-editor">
      <label className="jr-check"><input type="radio" name="pace" checked={!throttle} onChange={() => onChange(null)} data-testid="pace-all" /> {t("לשלוח לכולם ברצף", "Send to everyone continuously")}</label>
      <label className="jr-check"><input type="radio" name="pace" checked={Boolean(throttle)} onChange={() => apply(batch, every, unit)} data-testid="pace-batched" /> {t("לשלוח בהדרגה:", "Send gradually:")}</label>
      {throttle && (
        <div className="wz-pace-row flex flex-wrap items-center gap-2">
          <span>{t("שלח ל-", "Send to")}</span>
          <input type="number" inputMode="numeric" min={1} max={MAX_BATCH} value={batch} onChange={(ev) => { setBatch(ev.target.value); apply(ev.target.value, every, unit); }} aria-label={t("כמות נמענים בכל סבב", "Recipients per round")} aria-invalid={Boolean(errBatch)} data-testid="pace-size" />
          <span>{t("נמענים כל", "recipients every")}</span>
          <input type="number" inputMode="numeric" min={1} value={every} onChange={(ev) => { setEvery(ev.target.value); apply(batch, ev.target.value, unit); }} aria-label={t("מרווח בין סבבים", "Interval between rounds")} aria-invalid={Boolean(errEvery)} data-testid="pace-every" />
          <select value={unit} onChange={(ev) => { const u = ev.target.value as "minutes" | "hours"; setUnit(u); apply(batch, every, u); }} aria-label={t("יחידת זמן", "Time unit")} data-testid="pace-unit">
            <option value="minutes">{t("דקות", "minutes")}</option><option value="hours">{t("שעות", "hours")}</option>
          </select>
        </div>
      )}
      {throttle && (errBatch || errEvery) && <p role="alert" className="wz-err" data-testid="pace-error">{errBatch ?? errEvery}</p>}
      {eta != null && !(throttle && (errBatch || errEvery)) && <p className="wz-hint" data-testid="pace-eta">{eta === 0 ? t(`${eligible!.toLocaleString("he-IL")} נמענים – השליחה צפויה להסתיים בתוך הריצה הראשונה (בכפוף לחלון השליחה של העסק).`, `${eligible!.toLocaleString("en-GB")} recipients – expected to finish in the first run (within the business send window).`) : t(`${eligible!.toLocaleString("he-IL")} נמענים – סיום משוער בעוד כ-${fmt(eta)} (בכפוף לחלון השליחה של העסק).`, `${eligible!.toLocaleString("en-GB")} recipients – estimated finish in ~${fmt(eta)} (within the business send window).`)}</p>}
      {limit != null && (
        <p className="wz-hint" data-testid="pace-meta-limit">
          {t(`מגבלת Meta לחשבון: עד ${limit.toLocaleString("he-IL")} נמענים חדשים ב-24 שעות${metaLimit?.source === "default" ? " (Meta לא דיווחה על השלב – מוחל המינימום)" : ""}. נותרו כעת ${(remaining ?? 0).toLocaleString("he-IL")}.`, `Meta account limit: up to ${limit.toLocaleString("en-GB")} new recipients per 24 hours${metaLimit?.source === "default" ? " (Meta has not reported the tier – the minimum applies)" : ""}. ${(remaining ?? 0).toLocaleString("en-GB")} left now.`)}
          {paceAboveLimit && t(" הקצב שבחרת גבוה מהמגבלה – השליחה תואט אוטומטית.", " Your pace is above the limit – sending is slowed down automatically.")}
        </p>
      )}
    </div>
  );
}
