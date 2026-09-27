import { describe, it, expect } from "vitest";
import { classifyBasic } from "@/lib/dialer/availability";

// 2026-09-28 12:00 Asia/Jerusalem (UTC+3)
const at = new Date("2026-09-28T09:00:00Z");
const c = (t: string) => classifyBasic(t, at, "Asia/Jerusalem");

describe("WhatsApp availability intent (rule-based fallback)", () => {
  it("now – only affirmative availability", () => {
    for (const t of ["אני זמינה עכשיו", "אני זמין עכשיו", "אפשר עכשיו", "תתקשרו אליי", "פנויה עכשיו"]) expect(c(t)).toMatchObject({ intent: "now" });
  });
  it("negations never prioritize", () => {
    for (const t of ["אני לא זמינה עכשיו", "בעצם לא עכשיו", "עכשיו לא מתאים", "אני בישיבה"]) expect(c(t).intent).toBe("unavailable");
  });
  it("do not call", () => { expect(c("אל תתקשרו אליי יותר").intent).toBe("do_not_call"); });
  it("explicit later times in the business timezone", () => {
    expect(c("בעוד חצי שעה").when?.toISOString()).toBe("2026-09-28T09:30:00.000Z");
    expect(c("מחר בעשר").when?.toISOString()).toBe("2026-09-29T07:00:00.000Z");
    expect(c("מחר בשלוש אחה\"צ").when?.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(c("היום בשעה 18:30").when?.toISOString()).toBe("2026-09-28T15:30:00.000Z");
  });
  it("ambiguous or vague times go to review (low confidence, no time)", () => {
    for (const t of ["מחר בשלוש", "אחר כך", "מחר", "בערב"]) expect(c(t)).toMatchObject({ intent: "later", when: null, confidence: 0.5 });
  });
  it("unclear / unrelated", () => {
    expect(c("מתי אתם מתקשרים?").intent).toBe("unclear");
    expect(c("תודה רבה").intent).toBe("none");
  });
});
