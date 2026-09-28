import { describe, expect, it } from "vitest";
import { zonedDateTime, zonedParts } from "@/lib/business-day";

describe("scheduled wall-clock dates", () => {
  it.each(["2026-02-29", "2026-02-30", "2026-04-31"])("rejects nonexistent calendar date %s", (date) => {
    expect(zonedDateTime("Asia/Jerusalem", date, "12:00")).toBeNull();
  });
  it("rejects times skipped by daylight saving instead of silently shifting the callback", () => {
    expect(zonedDateTime("America/New_York", "2026-03-08", "02:30")).toBeNull();
  });
  it.each([
    ["UTC", "2028-02-29", "12:00"],
    ["Asia/Jerusalem", "2026-09-28", "14:30"],
    ["America/New_York", "2026-03-08", "03:30"],
    ["America/New_York", "2026-11-01", "01:30"],
  ])("preserves valid local time %s %s %s", (tz, date, time) => {
    const instant = zonedDateTime(tz, date, time);
    expect(instant).not.toBeNull();
    expect(zonedParts(tz, instant!)).toEqual({ date, time });
  });
});
