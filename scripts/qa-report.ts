/**
 * Merge qa-results-api.json + qa-results-ui.json into QA_REPORT.md (Hebrew matrix).
 */
import fs from "node:fs";

interface Row { id: string; area: string; scenario: string; expected: string; actual: string; status: string; evidence: string; mode: string }
const read = (f: string): Row[] => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).rows : []);
// Later files override earlier rows with the same id (re-runs of a subset after fixes).
const merge = (files: string[]) => { const m = new Map<string, Row>(); for (const f of files) for (const r of read(f)) m.set(r.id, r); return [...m.values()]; };
const apiFiles = (process.env.QA_API_FILES ?? "qa-results-api.json").split(",");
const api = merge(apiFiles);
const ui = merge(["qa-results-ui.json", "qa-results-ui-subset.json"]);
const all = [...api, ...ui];
const count = (s: string) => all.filter((r) => r.status === s).length;
const esc = (s: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const shortEvidence = (e: string) => (e ?? "").replace(/^\/private\/tmp\/[^ ]*\/shots\//, "shots/");

const areas = [...new Set(all.map((r) => r.area))];
let md = `# דוח QA – חייגן ותותח שיחות\n\n`;
md += `תאריך: ${new Date().toISOString().slice(0, 10)} · סביבה: dev מקומי + Neon (schema dialer) · ספק טלפוניה: **הדמיה (mock)** – כל תרחישי הטלפוניה החיה מסומנים "חסום לבדיקה".\n\n`;
md += `| סה״כ | עבר | נכשל | חסר במימוש | חסום לבדיקה |\n|---|---|---|---|---|\n| ${all.length} | ${count("עבר")} | ${count("נכשל")} | ${count("חסר במימוש")} | ${count("חסום לבדיקה")} |\n\n`;
md += `## ממצאים ותיקונים במהלך ה-QA

באגים אמיתיים שנמצאו ותוקנו (כולם אומתו בבדיקה חוזרת):

1. **SQL גולמי לא מוסמך לסכמה** – שאילתות \`FOR UPDATE SKIP LOCKED\` ונעילת שיחה נכשלו על Neon עם \`schema=dialer\` (\`relation "calls" does not exist\`). תוקן ב-\`src/lib/db.ts\` (\`dbSchema()\`) + \`queue.ts\` + \`events.ts\`.
2. **אירוע ספק שנרשם אך לא עובד עד הסוף נחשב "כפול" לנצח** – כעת אירוע ללא \`processedAt\` מעובד מחדש (\`events.ts\`).
3. **החלפת רשימה בזמן סשן השאירה ליד נעול** עד פקיעת ה-TTL – \`startSession\` משחרר ליד מוחזק לפני החלפה (W7).
4. **מצב לקוח מיושן אחרי \`refresh()\`** – \`stateRef\` התעדכן רק ב-effect, ולכן Preview לא משך ליד ותהליכי המשך קראו מצב ישן (U8/U9).
5. **תשובות poll שמגיעות בסדר הפוך דרסו מצב חדש** – נוסף מונה רצף ל-\`refresh\` וניקוי דגל "הסשן בלשונית אחרת" כשאין סשן (U9).
6. **חלון חיוג קצר מדקה לא נמצא בסריקה** – \`nextDialWindowOpening\` סורק בדקות במקום ב-15 דקות (L3).
7. **הודעת DNC לליד שנחסם אחרי הקצאה** – הבדיקה מתבצעת לפני בדיקת הנעילה כדי להחזיר \`dnc_blocked\` ולא \`lock_lost\` (P4).

הערות תכנוניות שלא שונו: נוכחות הנציג מוצגת "בשיחה" כבר משלב החיוג (לא רק ממענה) – מוגדר במכוון; ההערות נשמרות אחרי trim של רווחים בקצוות.

מה **לא** נבדק (חסום – אין חשבון Telnyx ומספר בדיקה מאושר): אודיו דו-כיווני, השתקה אמיתית, DTMF מול IVR, החלפת התקן באמצע שיחה, ניתוק רשת אמיתי במהלך שיחה, timeout מול הספק ו-retry עם אותו \`command_id\`, הורדת הקלטה אמיתית. כל שכבת האירועים נבדקה מול סימולציה ומול Webhooks חתומים ב-Ed25519 עם מפתח בדיקה מקומי.

`;
md += `הפרדה: עמודת "אופן" – \`mock\` = נבדק מול סימולציה בצד השרת (אותו קוד מכונת-מצבים, ללא אודיו); \`n/a\` = בדיקה שאינה תלויה בספק.\n\n`;
for (const a of areas) {
  md += `## ${a}\n\n| מזהה | תרחיש | צפוי | בפועל | סטטוס | אופן | ראיה |\n|---|---|---|---|---|---|---|\n`;
  for (const r of all.filter((r) => r.area === a)) md += `| ${r.id} | ${esc(r.scenario)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.status} | ${r.mode} | ${esc(shortEvidence(r.evidence))} |\n`;
  md += "\n";
}
fs.writeFileSync("QA_REPORT.md", md);
console.log(`QA_REPORT.md written: ${all.length} rows`);
