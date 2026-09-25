# UltraCRM

מערכת SaaS מאוחדת בעברית/RTL: **CRM** במרכז (אנשי קשר, לידים, עסקאות, משימות, ציר פעילות), ומעליו מודול **דיוור** (WhatsApp דרך Meta Cloud API, קמפיינים, תבניות, אוטומציות – מקורו ב-`solinainbox`) ומודול **טלפוניה** (חייגן, תותח שיחות, שיחות נכנסות, האזנה/לחישה – מקורו ב-`dialer`).

Next.js 16 · React 19 · TypeScript · Prisma 7 · PostgreSQL · Tailwind 4 · Telnyx (Call Control + WebRTC) · Meta WhatsApp Cloud API.

## עקרונות

- **התחברות אחת, עסקים רבים**: `Account` (אימייל+סיסמה) ↔ `User` (חברות בעסק עם תפקיד `owner` / `manager` / `agent`). הסשן נושא עסק פעיל אחד; מעבר בין עסקים בסרגל הצד.
- **הפרדת עסקים בשרת**: כל טבלה עסקית נושאת `business_id`; לקוח Prisma מסנן אוטומטית לפי העסק המאומת (`src/lib/db.ts`, `src/lib/tenant.ts`). מזהה עסק מהדפדפן לעולם אינו נאמן.
- **איש קשר אחד לכל המודולים**: הדיוור והטלפוניה מצביעים ל-`contactId`. טלפון ראשי מנורמל ייחודי לעסק, טלפונים/אימיילים נוספים, זיהוי כפילויות ללא מיזוג אוטומטי.
- **הסרה גלובלית**: בקשת הסרה מכל ערוץ חוסמת דיוור שיווקי בכל הערוצים לכל מזהי איש הקשר, נבדקת שוב ב-worker לפני הספק, ואינה מתבטלת בייבוא. "לא ליצור קשר" חוסם גם שיחות (`src/lib/suppression.ts`).
- **אירועים בין מודולים**: outbox (`domain_events`) עם מטפלים אידמפוטנטיים (`automation_jobs`): ליד חדש → שיוך + משימה; שיחה הסתיימה / תוצאה → ציר פעילות, משימת מעקב, קידום ליד, הודעת המשך (עם הסכמה וערוץ מחובר); הודעה נכנסת → ציר פעילות; הסרה → חסימה.
- **חבילות ומודולים**: `Plan` + `Business.modules` + מכסות (`usage_counters`) נאכפים בשרת ומשתקפים בתפריט. אין סליקה.

## מבנה

```
src/lib/{auth,tenant,db,modules,suppression,events}   תשתית משותפת
src/lib/crm/                                          אנשי קשר, לידים, עסקאות, משימות, ציר פעילות
src/lib/dialer, src/lib/telephony                     טלפוניה (dialer)
src/server, src/jobs                                  דיוור (solinainbox)
src/app/(app)/…                                       מעטפת אחת: דשבורד, CRM, תיבה, קמפיינים, חייגן, הגדרות
src/app/api/…                                         REST; /api/jobs/* לעבודות רקע; /api/webhooks/* לספקים
prisma/schema.prisma, prisma/migrations               סכמה מאוחדת ו-migrations למסד חדש
tests/unit, tests/integration, scripts/qa-browser.mjs בדיקות
```

## התחלה

ראו [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) להרצה מקומית, משתני סביבה, Webhooks ופעולות חיצוניות; [docs/CAPABILITIES.md](docs/CAPABILITIES.md) למטריצת היכולות; [docs/QA_REPORT.md](docs/QA_REPORT.md) לדוח הבדיקות; [UNIFICATION_PLAN.md](UNIFICATION_PLAN.md) להחלטות האיחוד.

```bash
npm install && cp .env.example .env
npx prisma migrate deploy && npm run db:seed
npm run dev
```

ללא מפתחות ספקים המערכת רצה ב**הדמיה מסומנת** (טלפוניה) ועם **ספק WhatsApp מדומה**; SMS ואימייל טרם חוברו לספק.

## דיוור רב-ערוצי (SMS / אימייל)

ספקי SMS (Telnyx) ואימייל (Resend) מחוברים לכל עסק בהגדרות → חיבורים, עם מצב הדמיה מובנה. תבניות, קמפיינים, רצפים בין ערוצים
והסרה גלובלית משותפים לשלושת הערוצים. פירוט מלא: [docs/MULTICHANNEL_MARKETING.md](docs/MULTICHANNEL_MARKETING.md).
