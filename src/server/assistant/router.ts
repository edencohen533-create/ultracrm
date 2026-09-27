/**
 * Deterministic Hebrew intent router (works without an AI key, and is the fallback when the model fails).
 * Understands the supported questions and follow-ups ("ורק של דנה?", "ומה היה אתמול?") using the link's memory.
 */
import type { PeriodKey } from "./periods";

export type Intent = "snapshot" | "sales" | "leads" | "agents" | "top_agent" | "calls" | "untreated" | "overdue" | "compare" | "contact" | "focus" | "help";
export interface Parsed { intent: Intent | null; period: PeriodKey | null; agentName: string | null; contactQuery: string | null; followUp: boolean; olderThanMinutes: number | null }

export function detectPeriod(t: string): PeriodKey | null {
  if (/שלשום/.test(t)) return null;
  if (/אתמול/.test(t)) return "yesterday";
  if (/(שבוע שעבר|שבוע (ה)?קודם)/.test(t)) return "last_week";
  if (/(חודש שעבר|חודש (ה)?קודם)/.test(t)) return "last_month";
  if (/(7|שבעה|שבוע) (ה)?ימים|שבוע האחרון/.test(t)) return "last_7_days";
  if (/30 (יום|ימים)|חודש האחרון/.test(t)) return "last_30_days";
  if (/השבוע/.test(t)) return "this_week";
  if (/החודש/.test(t)) return "this_month";
  if (/היום|עכשיו/.test(t)) return "today";
  return null;
}

export function parse(text: string, agentNames: string[]): Parsed {
  const t = text.replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
  const followUp = /^ו/.test(t) && t.split(" ").length <= 5;
  const period = detectPeriod(t);
  // agent: "של דנה" / "רק דנה" / any known first/full name in the text
  let agentName: string | null = null;
  for (const full of agentNames) { const first = full.split(" ")[0]; if (t.includes(full) || new RegExp(`(^|[\\sו])(של |ל|רק )?${first}(\\s|$)`).test(t)) { agentName = t.includes(full) ? full : first; break; } }
  const contactMatch = t.match(/(?:סיכום (?:של |על )?(?:ה)?לקוח(?:ה)?|סיכום של|סיכום על|מה עם הלקוח(?:ה)?|לקוח(?:ה)?)\s+(.{2,40})$/);
  const contactQuery = contactMatch ? contactMatch[1].replace(/^(של|על)\s+/, "").trim() : null;
  const olderMatch = t.match(/(?:מעל|יותר מ|יותר מ-)\s*(\d+)\s*(דקות|שעות|שעה|ימים|יום)/);
  const olderThanMinutes = olderMatch ? Number(olderMatch[1]) * (/שע/.test(olderMatch[2]) ? 60 : /(יום|ימים)/.test(olderMatch[2]) ? 1440 : 1) : null;
  let intent: Intent | null = null;
  if (/^(עזרה|help|מה אתה יודע|מה אפשר לשאול|תפריט)$/.test(t)) intent = "help";
  else if (/(תשווה|השווה|לעומת|השוואה)/.test(t)) intent = "compare";
  else if (/(להתמקד|המלצה|ממליץ|כדאי לי|מה לעשות היום|סדר עדיפויות)/.test(t)) intent = "focus";
  else if (/(לא קיבלו טיפול|ללא טיפול|לא טופלו|לא טיפלו|בלי טיפול|לא טופל|ממתינים)/.test(t)) intent = "untreated";
  else if (/(באיחור|משימות|משימה|מעקב)/.test(t)) intent = "overdue";
  else if (contactQuery) intent = "contact";
  else if (/(מי (ה)?נציג|מי מכר|מי סגר|הכי הרבה|המוביל)/.test(t)) intent = "top_agent";
  else if (/(כל נציג|לפי נציג|הנציגים|כל הנציגים|אחוז (ה)?סגירה של)/.test(t)) intent = "agents";
  else if (/(שיחות|שיחה|חייג|חיוג|נענו|משך)/.test(t)) intent = "calls";
  else if (/(לידים|ליד|נכנסו|פניות)/.test(t)) intent = "leads";
  else if (/(מכר|מכירות|הכנסות|הכנסה|עסקאות|עסקה|סגרנו|כסף|הכנסנו)/.test(t)) intent = "sales";
  else if (/(איך הולך|מה המצב|תמונת מצב|סיכום|דוח|מה קורה|עדכון)/.test(t)) intent = "snapshot";
  return { intent, period, agentName, contactQuery, followUp: followUp && !intent, olderThanMinutes };
}
