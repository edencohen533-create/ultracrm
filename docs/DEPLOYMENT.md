# הפעלה, פריסה וחיבורים חיצוניים – UltraCRM

## הרצה מקומית

```bash
npm install
cp .env.example .env          # מלא DATABASE_URL / DATABASE_URL_UNPOOLED / JWT_SECRET / CRON_SECRET
npx prisma migrate deploy      # יוצר את הסכמה במסד חדש ומבודד (לעולם לא במסדי המקור)
npm run db:seed                # נתוני דמו מסומנים ([דמו]) – שני עסקים, משתמשים, אנשי קשר, תבניות
npm run dev                    # http://localhost:3000
```

משתמשי דמו (סיסמה לכולם `Demo1234!`): `owner@demo.local` (בעלים של demo-a + נציג ב-demo-b), `manager@demo.local`, `agent1@demo.local`, `agent2@demo.local`, `owner-b@demo.local`.

בדיקות: `npm run typecheck` · `npm run lint` · `npm test` (יחידה) · `npm run test:integration` (מול המסד ב-.env, יוצר עסקי `test-*` ומוחק אותם) · `BASE_URL=http://localhost:3000 node scripts/qa-browser.mjs` (Playwright, מול שרת רץ).

## משתני סביבה

| משתנה | משותף / ייעודי | תיאור |
|---|---|---|
| `DATABASE_URL` | משותף | חיבור pooled ל-PostgreSQL של UltraCRM (**מסד נפרד**; לא `dialer`, לא `solinainbox`). |
| `DATABASE_URL_UNPOOLED` | משותף | חיבור ישיר ל-`prisma migrate`. |
| `QUICK_LOGIN_EMAIL` + `NEXT_PUBLIC_QUICK_LOGIN=1` | **זמני** | כפתור "כניסה מהירה" במסך הכניסה שמחבר את החשבון הנתון ללא סיסמה (בקשת המשתמש 25.9.2026). **כל מי שמגיע לכתובת נכנס כבעלים** – להסיר את שני המשתנים ולפרוס מחדש כשכבר לא נדרש. |
| `DB_RLS` | משותף | ברירת מחדל פעיל. `off` מכבה את מעטפת ה-RLS (רק למסד שהמיגרציה `20260925090000_rls_session_version` טרם הוחלה עליו). |
| `DATABASE_POOL_MAX` | משותף | חיבורים לכל instance (ברירת מחדל 10). |
| `JWT_SECRET` | משותף | חתימת עוגיית הסשן (`ultracrm_session`, HS256, 12 שעות). |
| `CRON_SECRET` | משותף | `Authorization: Bearer` לנתיבי `/api/jobs/*`. Vercel Cron שולח אוטומטית. |
| `NEXT_PUBLIC_APP_URL` | משותף | כתובת האפליקציה (מוצגת במסכי ההגדרות ליצירת כתובות Webhook). |
| `TELEPHONY_PROVIDER` | טלפוניה | `mock` (הדמיה מסומנת) או `telnyx`. |
| `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CALL_CONTROL_APP_ID`, `TELNYX_CREDENTIAL_CONNECTION_ID` | טלפוניה | חשבון Telnyx אחד לכל הפריסה (ראו "מגבלות"). |
| WhatsApp (Embedded Signup) | דיוור | `META_APP_ID`, `META_APP_SECRET` (שרת בלבד), `META_ES_CONFIG_ID`, `META_GRAPH_VERSION`, `META_WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY` – ראו `docs/WHATSAPP_EMBEDDED_SIGNUP.md`. הלקוח מחבר את חשבונו בלחיצה על "חבר WhatsApp"; ה-token נשמר מוצפן ב-`provider_credentials`. חסר משתנה → הכרטיס מציג "חסרה הגדרה" והכפתור מושבת. |
| ניהול מספרים יוצאים | טלפוניה | `TELNYX_NUMBERS_BUSINESS_ID` (העסק היחיד המורשה), `NUMBER_PURCHASES_ENABLED=false`, אופציונלי `NUMBER_PROVIDER=mock` להדמיה. cron יומי `/api/jobs/numbers`. ראו `docs/NUMBER_MANAGEMENT.md`. |
| SMS (Telnyx) / אימייל (Resend) | דיוור | **אין משתני סביבה** – API Key, Messaging Profile, Public Key / Webhook Secret, שולח ודומיין נשמרים לכל עסק מוצפנים (`ENCRYPTION_KEY`) דרך הגדרות → חיבורים → SMS / אימייל. ראו `docs/MULTICHANNEL_MARKETING.md`. |
| WhatsApp (חיבור ידני) | דיוור | ללא משתנים – Access Token / Phone Number ID / App Secret / Verify Token לכל עסק (בעל העסק בלבד, "חיבור ידני מתקדם"). |

