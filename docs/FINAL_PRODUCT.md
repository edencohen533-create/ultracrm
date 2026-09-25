# תמונת המוצר הסופית – מה בוצע (2026-09-25, ענף `feat/lead-workspace`)

| # | דרישה | מימוש | איפה |
|---|---|---|---|
| 1 | X בפופאפ החייגן | X תמיד זמין. לפני סשן – סוגר. בזמן סשן/שיחה – מסתיר את החלון בלבד (השיחה ממשיכה) ומופיעה גלולה "החייגן פעיל – פתח" | `LeadsWorkspace.tsx` (`dialer-close`, `dialer-reopen`) |
| 2 | עריכת סטטוסים | שם, סדר והסתרה לכל סטטוס (המפתח הפנימי נשאר – דוחות/אוטומציות ממשיכים). מנהל ומעלה. כל מסך שמציג סטטוס משתמש ב-hook | `LeadsSettingsModal` לשונית "סטטוסים", `GET/PATCH /api/lead-statuses`, `useLeadStatuses`, `src/lib/lead-statuses.ts` |
| 3 | 4 קוביות בלידים | סה״כ לידים · עסקאות שנסגרו · אחוז סגירה · הכנסות – משתנות לפי מסנן נציג/תקופה. הוסרו תקציב/עלות לליד/CAC/רווח | `LeadsWorkspace.tsx` |
| 4 | כפתור חייגן גדול + הגדרות | "הפעל חייגן" גדול וירוק; "הגדרות חייגן" פותח מודאל עם הגדרות החייגן האישיות של הנציג (מה שהיה ב-/crm-settings) | `.dialer-launch`, `LeadsSettingsModal` לשונית "חייגן" (`CrmSettings embedded`) |
| 5 | וואטסאפ בלי שיחות | תפריט "וואטסאפ" בלבד, לשוניות השיחות הוסרו מה-inbox, `/calls` → `/inbox` | `Sidebar.tsx`, `inbox/layout.tsx` |
| 6 | מחיקת עמוד עסקאות | `/deals` → `/leads` (יצירת עסקה מהליד + כרטיס עסקה `/deals/[id]` נשארו) | `deals/page.tsx` |
| 7 | מחיקת עמוד משימות | `/tasks` → `/leads?tasks=1`; המשימות נפתחות במגירה "משימות וחזרות" בתוך הלידים | `TasksPanel` (embedded) |
| 8 | הגדרות CRM → הגדרות חייגן | `/crm-settings` → `/leads?settings=1` (המודאל נפתח) | `crm-settings/page.tsx` |
| 9 | רשימת חיוג = עמוד לידים | `/lists/[id]`: כותרת/פעולות הרשימה + אותו מסך לידים (מסונן לרשימה, `?listId=`), ולשונית "תור החיוג" עם הטבלה הישנה (ניסיונות, העברה, החזרה לתור) | `ListQueuePanel.tsx`, `pipeline.ts listId` |
| 10 | מחיקת אוטומציות + הסרה על "הסר" | כפתור "מחק" לכל כלל (`DELETE /api/automations/rules/[id]`, ריצות ממתינות נמחקות, audit). הסרה על "הסר"/STOP מובנית בקליטת הודעות (`message-service.ts` → `suppressContact`) – מכוסה ב-`tests/integration/suppression.test.ts` | `rule-list.tsx` |
| 11 | 4 עמודים לקמפיינים | `/audiences` (קהלים + ייבוא אנשי קשר), `/campaigns/whatsapp`, `/campaigns/email`, `/campaigns/sms`; `/campaigns` → WhatsApp. תפריט הניהול עודכן | `campaigns-screen.tsx`, `CampaignDashboard mode/fixedChannel` |
| 12 | Round robin + תקרה | הגדרות → "חלוקת לידים": least-loaded / round robin, מקסימום לידים פתוחים לנציג, בחירת נציגים. חל על לידים חדשים ללא נציג; איש קשר שייבא מנהל מחולק לפי המדיניות; נציג בתקרה מדולג | `handlers.ts pickOwner`, `LeadsSettingsModal` |
| + | "נתקעתי? שאל את ה-AI" | ראו `docs/SALES_COACH.md` §7 | `CoachChat.tsx`, `chat.ts` |

## מה נבדק
- `npx tsc --noEmit` נקי; eslint על הקבצים שנגעו – 0 שגיאות.
- אינטגרציה על מסד אמיתי: `lead-distribution.test.ts` 3/3 (סטטוסים: מנהל עורך, נציג 403, מפתח לא חוקי 400; round robin a1,a2,a1,a2 ואז ללא שיוך בתקרה 2, נציג מחוץ לסבב לא מקבל; `?listId=` מחזיר רק את אנשי הקשר של הרשימה), `events.test.ts` 6/6 (הנתיב הישן של שיוך נשאר), `coach-chat.test.ts` 3/3.
- דפדפן (`scripts/qa-final-product.mjs`, מנהל + נציג) – תוצאות בסיכום המסירה.
