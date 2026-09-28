/** Product gaps are different from missing credentials, permissions or an ambiguous request. */
export const UNSUPPORTED_REQUEST = "הפעולה הזו עדיין אינה נתמכת במערכת ודורשת פיתוח. לא נשמר חוק ולא הופעלה פעולה.";
export function knownProductGap(text: string): string | null {
  if (/(פייסבוק|facebook|meta ads)/i.test(text) && /(מודע|ads|תקציב|קמפיין)/i.test(text)) return "חיבור ל־Facebook Ads והצגת/ניהול מודעות";
  if (/(לחייב|תחייב|חייב את|סליקה|קישור תשלום|החזר כספי|זכה את)/.test(text)) return "ביצוע תשלום או החזר באמצעות ספק סליקה";
  if (/(צרף|תצרף|ועידה|העבר).*(שיחה)/.test(text) && /(מומחה|שותף|בן זוג|נציג אחר)/.test(text)) return "צירוף משתתף או העברה חיה של שיחת טלפון";
  return null;
}
