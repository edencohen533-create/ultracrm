import { describe, it, expect } from "vitest";
import { parseSubscription } from "@/server/assistant/subscriptions";
import { parse } from "@/server/assistant/router";

const agents = ["דנה כהן", "יוסי לוי"];
const p = (t: string) => parseSubscription(t, agents);

describe("free text: alerts, recurring summaries, online questions", () => {
  it("alerts when agents come online / go offline", () => {
    expect(p("אני רוצה לקבל התראה כשהנציגים עולים לקו")).toMatchObject({ action: "subscribe", kinds: ["agent_online"], agentNames: [], mode: "first_of_day" });
    expect(p("תודיע לי כשדנה מתחברת")).toMatchObject({ action: "subscribe", kinds: ["agent_online"], agentNames: ["דנה כהן"] });
    expect(p("תעדכן אותי כשנציג מתנתק")).toMatchObject({ action: "subscribe", kinds: ["agent_offline"] });
    expect(p("תודיע לי כשנציגים עולים ויורדים מהקו")).toMatchObject({ action: "subscribe", kinds: ["agent_online", "agent_offline"] });
    expect(p("תודיע לי בכל פעם שיוסי עולה לקו")).toMatchObject({ action: "subscribe", agentNames: ["יוסי לוי"], mode: "every" });
  });
  it("recurring summaries with a clear time; ambiguous hour → clarify", () => {
    expect(p("כל יום ב-18:00 תשלח לי כמה כל נציג היה בקו")).toMatchObject({ action: "schedule", time: "18:00", question: "כמה כל נציג היה בקו" });
    expect(p("תשלח לי כל ערב בשבע סיכום זמני קו")).toMatchObject({ action: "schedule", time: "19:00" });
    expect(p("כל יום ב-6 תשלח לי סיכום")).toMatchObject({ action: "clarify" });
    expect(p("בימי עבודה ב-9:30 תשלח לי לידים ללא טיפול")).toMatchObject({ action: "schedule", time: "09:30", days: [0, 1, 2, 3, 4] });
  });
  it("list / stop", () => {
    expect(p("מה ההתראות שלי")).toMatchObject({ action: "list" });
    expect(p("תפסיק להודיע לי כשנציגים עולים לקו")).toMatchObject({ action: "unsubscribe", what: "online" });
    expect(p("בטל את הסיכום היומי")).toMatchObject({ action: "unsubscribe", what: "report" });
  });
  it("questions are not subscriptions – they go to the online report", () => {
    for (const q of ["מי בקו עכשיו?", "כמה זמן כל נציג היה בקו היום?", "מתי דנה התחברה?", "כמה זמן יוסי עבד אתמול", "מי בהפסקה"]) { expect(p(q)).toBeNull(); expect(parse(q, agents).intent).toBe("online"); }
    expect(parse("כמה זמן יוסי עבד אתמול", agents)).toMatchObject({ period: "yesterday", agentName: "יוסי" });
  });
});
