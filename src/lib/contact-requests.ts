/**
 * What an inbound message asks about being contacted – by context, not by a single word.
 *
 *   unsubscribe   "הסר", "תפסיקו לשלוח", "תמחקו אותי", STOP …           → marketing stopped + no calls
 *   do_not_call   "אל תתקשרו אליי", "תפסיקו להתקשר" …                    → marketing stopped + no calls
 *   wrong_person  "מספר שגוי", "זו טעות, אני לא האדם שאתם מחפשים" …       → nothing at all (not our customer)
 *   unclear       a weak signal only ("זו טעות", "לא מעוניין", "למה אתם שולחים?") → automatic outreach paused, a
 *                 manager decides
 *   none          everything else – including "טעות" in another context ("יש טעות בחשבונית", "טעיתי בשעה").
 * Rules are deterministic and explainable (the matched phrase is kept as evidence). A clear request is applied at
 * once; anything uncertain is held for a person, never guessed.
 */
export type ContactRequestKind = "unsubscribe" | "do_not_call" | "wrong_person" | "unclear" | "none";
export interface ContactRequest { kind: ContactRequestKind; matched: string | null }

export function normalizeText(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[\u0591-\u05BD\u05BF-\u05C7\u200B-\u200F\u202A-\u202E]/g, "").replace(/[׳']/g, "'").replace(/[״"]/g, '"').replace(/\s+/g, " ").trim();
}

const EXACT_UNSUBSCRIBE = new Set(["הסר", "הסרה", "הסר אותי", "הסירו אותי", "הפסק", "הפסיקו", "stop", "stop all", "unsubscribe", "cancel", "remove me", "end", "quit"]);

// "don't remove me" / "I did not ask to be removed" – never a removal.
const NEGATED = [/אל תפסיק(ו)? (לשלוח|להתקשר|לכתוב)/, /לא (רוצה|מעוניין|מעוניינת) (שתסיר|שתמחק|להפסיק|הסרה)/, /do not (remove|unsubscribe|delete)/, /don'?t stop (sending|calling)/, /אל ת(סיר|מחק|וריד)/, /לא (ביקשתי|רציתי) (ל)?(הסיר|הסרה|להסיר|למחוק)/, /don'?t (remove|unsubscribe|delete)/];

