# דיוור רב-ערוצי: WhatsApp · SMS · אימייל

מסמך זה מתאר את הרחבת מערכת הדיוור של UltraCRM לשני ערוצים נוספים – SMS ואימייל – על אותם אנשי קשר,
אותם קמפיינים, אותן אוטומציות ואותה רשימת הסרה גלובלית. הכול ממומש בענף `feat/multichannel-marketing`.

## 1. מפת המימוש

| שכבה | קבצים | תפקיד |
|---|---|---|
| ספקים | `src/server/channels/types.ts` (ממשקים), `sms/telnyx-sms.ts`, `email/resend-email.ts`, `mock.ts`, `registry.ts` | שכבת ספקים נפרדת לכל ערוץ: `send`, `check`, `verifyWebhook`, `parseWebhook`, `domains` (אימייל). החלפת ספק = מימוש חדש של הממשק, ללא שינוי בשירותים |
| שליחה | `src/server/services/channel-send-service.ts` | הנתיב היחיד לשליחת SMS/אימייל: idempotency לפי `requestKey`, שמירה לפני הספק, בדיקת הסרה/הסכמה פעמיים (בתור ורגע לפני הספק), מגבלת תדירות משותפת, timeout → `UNKNOWN` ללא retry, ספק לא זמין → השהיית קמפיין |
| אירועי ספק | `src/server/services/delivery-status-service.ts`, `src/lib/channel-webhook.ts`, `/api/webhooks/{sms,email}/{provider}/{credentialId}` | אימות חתימה לפי מפתח של העסק, dedupe לפי `provider+eventId` (`provider_webhook_events`), סטטוסים מונוטוניים (אירוע מאוחר לא מוריד סטטוס), bounces/תלונות/פתיחות/הקלקות, תשובות SMS נכנסות |
| חיבורים | `src/server/services/channel-credential-service.ts`, `/api/channels/[channel]`, `/settings/sms`, `/settings/email` | מפתחות מוצפנים (AES-256-GCM) ומוסתרים; שמירה מריצה בדיקת ספק; דומיין שולח + רשומות DNS |
| תבניות | `src/server/services/channel-template-service.ts`, `src/lib/merge-tags.ts`, `src/lib/sms.ts`, `src/lib/email/blocks.ts`, `/templates?channel=` | תבניות SMS (ספירת תווים/מקטעים GSM-7/UCS-2) ואימייל (עורך בלוקים → HTML+טקסט, RTL, מובייל) עם משתנים אישיים וברירות מחדל |
| קמפיינים | `src/server/services/campaign-service.ts`, `src/jobs/campaign-runner.ts`, `/campaigns` | בורר ערוץ, קהל, שולח, אומדן עלות, בדיקת שליחה, תזמון באזור זמן העסק, חלון שליחה וקצב, דוח |
| הסרה גלובלית | `src/lib/suppression.ts`, `/u/[token]`, `/api/unsubscribe`, `/api/suppressions/[id]/review` | מקור אמת אחד לכל הערוצים + קישור הסרה ציבורי חתום + בקשות לא ברורות לבדיקה |
| רצפים | `src/server/services/sequence-service.ts`, `/api/sequences`, מסך אוטומציות | רצפים בין ערוצים (למשל WhatsApp נכשל → המתנה → SMS) עם בדיקת כשירות לפני כל שלב |
| סכימה | `prisma/migrations/20260924070258_multichannel_marketing` | שדות ערוץ ב-`provider_credentials`/`messages`/`templates`/`campaigns`, `provider_webhook_events`, `marketing_sequences`, `sequence_steps`, `sequence_runs`, `suppressions.pending_review`, `contacts.email_status` |

## 2. ספקים שנבחרו (לפי תיעוד רשמי, ספטמבר 2026)

### SMS – Telnyx Messaging
- `POST /v2/messages` עם `from` (מספר או שולח אלפאנומרי) + `messaging_profile_id`; התשובה מחזירה `parts`, `encoding` ו-`cost` כשזמין.
- Webhooks חתומים Ed25519 (`telnyx-signature-ed25519`, `telnyx-timestamp`); המפתח הציבורי נשמר בחיבור של העסק. אירועים: `message.sent`, `message.finalized` (delivered / delivery_failed / sending_failed), `message.received`.
- שולח אלפאנומרי נתמך בישראל אך **אינו קולט תשובות** – במקרה זה ההסרה בהודעה היא קישור, לא "השב הסר".
- אין API להזרמת רשימת החסימה שלנו ל-Telnyx → `suppressionSync=false` (החסימה המקומית תמיד קובעת).

