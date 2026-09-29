# הגשה ל-Meta – מדריך צעד אחר צעד (בעברית)

המסמך המלא באנגלית, כולל נוסחים להעתקה ותסריטי הסרטונים: `docs/META_APP_REVIEW.md`.
כל הערכים כאן מוכנים להעתקה. הקוד והשרת מוכנים – נשארו רק הפעולות אצל Meta.

## הפרטים שלך (להזין בדיוק כך בכל מקום)
| שדה | ערך |
|---|---|
| שם | Eden Cohen |
| כתובת | 4 Emma Tauber St., Herzliya, Israel |
| אימייל | edencohen533@gmail.com |
| אתר | https://ultracrm-eta.vercel.app |

אם תאמת את העסק בשם אחר (עוסק מורשה / חברה) – עדכן אותי, והשם באתר יוחלף כדי שיתאים למסמכים.

## שלב 1 – הכנה (5 דקות)
1. בחשבון הפייסבוק שמנהל את העסק: להפעיל אימות דו-שלבי (Settings → Security → Two-factor).
2. ב-business.facebook.com – לוודא שיש Business portfolio (תיק עסקי). אם אין – ליצור.

## שלב 2 – אימות העסק (Business Verification)
Business settings → Business info / Security center → **Start verification**.
- שם, כתובת, אימייל ואתר – מהטבלה למעלה. טלפון – שלך.
- מסמכים: מסמך רשמי עם השם והכתובת (תעודת עוסק, או חשבון חשמל/מים/ארנונה על שמך בכתובת הזו).
- אימות: בחר **email** או **phone**. (אימות דומיין לא אפשרי על ‎`vercel.app`‎.)
- זמן טיפול: בדרך כלל כמה ימים. אפשר להמשיך בשלבים הבאים במקביל.

## שלב 3 – יצירת האפליקציה
developers.facebook.com → My Apps → **Create app**
- Use case: **Connect with customers through WhatsApp** · סוג: **Business** · לחבר ל-Business portfolio שלך.

## שלב 4 – הגדרות בסיס (App settings → Basic)
| שדה | ערך |
|---|---|
| Display name | UltraCRM |
| App icon | הקובץ `docs/meta/app-icon-1024.png` |
| App domains | ultracrm-eta.vercel.app |
| Contact email | edencohen533@gmail.com |
| Privacy Policy URL | https://ultracrm-eta.vercel.app/privacy |
| Terms of Service URL | https://ultracrm-eta.vercel.app/terms |
| User data deletion → Data deletion callback URL | https://ultracrm-eta.vercel.app/api/meta/data-deletion |
| Category | Business and pages |

שמור. מאותו מסך: העתק את **App ID** ואת **App Secret** (לחיצה על Show).

## שלב 5 – Embedded Signup (Facebook Login for Business)
1. Facebook Login for Business → **Configurations** → Create configuration.
   - סוג: **WhatsApp Embedded Signup**, מוצר: **WhatsApp** (זה קובע גרסה v4).
   - העתק את ה-**Configuration ID**.
2. Facebook Login for Business → **Settings**:
   - Login with the JavaScript SDK: **Yes**
   - Allowed Domains for the JavaScript SDK: `https://ultracrm-eta.vercel.app`
   - Valid OAuth Redirect URIs: `https://ultracrm-eta.vercel.app/`
   - Deauthorize callback URL: `https://ultracrm-eta.vercel.app/api/meta/deauthorize`

## שלב 6 – להעביר לי ולהגדיר
- **לשלוח לי**: App ID ו-Configuration ID.
- **להגדיר בעצמך** (הסוד לא עובר דרך הצ׳אט) – בטרמינל של Claude Code:
  ```
  ! npx vercel env add META_APP_SECRET production
  ```
  (מדביקים את ה-App Secret כשמתבקש.)
- אני אפרוס ואריץ `scripts/meta-go-live-check.mjs` – בודק את מחיקת הנתונים, הניתוק וה-webhook בפרודקשן.

## שלב 7 – Webhook
WhatsApp → **Configuration** → Webhook → Edit:
- Callback URL: `https://ultracrm-eta.vercel.app/api/webhooks/whatsapp`
- Verify token – להציג אותו אצלך:
  ```
  ! npx vercel env pull --environment=production /tmp/p.env && grep META_WEBHOOK_VERIFY_TOKEN /tmp/p.env && rm /tmp/p.env
  ```
- Verify and save (כבר נבדק – עובר), ואז Subscribe לשדות: **messages**, **message_template_status_update**, **phone_number_quality_update**, **account_update**.

## שלב 8 – בדיקה אמיתית עם המספר שלך
- המספר צריך להיות מספר שלא פעיל באפליקציית וואטסאפ רגילה (או להסיר אותו ממנה קודם).
- ב-UltraCRM: הגדרות → חיבורים → **ניהול חיבור וואטסאפ** → **חבר WhatsApp** → לעבור את החלון של Meta.
- לשלוח הודעה מהטלפון למספר, ולענות מתיבת הוואטסאפ במערכת. לשלוח לי צילום אם משהו לא עובד.
- להוסיף אמצעי תשלום ב-WhatsApp Manager (בלי זה אין שליחת תבניות).

## שלב 9 – חשבון לבודקים
```
node scripts/create-reviewer.mjs reviewer@<כתובת ששייכת לך>
```
הסיסמה מודפסת רק אצלך. אחרי האישור: אותה פקודה עם `--revoke`.

## שלב 10 – הקלטת הסרטונים (Chrome, ממשק באנגלית)
לפני ההקלטה: כפתור **English** במסך הכניסה. רזולוציה 1080p, רוחב דפדפן עד 1440.
- **סרטון A** (`whatsapp_business_management`): כניסה → חיבור וואטסאפ → יצירת תבנית ושליחתה לאישור → התבנית מאושרת.
- **סרטון B** (`whatsapp_business_messaging`): הודעה מהטלפון מגיעה למערכת → תשובה מהמערכת מגיעה לטלפון (הטלפון/WhatsApp Web נראה בהקלטה) → שליחת תבנית.
התסריט המלא: סעיף 3 ב-`docs/META_APP_REVIEW.md`.

## שלב 11 – הגשה
App Review → Permissions and features → **Request advanced access** ל:
`whatsapp_business_management` ו-`whatsapp_business_messaging` (רק אלה).
- לכל הרשאה: להדביק את הנוסח מסעיף 2 ב-`docs/META_APP_REVIEW.md` ולצרף את הסרטון שלה.
- הוראות לבודקים: סעיף 4 (+ המייל והסיסמה משלב 9).
- ללחוץ **Submit** (טיוטה לא נבדקת). זמן תשובה: מיום עד כמה שבועות.
