# מטריצת יכולות – UltraCRM

מקורות: `dialer@14922332` (מכיל `main@3780347e`), `solinainbox@03e0b261`. סטטוסים: **ממומש ונבדק** (אוטומטית/דפדפן), **ממומש – הדמיה** (הקוד מלא, הספק החי טרם אומת), **חלקי**, **חסר**, **לא ממומש במקור**.

## תשתית SaaS (חדש)

| יכולת | מיקום | מצב | ראיות |
|---|---|---|---|
| התחברות אחת לכל העסקים (Account ↔ User/חברות, תפקידים owner/manager/agent) | `src/lib/auth.ts`, `/api/auth/*` | ממומש ונבדק | smoke §1–2, browser B1/B13/B14 |
| הקשר עסק מאומת + הרחבת Prisma שמסננת כל מודל עסקי; מודלי CRM/דיוור מסרבים לרוץ ללא הקשר | `src/lib/tenant.ts`, `src/lib/db.ts` | ממומש ונבדק | `tests/integration/tenant-isolation.test.ts`, smoke §6 (מזהה עסק מזויף בגוף הבקשה מתעלם) |
| מודולים ומכסות לפי חבילה (Plan / Business.modules / UsageCounter), אכיפה בשרת | `src/lib/modules.ts`, `withAuth({ module })` | ממומש ונבדק | smoke §6 (`module_disabled`), browser B14 (עסק Starter ללא טלפוניה) |
| Audit Log לפעולות ניהול ושינויים רגישים | `audit_logs` | ממומש | הגדרות → היסטוריית שינויים |
| חוזה אירועים + outbox + מטפלים אידמפוטנטיים | `src/lib/events/*`, `domain_events`, `automation_jobs` | ממומש ונבדק | `tests/integration/events.test.ts` |
| הסרה גלובלית מכל הדיוור (כל המזהים, כל הערוצים, בדיקה ב-worker, ייבוא לא מבטל, חזרה עם תיעוד) | `src/lib/suppression.ts`, `suppressions` | ממומש ונבדק | `tests/integration/suppression.test.ts`, smoke §9, browser B11 |

## ליבת CRM (חדש)

| יכולת | מיקום | מצב |
|---|---|---|
| אנשי קשר: שם, טלפון ראשי + נוספים, אימיילים, תגיות, מקור, שדות מותאמים, הסכמה | `/api/contacts*`, `/contacts` | ממומש ונבדק |
| נרמול טלפון (E.164) + כפילויות: חסימה לפי טלפון, זיהוי לפי אימייל/שם ללא מיזוג אוטומטי | `src/lib/crm/contacts.ts`, `/contacts/duplicates` | ממומש ונבדק (`identity.test.ts`) |
| לידים (סטטוס, נציג, המרה לעסקה) | `/api/leads*`, `/leads` | ממומש ונבדק (browser B5/B12) |
| עסקאות (שלב, סכום, סטטוס) | `/api/deals*`, `/deals` | ממומש ונבדק |
| משימות מאוחדות (חזרות חייגן + מעקבי דיוור + todo) | `/api/tasks*`, `/tasks` | ממומש ונבדק |
| הערות, ציר פעילות משותף (שיחות, הודעות, הערות, משימות, לידים, עסקאות, אירועים) | `/api/contacts/:id/timeline` | ממומש ונבדק (browser B9/B10) |
| חיוג ושליחת WhatsApp מכרטיס הלקוח | `/contacts/[id]` | ממומש ונבדק (browser B6/B10) |
| דשבורד חוצה מודולים | `/dashboard` | ממומש |

## השלמת WhatsApp – מטריצת 199 הדרישות (ענף feat/whatsapp-completion)

ראו `docs/WHATSAPP_COMPLETION.md` ו-`docs/qa/whatsapp-requirements-matrix.md` (125 מומש ונבדק / 65 חלקי / 0 חסר / 9 חסום ל-Meta חי).