סודות לעולם אינם נשלחים לדפדפן: מסך ההגדרות מציג Token ממוסך בלבד; Telnyx נגיש רק מצד השרת; אסימון WebRTC של הנציג הוא JWT קצר-מועד שנוצר בשרת.

## Webhooks וכתובות חיצוניות

| שירות | כתובת | אימות | הערות |
|---|---|---|---|
| Telnyx Call Control | `POST https://<domain>/api/webhooks/telnyx` | חתימת Ed25519 (`TELNYX_PUBLIC_KEY`) + חלון זמן 5 דקות | אירועים כפולים/בסדר שגוי מטופלים (מזהה אירוע ייחודי, מכונת מצבים קדימה בלבד). |
| Meta WhatsApp Cloud API | `GET/POST https://<domain>/api/webhooks/whatsapp` | `hub.verify_token` = `META_WEBHOOK_VERIFY_TOKEN`; `X-Hub-Signature-256` עם App Secret של האפליקציה (נפילה לאחור: App Secret של חיבור ידני) | הודעות מנותבות לפי `phone_number_id` (ייחודי גלובלית), אירועי חשבון (`account_update`…) לפי `waba_id`; כל החתימות נבדקות לפני כל גישה לנתוני עסק. שדות לרישום: messages, account_update, account_review_update, phone_number_quality_update, phone_number_name_update, business_capability_update. |
| Vercel Cron | `/api/jobs/events` (כל דקה), `/api/jobs/campaigns` (כל דקה), `/api/jobs/automations` (כל 2 דקות), `/api/jobs/retention` (יומי – הקלטות + מדיניות שמירת הודעות/audit לפי הגדרות העסק), `/api/jobs/numbers` (יומי), `/api/jobs/whatsapp-health` (יומי 03:15 – בדיקת חיבורי Meta פעילים) | `CRON_SECRET` | מוגדר ב-`vercel.json`. ניתן להפעיל מכל מתזמן חיצוני. |

| Telnyx Messaging (SMS) | `POST https://<domain>/api/webhooks/sms/telnyx/<credentialId>` | Ed25519 (`telnyx-signature-ed25519` + `telnyx-timestamp`) עם המפתח הציבורי של העסק | ה-credentialId בכתובת בוחר את מפתח האימות של עסק אחד; אירועים כפולים נדחים לפי `provider+eventId`. |
| Resend (אימייל) | `POST https://<domain>/api/webhooks/email/resend/<credentialId>` | Svix (`svix-id`, `svix-timestamp`, `svix-signature`) עם ה-signing secret של העסק | כנ"ל; bounces/תלונות מזינים את ההסרה הגלובלית. |

**אין לשנות** את ה-Webhooks של המערכות המקוריות (dialer / solinainbox); UltraCRM דורש רישום כתובות חדשות בחשבונות Telnyx ו-Meta של סביבת הבדיקה.

## התאמת סביבת האירוח

**פרוס בייצור (2026-09-25):** https://ultracrm-eta.vercel.app – פרויקט Vercel `ultracrm`, ענף `feat/whatsapp-completion`, מסד Neon `ultracrm` (מיגרציות RLS הוחלו), ספקי טלפוניה/מספרים/WhatsApp במצב הדמיה (אין מפתחות Telnyx/Meta ב-Vercel). משתמשי הדמו מהזריעה (Demo1234!) עדיין פעילים – יש להחליף לפני שימוש אמיתי. הפריסה היא Vercel (serverless). התאמה:

