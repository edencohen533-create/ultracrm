/** Product gaps are different from missing credentials, permissions or an ambiguous request. */
export const UNSUPPORTED_REQUEST = "הפעולה הזו עדיין אינה נתמכת במערכת ודורשת פיתוח. לא נשמר חוק ולא הופעלה פעולה.";
export function knownProductGap(text: string): string | null {
  if (/(פייסבוק|facebook|meta ads)/i.test(text) && /(תיצור|צור|תפרסם|פרסם|תשנה|שנה|תקציב|נהל|ניהול)/i.test(text)) return "יצירה ושינוי של מודעות או תקציבים ב־Facebook Ads";
  if (/(לחייב|תחייב|חייב את|סליקה|קישור תשלום|החזר כספי|זכה את)/.test(text)) return "ביצוע תשלום או החזר באמצעות ספק סליקה";
  if (/(צרף|תצרף|ועידה|העבר).*(שיחה)/.test(text) && /(מומחה|שותף|בן זוג|נציג אחר)/.test(text)) return "צירוף משתתף מתוך צ׳אט ה־AI; מנהל יכול להצטרף ידנית מתוך מסך ההאזנה";
  return null;
}