| יכולת | מיקום | מצב |
|---|---|---|
| סיווג שגיאות Meta, retry אוטומטי עם backoff (retryable בלבד, requestKey לכל ניסיון), UNKNOWN לעולם לא אוטומטי, retry ידני מבוקר | `src/lib/meta/errors.ts`, `src/jobs/campaign-runner.ts`, `campaign-service.retryRecipient` | ממומש ונבדק (אינטגרציה + דפדפן W6) |
| תבניות עם כותרת מדיה וכפתורים, PAUSED/DISABLED, משתנים עם ברירות מחדל ושדות מותאמים, מדיה/כפתורים בקמפיין, preflight snapshot | `template-sync-service.ts`, `meta-whatsapp-provider.ts`, `src/lib/campaigns.ts` | ממומש ונבדק (סימולציה; לא מול Meta חי) |
| שליחת בדיקה רק ל-allowlist של החיבור, מחיר ידני לשיחה, cron בריאות חיבור יומי, לדג׳ר סטטוסים + סיבות כשל | `embedded-signup-service.ts`, `/api/jobs/whatsapp-health`, `message-status-service.ts` | ממומש ונבדק |
| מיזוג כפילויות עם שמירת כל הקשרים והסכמה מחמירה | `src/lib/crm/contacts.ts#mergeContacts`, `/contacts/duplicates` | ממומש ונבדק |
| רצפים: טריגר ליד חדש / שינוי סטטוס, שלב משימה, תנאי שלב; אוטומציות: משימה / שדה מותאם / מחוץ לשעות | `sequence-service.ts`, `automation-service.ts` | ממומש (ליד חדש/משימה/תנאים נבדקו; סטטוס ליד ומחוץ לשעות – ללא בדיקה אוטומטית) |
| מדיניות שמירה (הודעות/audit), magic bytes, קישורי קליקים חתומים באימייל, ייצוא CSV נמענים, סינוני inbox, תשובות שמורות, אנליטיקה לפי טווח ומספר | `/api/jobs/retention`, `src/lib/media.ts`, `src/app/r/[token]`, … | ממומש ונבדק |

## דיוור (מ-solinainbox)

| יכולת | מיקום ב-UltraCRM | מצב |
|---|---|---|
| WhatsApp Meta Cloud API: שליחה/קבלה, מדיה, סטטוסי מסירה, חתימות | `src/server/providers/meta-whatsapp-provider.ts`, `/api/webhooks/whatsapp` | ממומש – הדמיה (Meta חי טרם אומת; mock provider נבדק) |
| "חבר WhatsApp" – Meta Embedded Signup: state/CSRF, החלפת code בשרת, `debug_token`, אימות נכסים, `subscribed_apps`, `register`, מצבים אמיתיים, בדוק/חבר מחדש/נתק, PIN, בדיקת שליחה, `account_update` → revoked | `/settings/whatsapp`, `/api/whatsapp/signup/*`, `/api/whatsapp/connection*`, `src/server/services/embedded-signup-service.ts` | ממומש – הדמיה (20 בדיקות אינטגרציה מול Graph מזויף + QA דפדפן); מול Meta חי חסום עד קבלת App ID / Config ID (ראו `docs/WHATSAPP_EMBEDDED_SIGNUP.md`) |
| Coexistence (מספר שכבר ב-WhatsApp Business App) | – | לא ממומש ולא מובטח – מתועד בלבד |
| SMS מרקטינג: ספק Telnyx/הדמיה, תבניות עם משתנים וספירת מקטעים (GSM-7/UCS-2), קמפיינים, אומדן עלות, שולח מאושר, תזמון, חלון/קצב, סטטוסים, תשובות, הסרה בהודעה | `src/server/channels/sms`, `/settings/sms`, `/templates?channel=sms`, `/campaigns` | ממומש – הדמיה (Telnyx חי חסום עד קבלת חשבון); 11 בדיקות אינטגרציה + 12 יחידה |
| אימייל מרקטינג: ספק Resend/הדמיה, שולח/Reply-To, דומיין + SPF/DKIM/DMARC (הצגה בלבד), עורך בלוקים RTL, נושא/preheader/משתנים, טקסט פשוט, קישור הסרה גלובלי ללא התחברות + one-click, bounces/תלונות, פתיחות/הקלקות כאותות | `src/server/channels/email`, `/settings/email`, `/templates?channel=email`, `/u/[token]` | ממומש – הדמיה (Resend חי חסום עד קבלת חשבון ואימות דומיין) |
| הסרה גלובלית בין ערוצים: מקור אמת אחד, עצירת תור/רצפים, בדיקה חוזרת ב-worker, בקשות לא ברורות לבדיקה, אין ביטול ע"י ייבוא/החלפת ספק | `src/lib/suppression.ts`, `/api/unsubscribe`, `/api/suppressions/[id]/review` | ממומש ונבדק (שלושת הכיוונים) |
| רצפים בין ערוצים (WhatsApp נכשל → המתנה → SMS), תנאי עצירה (תשובה/המרה/הסרה), מניעת כפילויות | `src/server/services/sequence-service.ts`, מסך אוטומציות | ממומש – הדמיה; מעבר על בסיס "אימייל לא נפתח" לא נתמך בכוונה |
| סנכרון רשימת חסימה לספקים | – | לא נתמך ב-Telnyx/Resend (אין API); החסימה המקומית קובעת |
| תיבת שיחות, שיוך נציג, תגיות, הערות פנימיות, טיוטות, קבצים | `/inbox`, `/api/conversations/*` | ממומש ונבדק (browser B10) |
| תבניות: סנכרון/הגשה ל-Meta, תצוגה מקדימה | `/templates`, `/api/templates*` | ממומש (Meta חי חסום) |
| קמפיינים, רשימות תפוצה, קהלים דינמיים, preflight, worker עם נעילה | `/campaigns`, `/api/campaigns*`, `/api/jobs/campaigns` | ממומש ונבדק (unit + integration) |
| אוטומציות דיוור (טריגרים/פעולות/השהיה) | `/automations`, `/api/jobs/automations` | ממומש (unit) |
| אנליטיקה | `/analytics` | ממומש |
| סימולטור הודעה נכנסת (דמו) | `/settings/demo-simulator` | ממומש ונבדק |
| מספרי WhatsApp מרובים לצוותים | `provider_credentials.teamId` | ממומש |
| SMS / אימייל | – | **לא ממומש במקור** – מוצג כ"לא ממומש"; ההסרה הגלובלית כבר מכסה אותם |
| Supabase Realtime | – | הוסר (גם במקור הוחלף ב-polling מאומת) |
| ניהול משתמשים/צוותים של הדיוור | הוחלף במסך המשתמשים המאוחד | ממומש |

