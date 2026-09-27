import { periodRange } from "@/server/assistant/periods";
import { it, expect } from "vitest";
it("periods in Asia/Jerusalem", () => {
  const now = new Date("2026-09-26T10:30:00Z"); // Saturday 13:30 IDT (UTC+3)
  const t = periodRange("Asia/Jerusalem", "today", now); expect(t.from.toISOString()).toBe("2026-09-25T21:00:00.000Z");
  const w = periodRange("Asia/Jerusalem", "this_week", now); expect(w.from.toISOString()).toBe("2026-09-19T21:00:00.000Z"); // Sunday 20.9
  const lw = periodRange("Asia/Jerusalem", "last_week", now); expect(lw.from.toISOString()).toBe("2026-09-12T21:00:00.000Z"); expect(lw.to.toISOString()).toBe("2026-09-19T21:00:00.000Z");
  const lm = periodRange("Asia/Jerusalem", "last_month", now); expect(lm.from.toISOString()).toBe("2026-07-31T21:00:00.000Z"); expect(lm.to.toISOString()).toBe("2026-08-31T21:00:00.000Z");
  const w2 = periodRange("Asia/Jerusalem", "this_month", new Date("2026-11-02T10:00:00Z")); expect(w2.from.toISOString()).toBe("2026-10-31T22:00:00.000Z"); // after DST end (UTC+2)
  console.log(t.text, "|", w.text, "|", lm.text);
});
