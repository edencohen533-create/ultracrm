/**
 * Period comparison for reports – pure functions (unit tested).
 *
 *  • Days are business-timezone calendar days: [from 00:00, day after `to` 00:00) in the business timezone.
 *  • A period that has not ended yet is cut at "now" and marked partial. When it is compared with "the previous
 *    period of the same length", the previous period is cut at the same elapsed point – like with like.
 *  • A custom comparison range of a different length is allowed and marked (counts are then not like for like).
 *  • Change of a count / amount / duration: absolute difference + relative % – but never a % from a zero base.
 *  • Change of a rate (answer rate, close rate): percentage points AND relative %, kept apart.
 *  • Trend follows the metric's meaning (e.g. a longer response time is worse), "neutral" metrics get no colour.
 */
import { zonedDateTime, zonedParts } from "@/lib/business-day";

export type MetricKind = "count" | "rate" | "duration" | "money" | "minutes";
export type Direction = "up" | "down" | "neutral";
export interface Period { from: string; to: string; start: Date; end: Date; days: number; partial: boolean }
export interface Periods { current: Period; compare: Period | null; mode: "previous" | "custom" | "none"; lengthMismatch: boolean; partialCompare: boolean }

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function addDays(date: string, n: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysBetween(from: string, to: string) { return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1; }

function period(tz: string, from: string, to: string, now: Date): Period {
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error("טווח תאריכים לא תקין");
  const start = zonedDateTime(tz, from, "00:00")!; const endFull = zonedDateTime(tz, addDays(to, 1), "00:00")!;
  if (start > now) throw new Error("טווח התאריכים מתחיל בעתיד");
  const partial = endFull > now;
  return { from, to, start, end: partial ? now : endFull, days: daysBetween(from, to), partial };
}

/** Resolve the current and comparison periods in the business timezone. */
export function resolvePeriods(input: { tz: string; from: string; to: string; compare: "previous" | "custom" | "none"; compareFrom?: string | null; compareTo?: string | null; now?: Date }): Periods {
  const now = input.now ?? new Date();
  const current = period(input.tz, input.from, input.to, now);
  if (input.compare === "none") return { current, compare: null, mode: "none", lengthMismatch: false, partialCompare: false };
  if (input.compare === "custom") {
    if (!input.compareFrom || !input.compareTo) throw new Error("יש לבחור טווח להשוואה");
    const compare = period(input.tz, input.compareFrom, input.compareTo, now);
    return { current, compare, mode: "custom", lengthMismatch: compare.days !== current.days || compare.partial !== current.partial, partialCompare: current.partial || compare.partial };
  }
  // The previous period of the same number of days, ending the day before `from`.
  const cFrom = addDays(input.from, -current.days), cTo = addDays(input.from, -1);
  const full = period(input.tz, cFrom, cTo, now);
  // Unfinished current period → the previous one is cut at the same elapsed time (like with like).
  const compare = current.partial ? { ...full, end: new Date(full.start.getTime() + (current.end.getTime() - current.start.getTime())), partial: true } : full;
  return { current, compare, mode: "previous", lengthMismatch: false, partialCompare: current.partial };
}

export interface Change {
  current: number | null; previous: number | null;
  /** Absolute difference (for rates: in percentage points ×100, i.e. 0.05 → 5 pp). */
  delta: number | null;
  /** Relative change in % – null when the base is zero / missing (never "infinite"). */
  relative: number | null;
  /** Percentage points (rates only). */
  points: number | null;
  note: "no_compare" | "no_data" | "both_zero" | "from_zero" | null;
  trend: "better" | "worse" | "same" | "neutral" | null;
}

/** Compare one metric. Rates are fractions (0..1) or null when their denominator is 0. */
export function compareMetric(current: number | null, previous: number | null | undefined, kind: MetricKind, direction: Direction): Change {
  if (previous === undefined) return { current, previous: null, delta: null, relative: null, points: null, note: "no_compare", trend: null };
  if (current === null || previous === null) return { current, previous, delta: null, relative: null, points: null, note: "no_data", trend: null };
  const delta = current - previous;
  const points = kind === "rate" ? Math.round(delta * 1000) / 10 : null;
  let note: Change["note"] = null; let relative: number | null = null;
  if (previous === 0 && current === 0) note = "both_zero";
  else if (previous === 0) note = "from_zero";
  else relative = Math.round((delta / Math.abs(previous)) * 1000) / 10;
  const same = kind === "rate" ? Math.abs(delta) < 0.0005 : delta === 0;
  const trend: Change["trend"] = same ? "same" : direction === "neutral" ? "neutral" : (delta > 0) === (direction === "up") ? "better" : "worse";
  return { current, previous, delta, relative, points, note, trend };
}

/** Business-timezone calendar days of a period (for daily series), as "YYYY-MM-DD". */
export function periodDays(p: Period, tz: string) {
  const out: string[] = [];
  for (let d = p.from; d <= p.to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out.filter((d) => zonedDateTime(tz, d, "00:00")! < p.end);
}
export const dayOf = (tz: string, at: Date) => zonedParts(tz, at).date;
