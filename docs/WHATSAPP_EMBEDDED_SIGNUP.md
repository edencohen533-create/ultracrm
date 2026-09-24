# חיבור WhatsApp דרך Meta Embedded Signup

מסמך זה מתאר את התהליך שממומש ב-UltraCRM לחיבור חשבון WhatsApp Business (Cloud API) בלחיצה על
"חבר WhatsApp" בהגדרות → חיבורים → וואטסאפ, את ההגדרות הנדרשות ב-Meta, ואת מה שעדיין תלוי
באישורים מצד Meta. מבוסס על התיעוד הרשמי (Embedded Signup for Tech Providers / Solution Partners,
Graph API v25.0, ספטמבר 2026).

## 1. מפת המערכת (מה נגע בתהליך)

| שכבה | קובץ | תפקיד |
|---|---|---|
| UI | `src/components/settings/whatsapp-connect-card.tsx` | כרטיס החיבור: כפתור, טעינת FB SDK, `FB.login` עם `config_id`, האזנה ל-`message` מ-facebook.com, מצבים, פעולות (בדוק / השלם הגדרה / חבר מחדש / נתק עם אישור / בדיקת שליחה / הזנת PIN) |
| עמוד | `src/app/(app)/settings/whatsapp/page.tsx` | בעל עסק ומנהל; הטופס הידני (System User Token) נשאר כ"מתקדם" לבעל העסק |
| API | `src/app/api/whatsapp/signup/{start,complete,cancel}` | פתיחת ניסיון (state), השלמה (החלפת code בשרת), ביטול |
| API | `src/app/api/whatsapp/connection` + `/[id]` | תמונת מצב (ללא סודות); פעולות `check`, `retry_setup`, `disconnect` (דורש `confirm:true`), `test_send` |
| שירות | `src/server/services/embedded-signup-service.ts` | כל הלוגיקה מול Graph: החלפת code, `debug_token`, אימות נכסים, `subscribed_apps`, `register`, שמירה, ניתוק, בדיקת חיבור, טיפול ב-`account_update` |
| Graph | `src/lib/meta/graph.ts` | קריאות Graph (ללא לוג של tokens), משתני סביבה, הצפנה/פענוח config |
| הצפנה | `src/lib/crypto.ts` | AES-256-GCM עם `ENCRYPTION_KEY`; access token / verify token / PIN נשמרים חתומים `enc:v1:` |
| Webhook | `src/app/api/webhooks/whatsapp/route.ts` | אימות `hub.verify_token` (ברמת אפליקציה), חתימת `X-Hub-Signature-256` עם App Secret של האפליקציה (עם נפילה לאחור ל-App Secret של חיבור ידני), ניתוב הודעות לפי `phone_number_id`, ניתוב אירועי חשבון לפי `waba_id` |
| DB | `provider_credentials` (שדות `waba_id`, `status`, `connection_method`, `granted_scopes`, `subscribed_at`, `registered_at`, …) + `whatsapp_signup_sessions` | מיפוי מאומת עסק ↔ WABA ↔ מספר, ומצב תהליך |

הרשאות: כל נקודות ה-API עטופות ב-`withAuth({ minRole: "manager", module: "messaging" })` – סוכן מקבל 403 גם אם ינסה ישירות. הביצוע נעשה בתוך הקשר העסק (Tenant scope), כך שגם שאילתות ה-DB מוגבלות לעסק.

## 2. זרימת החיבור (מה קורה בפועל)

1. **start** – השרת יוצר `WhatsAppSignupSession` עם `state` אקראי (32 בתים), קשור לעסק+משתמש, תוקף 15 דק'. ניסיון פתוח נוסף באותו עסק ע"י אותו משתמש מוחזר כ-`reused` (הגנת לחיצה כפולה); ע"י משתמש אחר – 409.
   לדפדפן חוזרים רק `appId`, `configId`, `version`, `state`.
