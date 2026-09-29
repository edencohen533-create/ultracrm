import { describe, it, expect } from "vitest";
import { classifyContactRequest } from "@/lib/contact-requests";

const kind = (t: string) => classifyContactRequest(t).kind;

describe("classifyContactRequest – by context, not by a single word", () => {
  it("clear removal requests in many phrasings", () => {
    for (const t of ["הסר", "הסר!", "STOP", "תפסיקו לשלוח לי", "תפסיק לשלוח", "אל תשלחו לי יותר הודעות", "תמחקו אותי", "תמחקו אותי מהרשימה בבקשה", "תורידו אותי מהרשימה", "הסירו אותי", "please unsubscribe me", "remove me from this list", "stop sending me messages"]) expect(kind(t), t).toBe("unsubscribe");
  });
  it("do not call", () => {
    for (const t of ["אל תתקשרו אליי", "אל תתקשר אלי יותר", "תפסיקו להתקשר", "בבקשה לא להתקשר אליי", "don't call me again", "stop calling"]) expect(kind(t), t).toBe("do_not_call");
  });
  it("wrong number / wrong person", () => {
    for (const t of ["מספר שגוי", "זה מספר שגוי", "טעות במספר", "זו טעות, אני לא האדם שאתם מחפשים", "זו טעות אני לא מי שאתם מחפשים", "הגעתם למספר הלא נכון", "wrong number", "sorry, wrong person"]) expect(kind(t), t).toBe("wrong_person");
  });
  it("the word 'טעות' in another context is not a request", () => {
    for (const t of ["יש טעות בחשבונית", "נראה לי שיש טעות במחיר", "טעות קטנה בכתובת, תתקנו", "סליחה, טעיתי בשעה", "הייתה טעות בהזמנה שלי"]) expect(kind(t), t).toBe("none");
  });
  it("weak signals alone go to review", () => {
    for (const t of ["זו טעות", "טעות", "לא מעוניין", "למה אתם שולחים לי?", "איך מסירים?", "not interested"]) expect(kind(t), t).toBe("unclear");
  });
  it("negations and unrelated messages", () => {
    for (const t of ["אל תסירו אותי, אני רוצה לקבל עדכונים", "לא ביקשתי להסיר", "מתי אתם פתוחים?", "אפשר להתקשר אליי מחר?", "תודה רבה!", "", "   "]) expect(kind(t), t).toBe("none");
  });
});
