# ניהול מספרים יוצאים: מוניטין, רכישה ורוטציה

מסך `/numbers` (מנהלים ובעלים, מודול טלפוניה) עם קישור מההגדרות ומהתפריט. הועבר מענף `feat/outbound-number-management` של החייגן והותאם ל-UltraCRM הרב-עסקי. אין רכישות אמיתיות, שיחות חיצוניות או שינוי ייצור במסגרת העבודה.

## 1. מה אושר בתיעוד הרשמי ומה מומש

| ספק | מה התיעוד מאשר | מה מומש / חסום |
|---|---|---|
| **Truecaller** | ל-Truecaller for Business יש לוח Analytics עם דוחות ספאם; ה-API הציבורי למפתחים הוא אימות מספר/זהות משתמש – לא בדיקת מוניטין | לא נמצאה הרשאה מאומתת לחשבון שלנו ולא חוזה API למוניטין. החיבור מסומן **"אינו נתמך בתצורה הנוכחית"**. אין scraping ואין endpoint מומצא. יש מעבר לפורטל, תיעוד בדיקה ידנית (מסומן "ידני") ותהליך טיפול/ערעור מתועד. אין בדיקות מתוזמנות |
| **Telnyx** | חיפוש מספרים זמינים עם מחיר, הזמנות עם `customer_reference`, בירור הזמנות, מלאי, שיוך ל-Call Control App, בדיקת אפליקציה ופרופיל חיוג יוצא | adapter מלא: בדיקת חיבור (אפליקציה פעילה + פרופיל יוצא מופעל + גישה למלאי), סנכרון, הצעת מחיר, רכישה עם אישור, בירור. נבדק בסימולציה בלבד – אין חשבון QA חי |
| **Zadarma** | API לחיפוש לפי מדינה/יעד, הזמנת מספר ומסמכים, ניתוב SIP | התיעוד נבדק; adapter **לא מומש**. ממשק `NumberProvider` מאפשר להוסיפו; שיחות דרך Zadarma ידרשו גם adapter טלפוניה |
| **הדמיה** | – | `NUMBER_PROVIDER=mock`: מלאי בזיכרון, ללא חיוב, מסומן "הדמיה" בכל מסך ותשובת API |

