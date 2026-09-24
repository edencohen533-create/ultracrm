# UltraCRM – תוכנית איחוד

## מקורות (commits מקובעים)
| מאגר | Commit | הערות |
|---|---|---|
| `edencohen533-create/dialer` | `14922332ce91af608c780ce5134c1ab34fc5641d` (`qa/comprehensive-dialer-20260924`, מכיל את `main` = `3780347e`) | טלפוניה: Telnyx Call Control + WebRTC, חייגן, תור לידים, האזנה/לחישה, הקלטות. עבודה לא-מקומטת (ניהול מספרים) לא נכללה. |
| `edencohen533-create/solinainbox` | `03e0b26104951f49383b183e72d6a2012ef242af` (`main`) | דיוור: WhatsApp (Meta Cloud API + mock), תיבת שיחות, תבניות, קמפיינים, אוטומציות, קהלים. |

שני מאגרי המקור נשארים ללא שינוי. אין מיגרציה של נתוני ייצור; מסד נתונים חדש ומבודד (`ultracrm`).

## ממצאי המיפוי (תמצית)
- שתי האפליקציות: Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, Prisma, PostgreSQL, עברית/RTL, Vercel.
- **dialer**: Prisma 7 (`prisma-client` + `@prisma/adapter-pg`), אימות JWT עצמי (`jose`, cookie), `businessId` מפורש בכל טבלה, רכיבי UI עצמיים, polling 1.5s, Vercel cron. ~9.4K שורות.
- **solinainbox**: Prisma 6, NextAuth v5, ארגון (`organizationId`) + RLS + `AsyncLocalStorage`, shadcn/ui (base-ui), Vitest (43 קבצי בדיקה). ~10.4K שורות. Supabase משמש רק כ-Postgres; Realtime הוחלף ב-polling מאומת.
- **ערוצי דיוור בפועל**: WhatsApp בלבד (Meta Cloud API ממומש + mock). **SMS ואימייל אינם ממומשים באף מאגר** – יתועדו כחסרים ולא יוצגו כפעילים.
- כפילויות: אנשי קשר (שני מודלים), משתמשים/תפקידים (admin/manager/agent מול ADMIN/MANAGER/AGENT), משימות (`Task` מול `ContactTask`), הערות, Audit Log, נרמול טלפון (`libphonenumber-js` בשניהם), הרשאות צוותים.
- התנגשויות: גרסאות Prisma (6/7), מנגנון אימות, מנגנון הפרדת עסקים (RLS מול businessId), ערכות UI ו-tokens של עיצוב, שמות טבלאות (snake_case מול PascalCase).

## החלטות
1. **בסיס טכני: dialer** – Prisma 7 + adapter, אימות JWT עצמי, `businessId` מפורש. הסיבה: קוד הטלפוניה הוא הרגיש ביותר לתנאי מרוץ (`FOR UPDATE SKIP LOCKED`, נעילות ייעוץ, מכונת מצבים של אירועים) ולא כדאי להעבירו למנגנון RLS-per-transaction. הפרדת עסקים נאכפת בשרת: `businessId` מהסשן המאומת בלבד + הרחבת Prisma שמזריקה `businessId` אוטומטית לכל שאילתה של מודולי ה-CRM/דיוור (הגנה בעומק).
2. **זהות**: `Account` (התחברות גלובלית: אימייל+סיסמה) ↔ `User` (חברות בעסק: תפקיד, צוות, נוכחות, אישורי SIP). משתמש יכול להיות חבר בכמה עסקים; הסשן נושא עסק פעיל אחד. תפקידים: `owner`, `manager`, `agent`.
3. **CRM כמקור אמת לאנשי קשר**: מודל `Contact` אחד (טלפון ראשי מנורמל ייחודי לעסק, טלפונים/אימיילים נוספים, תגיות, מקור, הסכמה). דיוור וטלפוניה מצביעים ל-`contactId` ושומרים רק מזהי ספק.
4. **ליד ≠ עסקה ≠ פריט תור חיוג**: `Lead` (סטטוס+נציג), `Deal` (שלב, סכום, סטטוס), `ListLead` (פריט ברשימת חיוג – נשמר מהחייגן).
5. **משימה אחת**: `Task` מאוחד (משימות חזרה מהחייגן + משימות מעקב מהדיוור).
6. **הסרה גלובלית**: טבלת `Suppression` (מזהה/היקף/מקור/סיבה/ראיית הסכמה מחודשת) + `DncEntry` לחסימת שיחות; נבדקת בכל ערוץ לפני שליחה וגם ב-worker סמוך לפנייה לספק.
7. **אירועים**: טבלת `DomainEvent` (outbox) עם `dedupeKey` ייחודי; worker אידמפוטנטי (`AutomationJob` לכל זוג אירוע/מטפל) מופעל inline לאחר commit וגם ב-cron.
8. **UI**: מעטפת אחת (Sidebar + CallBar + DialerProvider בשכבת ה-layout כך שניווט לא מנתק שיחה). ערכת עיצוב אחת (Heebo, פלטה כהה של החייגן) שמזינה גם את רכיבי shadcn/ui שהובאו מהדיוור.
9. **רקע**: Vercel Cron (קמפיינים, אוטומציות, אירועים, שימור הקלטות). חיבורים מתמשכים: WebRTC בין הדפדפן ל-Telnyx בלבד; השרת עובד ב-polling/webhooks – מתאים ל-serverless. מתועד ב-`docs/DEPLOYMENT.md`.

## שלבי ביצוע
1. סכמה מאוחדת + migration ראשוני + seed מסומן.
2. תשתית: אימות/חברות, הרשאות, מודולים ומכסות, Audit, אירועים, הסרות.
3. ליבת CRM: אנשי קשר, לידים, עסקאות, משימות, הערות, ציר פעילות, כפילויות.
4. העברת מודול הדיוור (services/jobs/routes/UI) והתאמתו לתשתית.
5. העברת מודול הטלפוניה והתאמתו (תפקידים, אירועים, DNC↔הסרות).
6. מעטפת UI, דשבורד, הגדרות.
7. בדיקות (typecheck/lint/build/vitest/דפדפן) ותיעוד מסירה.