### אימייל – Resend
- `POST /emails` עם `Idempotency-Key`; כותרות `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` בכל אימייל שיווקי.
- דומיינים: `POST /domains` מחזיר רשומות SPF/DKIM (MX + TXT) לסטטוס `not_started|pending|verified|failed`; `POST /domains/{id}/verify`. DMARC אינו נדרש על ידי Resend – מוצג כרשומה **מומלצת** (`_dmarc`, `p=none`). המערכת לא משנה DNS.
- Webhooks חתומים Svix (`svix-id`, `svix-timestamp`, `svix-signature`); אירועים: sent, delivered, delivery_delayed, bounced (Permanent → `hard`), complained, opened, clicked, failed.
- אין API לרשימת חסימה → `suppressionSync=false`.

### הדמיה
`mock_sms` / `mock_email` – ללא רשת. שליחה מסתיימת ב-`ACCEPTED` בלבד (לא "נמסר"); אירועי ספק מדומים נשלחים ל-webhook עם חתימת `x-mock-signature` (HMAC של הסוד שנוצר לחיבור). כל המסכים מסמנים "הדמיה".

## 3. הגדרת חיבור (לכל עסק, הגדרות → חיבורים)

| ערוץ | שדות | הערות |
|---|---|---|
| SMS | ספק, API Key, Messaging Profile ID, Public Key (Ed25519), שולחים אלפאנומריים, נמעני בדיקה, מחיר למקטע | המספרים המשויכים לפרופיל מתגלים בבדיקת החיבור |
| אימייל | ספק, API Key, Webhook Signing Secret, שם/כתובת שולח, Reply-To, נמעני בדיקה, מחיר לאימייל; דומיין שולח | שליחה אמיתית נחסמת עד `verified` |

כתובת ה-webhook להגדרה אצל הספק מוצגת בכרטיס החיבור: `https://<domain>/api/webhooks/sms/telnyx/<credentialId>` / `https://<domain>/api/webhooks/email/resend/<credentialId>`.

**אין משתני סביבה חדשים** – המפתחות נשמרים לכל עסק ב-`provider_credentials.config` מוצפנים ב-`ENCRYPTION_KEY` (קיים). `NEXT_PUBLIC_APP_URL` משמש לקישורי הסרה ול-webhook URL.

הגדרות עסק (`settings.marketing`): חלון שליחה (`window`, ברירת מחדל 08:00–21:00 כל יום, באזור הזמן של העסק), `maxPerMinute` (ברירת מחדל 60), `minHoursBetweenMarketing` (24 – משותף לכל הערוצים).

## 4. הסרה גלובלית – כללים כפי שמומשו

- כל בקשה מכל ערוץ (קישור באימייל, "הסר"/STOP ב-SMS, "הסר" ב-WhatsApp, נציג, ייבוא, תלונת ספאם) יוצרת `suppressions` לכל הטלפונים והאימיילים של איש הקשר, עם מקור, סיבה, מועד וההודעה שגרמה (`message_id`).
- איש הקשר נשאר ב-CRM ומוצג "הוסר מכל הדיוורים"; `consent_status=OPTED_OUT`.
- בעת הסרה: נמענים בתור → `SKIPPED`; הודעות שיווקיות שנשמרו וטרם הועברו לספק → `CANCELLED`; ריצות רצף → `STOPPED`. הודעות שכבר הועברו לספק אינן מסומנות כבוטלו (אין לספקים ביטול).
- ה-worker בודק שוב מיד לפני הפנייה לספק (`sendBlockReason`) – גם אם ההודעה נכנסה לתור לפני ההסרה.
- ייבוא מחדש, שינוי רשימה, החלפת ספק/שולח – לא מבטלים חסימה. חזרה לדיוור רק עם תיעוד הסכמה (`revokeSuppressions`).
- קישור הסרה: token חתום (HMAC) הקשור לעסק+איש קשר+מזהה+הודעה, ללא התחברות, מציג מזהה ממוסך בלבד; one-click POST נתמך.
- בקשה לא ברורה ("תפסיקו לשלוח", "not interested"…) → `pending_review`: הדיוור מושהה, מנהל מאשר/דוחה (דחייה דורשת נימוק) במסך ההסרות.
- הסרה מוגבלת לעסק; token של עסק אחד אינו יכול לשנות איש קשר של עסק אחר.
- הודעות שירות נפרדות: קטגוריה נגזרת מהתבנית (`MARKETING`/`UTILITY`), לא מפרמטר חופשי בבקשה.