מקורות: Telnyx [available numbers](https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers), [number orders](https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order), [phone numbers](https://developers.telnyx.com/api-reference/phone-number-configurations/retrieve-a-phone-number), [call control apps](https://developers.telnyx.com/api-reference/call-control-applications/retrieve-a-call-control-application), [outbound voice profiles](https://developers.telnyx.com/api-reference/outbound-voice-profiles/retrieve-an-outbound-voice-profile); Truecaller [Analytics](https://docs.truecaller.com/truecaller-for-business/features/analytics/what-insights-are-available-on-the-analytics-dashboard), [developer API](https://developer.truecaller.com/); Zadarma [numbers API](https://zadarma.com/en/support/api/).

## 2. מפת המימוש

| שכבה | קובץ |
|---|---|
| ספקים | `src/lib/numbers/providers.ts` – `NumberProvider` (test/search/inventory/purchase/findOrders/configure), Telnyx, הדמיה |
| בחירת מספר | `src/lib/numbers/selection.ts` – `selectOutboundNumber` בתוך טרנזקציית יצירת השיחה תחת נעילת מאגר המספרים |
| שירות | `src/lib/numbers/service.ts` – בדיקת חיבור, סנכרון, הצעה/רכישה/בירור, מדיניות לקמפיין, סקירה למסך |
| API | `/api/numbers` (GET סקירה; POST connection/sync/search/quote/purchase/reconcile/policy/number/reputation_*/review), `/api/jobs/numbers` (cron יומי) |
| מסך | `/numbers` (`src/components/numbers/NumbersManager.tsx`) |
| חיוג | `src/lib/dialer/calls.ts` (בחירה + `numberSelectionReason` בכל שיחה), `src/lib/dialer/inbound.ts` (ניתוב חוזרות לנציג המשויך/האחרון) |
| סכימה | `prisma/migrations/20260924102150_number_management` – שדות ב-`phone_numbers`, `dial_lists.number_policy`, `calls.number_selection_reason`, `number_connections`, `number_orders` |

## 3. רוטציה של מספרים יוצאים

מדיניות לכל רשימת חיוג (קמפיין): **קבוע** · **קבוע לכל נציג** (`assignedUserId`) · **Round Robin** · **לפי עומס** (שיחות פעילות / `maxConcurrent`, ואז ניסיונות יומיים).
- רק מספרים בבעלות העסק שאומתו מול מלאי הספק ב-24 השעות האחרונות (בהדמיה: מספרים פעילים). אין זיוף Caller ID.
- ליד שומר את המספר שממנו חויג בעבר אם עדיין כשיר (`sticky_lead`).
- מספר מושהה, לא פעיל, לא מאומת, או שהגיע ל-`maxConcurrent`/`maxDailyAttempts` – מדולג.
- הבחירה נעשית בטרנזקציה עם `pg_advisory_xact_lock` על מאגר העסק – בטוח לחיוג מקבילי.
- בכל שיחה נשמרים `phoneNumberId`, `fromE164` ו-`numberSelectionReason`.
- שיחה חוזרת מנותבת לנציג המשויך למספר (`callbackUserId`) או לנציג שחייג אחרון ללקוח מאותו מספר.
- אין מספר כשיר → החיוג נעצר עם `no_eligible_number` והסבר.
- מדיניות קבועה אינה מחליפה בשקט למספר אחר. **מספר שסומן כספאם ושימש לליד חוסם המשך חיוג לאותו ליד עד בדיקת מנהל** – הרוטציה לעולם אינה משמשת לעקיפת סימון ספאם. DNC והסרה חלים על כל מספרי הארגון.

## 4. רכישה

הצעת מחיר (5 דקות) → אישור מפורש של בעל העסק עם המחיר → בדיקת מחיר מחדש רגע לפני החיוב → הזמנה עם `customer_reference` = מזהה ההזמנה שלנו → בירור מצב (`findOrders`) → שיוך לאפליקציה → סנכרון מלאי → `ready`.
לחיצה כפולה: CAS על `state=quoted` – בקשה שנייה מבררת ולא רוכשת. timeout/שגיאה: `unknown`, בירור לפי האסמכתה, אף פעם לא POST חוזר אוטומטי. רכישה שהצליחה והגדרה שנכשלה: המספר לא נכנס למאגר עד שהבירור משלים. אין ביטול מספר קיים אוטומטית.
רכישות אמיתיות דורשות `NUMBER_PURCHASES_ENABLED=true` (וחסומות תחת `QA_LOCAL=1`); ללא API רכישה מוצג מעבר לפורטל הספק וסנכרון.

## 5. הגדרות שרת

```
TELNYX_API_KEY, TELNYX_CALL_CONTROL_APP_ID   – חשבון הטלפוניה הקיים (סוד שרת)
TELNYX_NUMBERS_BUSINESS_ID=<business id>     – העסק היחיד המורשה לראות/לרכוש דרך החשבון
NUMBER_PURCHASES_ENABLED=false               – רכישות אמיתיות כבויות
NUMBER_PROVIDER=mock                          – הדמיה (פיתוח/QA בלבד)
```
שמירת משתנים אינה חיבור: "בדוק חיבור" מאמת אפליקציה פעילה, פרופיל יוצא מופעל וגישה למלאי, ונשמר עם fingerprint של המפתחות; שינוי מפתח מבטל את האימות. אימות בן יותר מ-24 שעות חוסם חיוג אמיתי עד רענון (cron יומי `/api/jobs/numbers`). מספרים קיימים מקבלים `unverified` במיגרציה; עם טלפוניה אמיתית הם ייחסמו לחיוג עד סנכרון.

## 6. QA (הדמיה; ראו `tests/integration/numbers.test.ts`)

| | תרחיש | תוצאה |
|---|---|---|
| NUM1 | סוכן לא יכול לקרוא/לנהל; עסק אחר לא יכול לשנות; אין סודות בתשובה | עבר |
| NUM2 | הגדרה לבדה אינה "מאומת"; בדיקה שנכשלה נרשמת | עבר |
| NUM3/24 | שלוש הזמנות מקבילות → שלושה מספרים; מכסת מקביליות ומכסה יומית נאכפות | עבר |
| NUM4 | ליד שומר מספר קודם; סיבת הבחירה נשמרת | עבר |
| NUM5/6 | מושהה/לא פעיל מדולגים; קמפיין קבוע לא מחליף בשקט | עבר |
| NUM7 | מדיניות נציג ועומס | עבר |
| NUM8 | ספאם על מספר הליד חוסם עד בדיקה | עבר |
| NUM10 | ללא אימות ספק/מספר עדכני אין שיחה אמיתית | עבר |
| NUM12/13 | רכישה דורשת אישור; לחיצות מקבילות מחייבות פעם אחת | עבר |
| NUM14/16 | timeout אחרי הצלחה → בירור ללא רכישה נוספת; שגיאה לפני הזמנה → ללא מספר וללא retry | עבר |
| NUM15 | הצעה שהשתנתה/פגה לא מחייבת | עבר |
| NUM17 | כשל סנכרון מסמן failed ושומר מספרים והיסטוריה; סנכרון מייבא רק את מספרי האפליקציה | עבר |
| NUM19 | דיווח ידני נפרד מבדיקת API ופותח בדיקה | עבר |
| NUM20 | throttling בשרת | עבר |
| דפדפן | `scripts/qa-numbers.mjs` – מסך RTL, מצב חיבור כן, רכישה בהדמיה עם אישור מפורש, מדיניות, השהיה, דיווח ידני | ראו דוח |

**עובד מול ספק אמיתי:** כלום עדיין (אין חשבון Telnyx QA). **נבדק בסימולציה:** כל הנ"ל. **חסום:** Truecaller (אין API מורשה), Zadarma (לא מומש), רכישה אמיתית (מושבתת בכוונה).
