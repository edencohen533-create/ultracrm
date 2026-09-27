import { describe, it, expect } from "vitest";
import { parse, detectPeriod } from "@/server/assistant/router";

const agents = ["דנה כהן", "דנה לוי", "יוסי אברהם"];
describe("assistant router", () => {
  it.each([
    ["איך הולך היום?", "snapshot", "today"],
    ["כמה מכרנו השבוע?", "sales", "this_week"],
    ["כמה לידים נכנסו החודש וכמה נסגרו?", "leads", "this_month"],
    ["מה אחוז הסגירה של כל נציג?", "agents", null],
    ["מי מכר הכי הרבה היום?", "top_agent", "today"],
    ["כמה שיחות יצאו אתמול?", "calls", "yesterday"],
    ["כמה לידים עוד לא קיבלו טיפול?", "untreated", null],
    ["אילו משימות באיחור?", "overdue", null],
    ["תשווה את השבוע לשבוע הקודם", "compare", null],
    ["כמה מכרנו בשבוע הקודם?", "sales", "last_week"],
    ["על מה להתמקד היום?", "focus", "today"],
    ["תן לי סיכום של הלקוח משה פרץ", "contact", null],
  ])("%s → %s", (q, intent, period) => {
    const p = parse(q, agents);
    expect(p.intent).toBe(intent);
    if (period) expect(p.period).toBe(period);
  });
  it("follow-ups have no intent of their own and carry an agent / period", () => {
    expect(parse("ורק של יוסי?", agents)).toMatchObject({ intent: null, followUp: true, agentName: "יוסי" });
    expect(parse("ומה היה אתמול?", agents)).toMatchObject({ intent: null, followUp: true, period: "yesterday" });
  });
  it("contact query and threshold extraction", () => {
    expect(parse("תן לי סיכום של הלקוח משה פרץ", agents).contactQuery).toBe("משה פרץ");
    expect(parse("לידים שלא קיבלו טיפול יותר מ 2 שעות", agents).olderThanMinutes).toBe(120);
  });
  it("period words", () => {
    expect(detectPeriod("בחודש שעבר")).toBe("last_month");
    expect(detectPeriod("ב-7 הימים האחרונים")).toBe("last_7_days");
  });
});