- **חיבורים מתמשכים**: החיבור הקולי המתמשך היחיד הוא WebRTC בין דפדפן הנציג ל-Telnyx; השרת אינו מחזיק sockets. מצב שיחה/תיבה מתעדכן ב-polling מאומת (1.2–6 שניות בחייגן, 5 שניות בתיבה) – אין Supabase Realtime ואין SSE.
- **בידוד דיירים בשלוש שכבות**: הקשר עסק בשרת (AsyncLocalStorage) → סינון Prisma אוטומטי → **Row-Level Security ב-PostgreSQL**: כל statement בתוך הקשר עסק רץ כתפקיד `ultracrm_runtime` (ללא BYPASSRLS) עם `app.business_id` שנקבע transaction-locally (`src/lib/db-rls.ts`), ולכן בטוח גם דרך ה-pooler של Neon. קוד ללא הקשר (login, ניתוב webhook, cron) רץ כבעל החיבור. **כל טבלה חדשה עם `business_id` (או טבלת-ילד) חייבת policy במיגרציה שלה** – ראו `prisma/migrations/20260925090000_rls_session_version/migration.sql`. קריאות זהות חוצות-עסקים (בדיקת ייחודיות גלובלית של מספר, חברות בעסקים אחרים) עוברות דרך `withoutBusiness`. **דרישות**: `DATABASE_URL` ו-`DATABASE_URL_UNPOOLED` חייבים להשתמש באותו משתמש PostgreSQL (המיגרציה מעניקה את התפקיד ל-`CURRENT_USER`; משתמש אחר יקבל `permission denied to set role`) – הבדיקה `tests/integration/rls.test.ts` מאמתת חברות בתפקיד. עלות: statement בודד בתוך הקשר עסק = 3 סבבים (BEGIN+setup, השאילתה, COMMIT); ב-fra1 מול Neon eu-central-1 זה מילישניות בודדות לשאילתה.
- **סשנים**: JWT ל-12 שעות + אימות מול המסד בכל בקשה (משתמש/עסק/חשבון פעילים, תפקיד עדכני, `Account.sessionVersion`). שינוי סיסמה – עצמי (`/api/auth/password`, הגדרות → החשבון שלי) או איפוס על ידי בעלים – מעלה את הגרסה ומנתק כל סשן אחר של החשבון.
- **זמן אמת**: תיבת ההודעות מתרעננת ב-polling (5 שניות) – אין Supabase Realtime/pub-sub חיצוני ב-Vercel; זהו הבדל מכוון מול solinainbox.
- **תהליכי רקע**: outbox אירועים, קמפיינים ואוטומציות מתוזמנות רצים כ-cron עם נעילות CAS במסד, ולכן בטוחים להפעלה מקבילית ולריצות קצרות (עד 60 שניות לקריאה, `maxDuration`). לאחר כל שינוי עסקי המערכת גם "מקפיצה" עיבוד אירועים ב-`after()` של Next – ה-cron הוא רשת ביטחון.
- **מגבלות**: תור חיוג Predictive, IVR ותא קולי אינם ממומשים (כמו במקור). אם נדרש worker רציף (למשל עיבוד בזמן אמת של אלפי אירועים בשנייה), יש להריץ את `/api/jobs/*` משירות worker ייעודי (Railway/Fly/Container) עם אותו `CRON_SECRET` – הקוד אינו תלוי ב-Vercel.
- **מסד נתונים**: Neon/Supabase Postgres עם pooler. חביון של ~200ms לכל שאילתה (מדידה מהסביבה המקומית לאירופה) מאט מסכים מרובי שאילתות; בפריסה באותו region החביון יורד לכמה מילישניות.

## פעולות חיצוניות שנותרו לפני הפעלה חיה

1. יצירת מסד PostgreSQL לייצור והרצת `prisma migrate deploy` (אין להריץ על מסדי המקור).
2. Telnyx: Call Control App עם ה-Webhook החדש, SIP Credential Connection, Outbound Voice Profile, מספרי E.164 של העסק, והגדרת ארבעת משתני הסביבה + `TELEPHONY_PROVIDER=telnyx`. עד אז המערכת רצה בהדמיה מסומנת.
3. Meta: אפליקציית Business עם WhatsApp + Facebook Login for Business, Configuration ל-Embedded Signup, Advanced Access לשתי ההרשאות (App Review + Business Verification), רישום Webhook לכתובת החדשה, ומילוי `META_*` בשרת. לאחר מכן כל עסק לוחץ "חבר WhatsApp" בהגדרות; סנכרון תבניות מאושרות. עד אז הדיוור רץ עם ספק mock מסומן.
4. החלפת סיסמאות הדמו (חיבור Meta מסרב לפעול כשמשתמש פעיל עדיין עם `Demo1234!`).
5. `CRON_SECRET` + `JWT_SECRET` ייצוריים ב-Vercel; אימות שה-crons פעילים (תוכנית Vercel שתומכת בתדירות דקה).
6. שיחת בדיקה למספר מאושר עם אודיו דו-כיווני והודעת WhatsApp לחשבון בדיקה – רק אז ניתן לסמן את האינטגרציה החיה כמאומתת.

## מגבלות ידועות

- אישורי Telnyx הם ברמת הפריסה (לא לכל עסק); מספרי הטלפון והזיהוי כן מופרדים לפי עסק. חיבור Telnyx נפרד לכל עסק דורש הרחבת המתאם (מפתח ו-webhook לכל חשבון).
- SMS ואימייל: אין ספק מחובר. המודל, ההסרה הגלובלית והממשק כבר מבחינים בערוצים, אך שליחה/קבלה אינן ממומשות והמסכים מציגים זאת כ"לא ממומש".
- Predictive dialing, IVR, תא קולי, תמלול/AI, סליקה – לא ממומשים (לא היו במקור).