2. **דפדפן** – טוען `connect.facebook.net/en_US/sdk.js`, מריץ `FB.init({appId, version})` ואז
   `FB.login(cb, { config_id, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3" } })`.
   הודעות `window.message` מתקבלות רק אם `origin` הוא `https://*.facebook.com` ו-`type === "WA_EMBEDDED_SIGNUP"` עם מזהים מספריים בלבד.
   אירועים: `FINISH` (מזהי WABA/מספר/עסק), `CANCEL` (עם `current_step`), `ERROR`. סגירת חלון ללא code = ביטול (לא הצלחה). `status: "unknown"` ללא הודעות = חלון חסום/נסגר – מוצגת הנחיה לבטל חסימת חלונות קופצים.
3. **complete** – הדפדפן שולח `state + code + waba_id + phone_number_id` תוך שניות (ה-code תקף 30 שניות). השרת:
   - מאמת שה-state שייך לעסק+משתמש הנוכחיים, לא פג, ולא נוצל (CAS על `status`); code זהה שכבר נוצל → 409 `code_reused`.
   - `GET /oauth/access_token?client_id&client_secret&code` → business integration system user token (לא פג כברירת מחדל).
   - `GET /debug_token` עם `APP_ID|APP_SECRET`: `is_valid`, `app_id` תואם, שתי ההרשאות `whatsapp_business_management` + `whatsapp_business_messaging`, ו-`granular_scopes` כולל את ה-WABA.
   - `GET /{waba_id}`, `GET /{waba_id}/phone_numbers`, `GET /{phone_number_id}` – המספר חייב להופיע ברשימת המספרים של ה-WABA שאושר (המזהים מהחלון לא נחשבים אמינים).
   - מניעת קונפליקטים: מספר שכבר משויך לעסק אחר → 409 `phone_bound_elsewhere` (אין העברה אוטומטית); WABA אחר פעיל בעסק → 409 `waba_conflict`.
   - שמירה: token/PIN חתומים ב-DB, `status = in_progress`, `connection_method = embedded_signup`, `granted_scopes`, פרטי המספר.
   - `POST /{waba_id}/subscribed_apps` (אם לא רשום כבר) → `subscribed_at`.
   - `POST /{phone_number_id}/register { messaging_product, pin }` – PIN חדש שנוצר ונשמר חתום. אם למספר כבר יש PIN דו-שלבי (שגיאה 133 / subcode 2388093) → `needs_action` והמשתמש מזין את ה-PIN הקיים ולוחץ "השלם הגדרה".
   - כישלון בשלב subscribe/register **לא** מוחק את החיבור: המצב הופך `needs_action` עם הסיבה, ו"השלם הגדרה" מריץ מחדש רק את השלבים החסרים (אידמפוטנטי, ללא כפילויות).
4. **מצב** נגזר תמיד מעובדות (`deriveReadiness`): הרשאה אומתה, אפליקציה רשומה, מספר רשום, אימות מספר, אין חסימת שליחה.
   `connected` מוצג רק כשכל אלה מתקיימים – לעולם לא רק כי החלון נסגר. עד לבדיקת שליחה/קבלה בפועל הכרטיס מציין "טרם בוצעה בדיקת שליחה" / "טרם התקבל אירוע מ-Meta".

### מצבים בכרטיס

| מצב | מתי |
|---|---|
| לא מחובר | אין חיבור פעיל |
| חיבור בתהליך | code הוחלף ונכסים אומתו, שלבי subscribe/register רצים |
| נדרשת פעולה ב-Meta | subscribe/register נכשלו, PIN קיים, שליחה נחסמה – עם הסבר |
| מחובר – לא מוכן | חיבור שמור אך חסר תנאי מוכנות (למשל מספר לא מאומת, טרם אומתה הרשאה) |
| מחובר ופעיל | כל התנאים מתקיימים |
| ההרשאה בוטלה – נדרש חיבור מחדש | `debug_token` לא תקף / קוד 190 / `account_update` PARTNER_REMOVED / DISABLED_UPDATE |
| תקלה | שגיאה לא צפויה בבדיקה |

### ניתוק
דורש אישור בדיאלוג ו-`confirm: true` בבקשה. מפסיק שליחה מיד (`isActive=false`, ה-provider מסרב לשלוח), מבצע `DELETE /{waba_id}/subscribed_apps` רק אם אין מספר פעיל נוסף של העסק על אותו WABA, שומר את השורה, השיחות וההיסטוריה. **לא** מוחק חשבון או מספר ב-Meta. ביטול שנעשה בצד Meta מזוהה בבדיקת חיבור או דרך `account_update`.