## טלפוניה (מ-dialer)

| יכולת | מצב |
|---|---|
| חיוג ידני / Preview / Power, תור לידים אטומי, תעדוף שקוף, חלונות חיוג, DNC, ניסיונות | ממומש ונבדק (browser B6–B9, integration events) – הדמיה; Telnyx חי חסום |
| שיחות נכנסות: זיהוי לפי טלפון (כולל טלפונים נוספים של איש הקשר), ניתוב, משימת חזרה | ממומש – הדמיה (`identity.test.ts`) |
| האזנה/לחישה למנהל, מסך מוקד בזמן אמת, דוחות | ממומש – הדמיה (הועבר ללא שינוי לוגי) |
| הקלטות + מדיניות שמירה (cron) | ממומש – חסום לבדיקה חיה |
| מספרים יוצאים מורשים לעסק | ממומש |
| ניהול מספרים יוצאים: חיבור ספק (Telnyx/הדמיה) עם בדיקה אמיתית, סנכרון מלאי, רכישה עם אישור מפורש ובירור ללא חיוב כפול, מדיניות רוטציה לקמפיין (קבוע/נציג/round-robin/עומס), הצמדה לליד, מגבלות ומקביליות, ניתוב חוזרות, מוניטין (Truecaller: אינו נתמך – ידני בלבד) | `/numbers`, `src/lib/numbers/*`, `/api/numbers`, `/api/jobs/numbers` | ממומש – הדמיה (15 בדיקות אינטגרציה + QA דפדפן); Telnyx חי חסום עד חשבון QA; Zadarma לא מומש (ראו `docs/NUMBER_MANAGEMENT.md`) |
| Predictive / IVR / תא קולי / AI | לא ממומש במקור |

## יכולות שהשתנו במיקום

- משתמשים וצוותים: מסך אחד בהגדרות (במקום שניים).
- הערות פנימיות של הדיוור נשמרות בטבלת `notes` המשותפת ומופיעות גם בכרטיס הלקוח.
- משימות מעקב של הדיוור הן משימות CRM (`tasks`) עם `conversationId`.
- ההסרה מדיוור (`OPTED_OUT`) עוברת דרך `suppressions`; עורך ההסכמה בכרטיס דורש אסמכתה לחזרה.
- תפקיד `ADMIN`/`admin` הפך ל-`owner`.