## 5. סטטוסים

| סטטוס | משמעות |
|---|---|
| QUEUED | נשמר, טרם הועבר לספק |
| ACCEPTED | הספק קיבל (אינו הוכחה למסירה) |
| SENT / DELIVERED | דיווח הספק |
| FAILED / BOUNCED | דיווח הספק (bounce קשיח → הכתובת מסומנת ולא תנוסה שוב) |
| CANCELLED | נעצר אצלנו לפני הספק (הסרה / ביטול קמפיין / משתנה חסר) |
| UNKNOWN | timeout מול הספק – לא מנוסה שוב אוטומטית |

פתיחות/הקלקות באימייל נשמרות כ-`opened_at`/`clicked_at` (אות מהספק, מושפע מפרטיות וסריקות) ולעולם לא כ-`READ`.

## 6. דוחות

`GET /api/campaigns/{id}/report` – נמענים לפי סטטוס, מסירה לפי סטטוס, פתיחות/הקלקות/תלונות/bounces, תשובות, הסרות שיוחסו לקמפיין, עלות בפועל (מהספק) לעומת אומדן (מחיר יחידה ידני). לכל נתון תווית זמינות: `real | simulated | estimated | partial | signal | unavailable`.

## 7. מה נדרש להפעלה אמיתית (חסום כעת)

1. חשבון Telnyx: API Key, Messaging Profile, מספר/שולח מאושר לישראל, המפתח הציבורי מהפורטל, והגדרת ה-webhook URL של העסק בפרופיל.
2. חשבון Resend: API Key, דומיין שולח עם רשומות SPF/DKIM (ו-DMARC מומלץ) ב-DNS של העסק, webhook עם signing secret.
3. `NEXT_PUBLIC_APP_URL` ציבורי ב-HTTPS (קישורי הסרה ו-webhooks).
4. שליחות אמיתיות רק לנמעני בדיקה שהוגדרו במפורש בחיבור.

## 8. בדיקות

- יחידה (`tests/unit/channels.test.ts`): מקטעי SMS (GSM-7/UCS-2/אימוג'י), משתנים וברירות מחדל, רינדור אימייל (RTL, escaping, קישור הסרה), token הסרה (זיוף נדחה), זיהוי הסרה ברורה/לא ברורה, חתימות Ed25519 (Telnyx) ו-Svix (Resend) ופענוח אירועים.
- אינטגרציה (`tests/integration/multichannel.test.ts`, DB מבודד, ספקים מדומים): הסרה מאימייל חוסמת SMS+WhatsApp; "הסר" ב-SMS (webhook חתום) חוסם אימייל+WhatsApp; חתימה שגויה 401; אירוע כפול פעם אחת; בקשה לא ברורה → בדיקה → דחייה/אישור; נמען שהוסר אחרי הכניסה לתור נעצר לפני הספק; ריצת worker חוזרת לא שולחת פעמיים; סטטוס מאוחר לא מוריד DELIVERED; דוח עם תוויות; בידוד עסקים (חיבורים, דוח, token); ייבוא מחדש לא מחזיר לדיוור; bounce קשיח → הכתובת נפסלת; תלונה → הסרה; פתיחה אינה READ; ספק לא זמין → הקמפיין מושהה ואיש לא מסומן כנכשל, וההסרה עובדת בזמן שהספק למטה; רצף WhatsApp נכשל → SMS, אירוע כפול = ריצה אחת, הסרה עוצרת רצף; תבנית עם משתנה ללא ברירת מחדל נדחית; שליחות בדיקה רק לנמעני בדיקה.
- רגרסיה: כל סוויטות WhatsApp/CRM/טלפוניה הקיימות.
- דפדפן: `scripts/qa-multichannel.mjs`.
