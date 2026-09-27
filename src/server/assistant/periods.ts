/**
 * Report periods in the BUSINESS timezone (weeks start on Sunday, as in Israel). Every answer states its period.
 */
export const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days"] as const;
export type PeriodKey = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<PeriodKey, string> = { today: "היום", yesterday: "אתמול", this_week: "השבוע", last_week: "השבוע הקודם", this_month: "החודש", last_month: "החודש הקודם", last_7_days: "7 הימים האחרונים", last_30_days: "30 הימים האחרונים" };
/** The period that "compare" puts next to each one. */
export const PREVIOUS: Record<PeriodKey, PeriodKey> = { today: "yesterday", yesterday: "yesterday", this_week: "last_week", last_week: "last_week", this_month: "last_month", last_month: "last_month", last_7_days: "last_7_days", last_30_days: "last_30_days" };

function parts(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** UTC instant of local midnight y-m-d in tz (DST-safe: re-checks the offset at the result). */
export function zonedMidnight(tz: string, y: number, m: number, d: number) {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) { const p = parts(tz, new Date(guess)); const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s); guess += Date.UTC(y, m - 1, d) - asUtc; }
  return new Date(guess);
}
const addDays = (tz: string, base: { y: number; m: number; d: number }, n: number) => { const t = new Date(Date.UTC(base.y, base.m - 1, base.d + n)); return zonedMidnight(tz, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

export interface Range { key: PeriodKey; label: string; from: Date; to: Date; /** "26.9.2026" or "20.9–26.9.2026" in the business timezone */ text: string; partial: boolean }

export function periodRange(tz: string, key: PeriodKey, now = new Date()): Range {
  const t = parts(tz, now);
  const today = { y: t.y, m: t.m, d: t.d };
  let from: Date; let to: Date;
  switch (key) {
    case "today": from = addDays(tz, today, 0); to = now; break;
    case "yesterday": from = addDays(tz, today, -1); to = addDays(tz, today, 0); break;
    case "this_week": from = addDays(tz, today, -t.wd); to = now; break;
    case "last_week": from = addDays(tz, today, -t.wd - 7); to = addDays(tz, today, -t.wd); break;
    case "this_month": from = zonedMidnight(tz, t.y, t.m, 1); to = now; break;
    case "last_month": { const lm = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 }; from = zonedMidnight(tz, lm.y, lm.m, 1); to = zonedMidnight(tz, t.y, t.m, 1); break; }
    case "last_7_days": from = addDays(tz, today, -6); to = now; break;
    case "last_30_days": from = addDays(tz, today, -29); to = now; break;
  }
  const fmt = (d: Date) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "numeric", month: "numeric", year: "numeric" }).format(d);
  const lastIncluded = new Date(to.getTime() - 1);
  const text = fmt(from) === fmt(lastIncluded) ? fmt(from) : `${fmt(from).replace(/\.\d{4}$/, "")}–${fmt(lastIncluded)}`;
  return { key, label: PERIOD_LABEL[key], from, to, text, partial: to.getTime() === now.getTime() };
}

export const clockIn = (tz: string, d = new Date()) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
export const localParts = parts;