## 3. הגדרות נדרשות ב-Meta App Dashboard

1. אפליקציה מסוג **Business** עם המוצרים **WhatsApp** ו-**Facebook Login for Business**.
2. Facebook Login for Business → Configurations → **Create configuration**: Login variation = *General*, Assets = *WhatsApp business accounts* (או *… and phone numbers*), הרשאות `whatsapp_business_management` + `whatsapp_business_messaging`. ה-**Configuration ID** הוא `META_ES_CONFIG_ID`.
3. Facebook Login for Business → Settings: **Valid OAuth Redirect URIs** ו-**Allowed Domains for the JavaScript SDK** חייבים לכלול את דומיין UltraCRM (למשל `https://crm.example.com/`). *Login with the JavaScript SDK* = Yes. HTTPS חובה (localhost עובד בפיתוח).
4. WhatsApp → Configuration → Webhook: Callback URL `https://<domain>/api/webhooks/whatsapp`, Verify token = `META_WEBHOOK_VERIFY_TOKEN`. שדות לרישום: `messages`, `account_update`, `account_review_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`. (רישום ה-WABA עצמו לאפליקציה נעשה אוטומטית ב-`subscribed_apps`.)
5. App Settings → Basic: **App ID** → `META_APP_ID`, **App Secret** → `META_APP_SECRET` (שרת בלבד). מומלץ להפעיל *Require App Secret* לקריאות שרת.
6. **App Review / Advanced Access**: לפני מעבר ל-Live, יש לבקש Advanced Access לשתי ההרשאות (נדרש Business Verification של העסק המפתח). בלי זה רק חשבונות עם תפקיד באפליקציה (Admin/Developer/Tester) יכולים להשלים את ה-Embedded Signup.
7. **Business Verification** של העסק שלכם (Tech Provider) – מרים את מגבלת ה-onboarding מ-10 ל-200 לקוחות ב-7 ימים ונדרש ל-App Review.
8. לקוח שמתחבר: אם ברצונו לשלוח הודעות מעבר לחלון החינמי, עליו להוסיף אמצעי תשלום ל-WABA שלו (Tech Provider אינו מחויב עבורו).

### משתני סביבה (ראו `.env.example`)

| משתנה | הסבר |
|---|---|
| `META_APP_ID` | App ID – נחשף לדפדפן (נדרש ל-SDK) |
| `META_APP_SECRET` | App Secret – **שרת בלבד**: החלפת code, `debug_token`, אימות חתימת webhook |
| `META_ES_CONFIG_ID` | Configuration ID של Facebook Login for Business |
| `META_GRAPH_VERSION` | גרסת Graph (ברירת מחדל `v25.0`) |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token שהוזן ב-App Dashboard |
| `ENCRYPTION_KEY` | 32 בתים hex; מצפין tokens/PIN במנוחה |
| `NEXT_PUBLIC_APP_URL` | דומיין ציבורי (מוצג ככתובת webhook בכרטיס) |

חסר משתנה → הכרטיס מציג "אינו זמין עדיין – חסרה הגדרה בשרת" ורשימת המשתנים החסרים; הכפתור מושבת. אין הדמיית הצלחה.

## 4. Webhooks

