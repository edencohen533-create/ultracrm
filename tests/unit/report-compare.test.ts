import { describe, it, expect } from "vitest";
import { resolvePeriods, compareMetric, addDays, daysBetween, periodDays } from "@/lib/reports/compare";

const TZ = "Asia/Jerusalem"; // UTC+3 in September (IDT)

describe("resolvePeriods – business timezone, like-for-like", () => {
  it("a day starts at local midnight; the previous period has the same length and ends the day before", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    const p = resolvePeriods({ tz: TZ, from: "2026-09-22", to: "2026-09-28", compare: "previous", now });
    expect(p.current.start.toISOString()).toBe("2026-09-21T21:00:00.000Z");
    expect(p.current.end.toISOString()).toBe("2026-09-28T21:00:00.000Z");
    expect(p.current).toMatchObject({ days: 7, partial: false });
    expect(p.compare).toMatchObject({ from: "2026-09-15", to: "2026-09-21", days: 7, partial: false });
    expect(p.compare!.end.toISOString()).toBe(p.current.start.toISOString());
    expect(p).toMatchObject({ lengthMismatch: false, partialCompare: false });
  });
  it("an unfinished period is cut at now, and the previous one at the same elapsed time", () => {
    const now = new Date("2026-09-29T09:30:00Z"); // 12:30 local
    const p = resolvePeriods({ tz: TZ, from: "2026-09-29", to: "2026-09-29", compare: "previous", now });
    expect(p.current).toMatchObject({ partial: true });
    expect(p.current.end.toISOString()).toBe(now.toISOString());
    expect(p.compare).toMatchObject({ from: "2026-09-28", to: "2026-09-28", partial: true });
    expect(p.compare!.end.toISOString()).toBe("2026-09-28T09:30:00.000Z"); // yesterday 12:30 local
    expect(p.partialCompare).toBe(true);
  });
  it("custom comparison of a different length is marked; a start in the future or an inverted range is refused", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    const p = resolvePeriods({ tz: TZ, from: "2026-09-01", to: "2026-09-30", compare: "custom", compareFrom: "2026-08-01", compareTo: "2026-08-31", now });
    expect(p).toMatchObject({ mode: "custom", lengthMismatch: true });
    expect(() => resolvePeriods({ tz: TZ, from: "2026-11-01", to: "2026-11-02", compare: "none", now })).toThrow();
    expect(() => resolvePeriods({ tz: TZ, from: "2026-09-10", to: "2026-09-01", compare: "none", now })).toThrow();
    expect(resolvePeriods({ tz: TZ, from: "2026-09-01", to: "2026-09-01", compare: "none", now }).compare).toBeNull();
  });
  it("DST end (Israel, 25.10.2026) keeps whole local days", () => {
    const p = resolvePeriods({ tz: TZ, from: "2026-10-25", to: "2026-10-25", compare: "none", now: new Date("2026-11-01T00:00:00Z") });
    expect(p.current.start.toISOString()).toBe("2026-10-24T21:00:00.000Z"); // still IDT at midnight
    expect(p.current.end.toISOString()).toBe("2026-10-25T22:00:00.000Z"); // IST from 02:00 → a 25-hour day
  });
  it("date helpers and daily buckets", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(30);
    const p = resolvePeriods({ tz: TZ, from: "2026-09-28", to: "2026-09-30", compare: "none", now: new Date("2026-09-29T09:00:00Z") }).current;
    expect(periodDays(p, TZ)).toEqual(["2026-09-28", "2026-09-29"]); // the 30th hasn't started
  });
});

describe("compareMetric – honest changes", () => {
  it("counts: absolute + relative", () => {
    expect(compareMetric(12, 8, "count", "up")).toMatchObject({ delta: 4, relative: 50, trend: "better", note: null });
    expect(compareMetric(6, 8, "count", "up")).toMatchObject({ delta: -2, relative: -25, trend: "worse" });
  });
  it("zero base: no infinite %, a wording note instead", () => {
    expect(compareMetric(5, 0, "count", "up")).toMatchObject({ delta: 5, relative: null, note: "from_zero", trend: "better" });
    expect(compareMetric(0, 0, "count", "up")).toMatchObject({ delta: 0, relative: null, note: "both_zero", trend: "same" });
    expect(compareMetric(null, 0.3, "rate", "up")).toMatchObject({ note: "no_data", delta: null, trend: null });
  });
  it("rates: percentage points kept apart from relative change", () => {
    const c = compareMetric(0.25, 0.2, "rate", "up");
    expect(c).toMatchObject({ points: 5, relative: 25, trend: "better" });
    expect(compareMetric(0.1, 0, "rate", "up")).toMatchObject({ points: 10, relative: null, note: "from_zero" });
  });
  it("the trend follows the metric's meaning", () => {
    expect(compareMetric(30, 20, "minutes", "down").trend).toBe("worse"); // slower response
    expect(compareMetric(3, 5, "count", "down").trend).toBe("better"); // fewer never-dialed leads
    expect(compareMetric(600, 300, "duration", "neutral").trend).toBe("neutral");
  });
  it("no comparison period", () => {
    expect(compareMetric(5, undefined, "count", "up")).toMatchObject({ note: "no_compare", trend: null });
  });
});