const DO_NOT_CALL = [
  /(?:אל|נא לא)\s+(?:תתקשרו?|תחייגו?|להתקשר|לחייג)(?:[\s.!?,]|$)/,
  /(?:נא |בבקשה )?להפסיק (?:להתקשר|לחייג|לצלצל)/,
  /לא (?:רוצה|מעוניין|מעוניינת) (?:שתתקשרו|שיחות|לקבל שיחות)/,
  /אל (ת|תת)קשר(ו)? (אלי|לי)/, /אל תתקשר(ו)?\b/, /תפסיק(ו)? (ל)?(התקשר|להתקשר|לצלצל)/, /(לא|בלי) (ל)?(התקשר|להתקשר) (אלי|אליי)/,
  /אל תחייג(ו)?/, /don'?t call/, /stop calling/, /do not call/, /no more calls/,
];
const UNSUBSCRIBE = [
  /^(?:בבקשה[ ,]*)?(?:הסר|הסרה|הסירו|הפסיקו)(?:[ ,]*(?:בבקשה|תודה))*[.!?]*$/,
  /(?:נא |בבקשה )?(?:להפסיק|הפסיקו|הפסק) (?:לשלוח|לכתוב|להטריד)/,
  /(?:נא לא|מבקש לא|מבקשת לא) (?:לשלוח|לכתוב|ליצור קשר)/,
  /(?:הסר|הסירו|תסירו?|להסיר|תורידו?|להוריד)(?: אותי)? מ(?:רשימת התפוצה|הרשימה|התפוצה|דיוור|הדיוור|רשימות התפוצה)/,
  /לא (?:רוצה|מעוניין|מעוניינת) (?:יותר )?לקבל (?:יותר )?(?:הודעות|דיוור|פרסומות|מסרים)/,
  /אל (?:תיצרו|תיצור|תצרו) (?:איתי |עמי )?קשר/,
  /do not (?:send|text|message|contact)/, /don'?t (?:send|text|message|contact)/,
  /תפסיק(ו)? (ל)?(שלוח|לשלוח|לכתוב|להטריד)/, /אל תשלח(ו)? (לי )?(יותר|עוד|הודעות)/, /(ת|לה)מחק(ו)? אותי/, /מחק(ו)? אותי/,
  /(ת|לה)סיר(ו)? אותי/, /הסיר(ו)? אותי/, /(ת|לה)וריד(ו)? אותי/, /להוריד אותי/, /הסר(ה)? (מ|מה)(רשימה|רשימת|דיוור|תפוצה)/,
  /לא (רוצה|מעוניין|מעוניינת) (לקבל|יותר) (הודעות|דיוור|פרסומות)/, /stop (sending|texting|messaging)/, /unsubscribe/, /remove me/, /delete me/, /opt ?out/, /take me off/,
];
const WRONG_PERSON = [
  /מספר (שגוי|לא נכון|טעות)/, /טעות (ב)?מספר/, /(הגעת(ם)?|התקשרת(ם)?|שלחת(ם)?) (ל)?מספר (ה)?(לא נכון|שגוי)/, /זה לא (ה)?מספר (של|שלו|שלה)/,
  /(זו|זה|יש) טעות,? (אני|זה) לא (ה)?(אדם|בן אדם|מי|האיש|האישה)/, /אני לא (ה)?(אדם|בן אדם|מי) ש(אתם|את|אתה) (מחפש|מחפשים|מחפשת)/,
  /לא (אני|המספר שלי),? (טעית|טעיתם)/, /wrong number/, /wrong person/, /not the person/, /you have the wrong/, /this is not [a-z]+'?s? (number|phone)/,
];
// Weak signals: only these, without a clear request → a person decides. ("טעות" alone is weak; "טעות ב…" about
// something else is not a signal at all.)
const WEAK = [/^זו טעות\.?$/, /^טעות\.?!?$/, /^זה טעות\.?$/, /לא מעוניי/, /מספיק(\s|$|!)/, /למה (אתם|את|אתה) (שולח|שולחים|מתקשר|מתקשרים)/, /מי (אתם|זה)\?/, /איך (מסירים|מסיר|אני מוסר|מבטלים)/, /not interested/, /leave me alone/, /who is this/, /^stop\b.+/];
const TOPICAL_MISTAKE = /טעות (ב|של|קטנה|בחשבון|בהזמנה|במחיר|בסכום|בתאריך|בשעה|בכתובת|בשם)/;

export function classifyContactRequest(text: string | null | undefined): ContactRequest {
  const t = normalizeText(text ?? "");
  if (!t) return { kind: "none", matched: null };
  const bare = t.replace(/[.!?,]+$/u, "").trim();
  if (EXACT_UNSUBSCRIBE.has(bare)) return { kind: "unsubscribe", matched: bare };
  if (NEGATED.some((r) => r.test(t))) return { kind: "none", matched: null };
  const hit = (list: RegExp[]) => { for (const r of list) { const m = t.match(r); if (m) return m[0]; } return null; };
  const wrong = hit(WRONG_PERSON);
  if (wrong) return { kind: "wrong_person", matched: wrong };
  const dnc = hit(DO_NOT_CALL);
  if (dnc) return { kind: "do_not_call", matched: dnc };
  const unsub = hit(UNSUBSCRIBE);
  if (unsub) return { kind: "unsubscribe", matched: unsub };
  if (TOPICAL_MISTAKE.test(t)) return { kind: "none", matched: null };
  const weak = hit(WEAK);
  if (weak) return { kind: "unclear", matched: weak };
  return { kind: "none", matched: null };
}

export const REQUEST_LABEL: Record<Exclude<ContactRequestKind, "none">, string> = {
  unsubscribe: "ביקש/ה הסרה", do_not_call: "ביקש/ה שלא להתקשר", wrong_person: "מספר שגוי / לא האדם הנכון", unclear: "בקשה לא ברורה – ממתינה לבירור",
};