- `GET` – Meta מאמתת עם `hub.verify_token`; נענה רק כאשר הוא שווה ל-`META_WEBHOOK_VERIFY_TOKEN` (או ל-verify token של חיבור ידני קיים).
- `POST` – החתימה `X-Hub-Signature-256` מאומתת ב-HMAC-SHA256 על הגוף הגולמי עם App Secret של האפליקציה (השוואה קבועת-זמן). חתימה שגויה/חסרה → 401 ושום דבר לא נשמר.
- הודעות (`field: messages`) מנותבות לפי `metadata.phone_number_id` למיפוי השמור; הודעה נכנסת נקלטת ב-Inbox הקיים על כרטיס הלקוח (זיהוי/יצירה לפי טלפון), סטטוסי מסירה מעדכנים הודעות יוצאות, "הסר" מזין את רשימת ההשתקה הגלובלית. משלוח כפול (Meta retry) נשמר פעם אחת (`inbound_key` ייחודי).
- אירועי חשבון (`account_update` וכו') מנותבים לפי `entry.id` / `waba_info.waba_id`; `PARTNER_REMOVED`, `DISABLED_UPDATE`, `ACCOUNT_DELETED`, `PARTNER_APP_UNINSTALLED` → כל מספרי ה-WABA מסומנים `revoked` + חסימת שליחה, ונרשם audit.

## 5. מה לא ממומש / הסתייגויות

- **Coexistence** (מספר שכבר ב-WhatsApp Business App): לא ממומש ולא מובטח. הוא דורש גרסת אפליקציה ≥ 2.24.17 בצד הלקוח, רישום לשדות `history` / `smb_app_state_sync` / `smb_message_echoes` ו-Flow ייעודי (`featureType: "whatsapp_business_app_onboarding"`). המספר עדיין חייב להיות זמין ל-Cloud API; אם המספר נמצא באפליקציה, Meta תדרוש הסרה משם והכרטיס יציג את השגיאה שהוחזרה.
- **מספרי בדיקה של Meta**: בדיקת שליחה משתמשת בתבנית `hello_world` ורק למספר שהוזן ידנית – לא ללקוחות.
- **חשבון WABA ללא מספר** (`FINISH_ONLY_WABA`): התהליך מסתיים בשגיאה מוסברת; יש להוסיף מספר ב-Meta ולחבר מחדש.
- **תוקף Token**: business integration system user tokens אינם פגים כברירת מחדל; "בדוק חיבור" מריץ `debug_token` ומעדכן `revoked` במקרה הצורך.

## 6. בדיקות

### הדמיה (רצות ב-CI, ללא Meta)
`npm run test:integration` → `tests/integration/whatsapp-embedded-signup.test.ts` – Graph API מזויף בתוך התהליך, DB אמיתי מבודד:
הצלחה מלאה; ביטול; code לא תקף; state של עסק אחר / state לא קיים; שימוש חוזר ב-state; הרשאה חסרה; מספר שלא ב-WABA; כישלון חלקי (subscribe) + retry ללא כפילויות; מספר של עסב אחר; חיבור חוזר לאותו מספר (שורה אחת); PIN קיים → needs_action → השלמה עם PIN; ביטול הרשאה בבדיקת חיבור; ניתוק דורש אישור, סוכן נדחה (403), unsubscribe, היסטוריה נשמרת; חיבור מחדש; webhook: GET verify, חתימה שגויה/חסרה 401, הודעה נכנסת לעסק הנכון + כפילות פעם אחת, "הסר" → השתקה, `account_update` PARTNER_REMOVED → revoked.
בדפדפן (Playwright, `scripts/qa-embedded-signup.mjs`): מצב "חסרה הגדרה" עם רשימת משתנים, כפתור מושבת, סוכן לא רואה את העמוד.

### מול Meta (לא בוצע – אין עדיין אפליקציה/Config ID)
צ'קליסט ידני לאחר מילוי משתני הסביבה בסביבת בדיקה ורישום הדומיין:
1. לחיצה על "חבר WhatsApp" עם חשבון Meta שיש לו תפקיד באפליקציה → חלון Embedded Signup נפתח, בחירת WABA + מספר בדיקה.
2. אחרי סגירה: הכרטיס מציג את שם החשבון והמספר, `subscribed_at` ו-`registered_at` מלאים, מצב "מחובר ופעיל".
3. "בדוק חיבור" → `debug_token` תקין, שתי ההרשאות מופיעות.
4. "שלח הודעת בדיקה" למספר בדיקה שבבעלותכם → נשלחת תבנית `hello_world`, `last_outbound_test_at` מתעדכן.
5. שליחת הודעה מהמספר הבדיקה למספר העסקי → ההודעה מופיעה ב-Inbox על כרטיס הלקוח, "אירוע אחרון" מתעדכן.
6. הסרת האפליקציה מה-WABA ב-Business Manager → אירוע `account_update` מסמן `revoked`; "חבר מחדש" משחזר.
7. "נתק" → אישור → `DELETE subscribed_apps` מצליח, מצב "לא מחובר", היסטוריה נשארת.
8. לחיצה כפולה מהירה / פתיחת שני טאבים → ניסיון אחד בלבד ב-`whatsapp_signup_sessions`.
