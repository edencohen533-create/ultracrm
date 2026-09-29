import { it, expect } from "vitest";
import { slaDeadline } from "@/server/ops/sla-time";
const window = {
  start: "09:00",
  end: "17:00",
  days: [0, 1, 2, 3, 4],
  timezone: "Asia/Jerusalem",
};
it("counts exact clock minutes unless working hours are requested", () => {
  expect(slaDeadline(new Date("2026-09-24T13:59:30Z"), 5)?.toISOString()).toBe(
    "2026-09-24T14:04:30.000Z",
  );
});
it("preserves seconds and skips Friday and Saturday after closing", () => {
  expect(
    slaDeadline(new Date("2026-09-24T13:59:30Z"), 5, window)?.toISOString(),
  ).toBe("2026-09-27T06:04:30.000Z");
});
it("starts only on the next opening and refuses an empty schedule", () => {
  expect(
    slaDeadline(new Date("2026-09-25T08:00:00Z"), 5, window)?.toISOString(),
  ).toBe("2026-09-27T06:05:00.000Z");
  expect(slaDeadline(new Date(), 5, { ...window, days: [] })).toBeNull();
});
