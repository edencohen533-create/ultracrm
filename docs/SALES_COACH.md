# מאמן מכירות בזמן אמת (AI)

ענף `feat/lead-workspace`, 2026-09-25. שכבת AI שמחברת את החייגן, ה-CRM ו-WhatsApp: מבינה מה נאמר בשיחה הנוכחית, מכירה את הליד, לומדת משיחות ומעסקאות קודמות של אותו עסק, ומציגה לנציג המלצה אחת קצרה בכל רגע.

## 1. סקירת הקוד הקיים (לפני המימוש)

| שאלה | תשובה |
|---|---|
| איך מתבצעת שיחה ואיפה יש אודיו | `DialerProvider` (דפדפן) מחזיק WebRTC של Telnyx; השרת מחייג את שני הרגליים (`src/lib/dialer/calls.ts`, `src/lib/telephony/telnyx.ts`). האודיו של הלקוח מגיע לדפדפן הנציג ומנוגן ב-`<audio id="remote-audio">`; המיקרופון דרך `getUserMedia`. **אין** תמלול חי במערכת ואין media-streaming מהשרת (Vercel serverless, ללא WebSocket מתמשך). בהדמיה (`TELEPHONY_PROVIDER=mock`) אין אודיו בכלל. |
| שיחה ↔ ליד/נציג/עסק | `Call { businessId, userId, contactId, leadId }` – שימו לב: `Call.leadId` הוא שורת רשימת חיוג (`ListLead`), לא ליד CRM. ליד ה-CRM נגזר מאיש הקשר (`Lead.contactId`). |
| הקלטות ותוצאות | `Call.recordingStatus/recordingId` (אצל הספק, מוזרם דרך `/api/recordings/[callId]` עם מפתח שרת); תוצאה: `Call.outcome`, `outcomeNote`, `outcomeSavedAt`, אירוע `call.outcome_saved`. |
| עסקה נסגרה/לא | `Deal.stage` (won/lost) + `status` + `closedAt` דרך `updateDeal` (`src/lib/crm/pipeline.ts`); היה אירוע `deal.won` בלבד – נוסף `deal.lost`. |
| כרטיס ליד ו-WhatsApp | כרטיס איש קשר: פרטים, ליד (כותרת/סטטוס/הערות), משימות, שיחות עם תוצאות והקלטות, הודעות WhatsApp (`Message.body/direction`), ציר זמן. |
| AI/תמלול קיים | לא היה כלום: אין OpenAI/Anthropic, אין תמלול, אין ניתוח שיחות. |

## 2. ארכיטקטורה – ארבע שכבות (`src/server/coach/`)

```
┌────────── דפדפן הנציג (CoachCard) ──────────┐
│ remote-audio (לקוח) ─┐  מקטעי 5ש׳ webm/opus  │
│ מיקרופון (נציג) ─────┴─→ POST /api/coach/calls/:id/audio   [1] קליטה
│ הדמיה: טקסט → POST /api/coach/calls/:id/segments             │
└───────────────────────────────────────────────┘
        ↓ STT (OpenAI whisper-1, שרת, האודיו לא נשמר)
   CoachSegment {speaker=customer|agent, text, source}  ← זיהוי דובר לפי הערוץ (לא ניחוש)
        ↓ הלקוח סיים משפט ("trigger")
   CoachSession: סיכום מתגלגל + 10 השורות האחרונות + ליד + 3 תוצאות קודמות + 5 הודעות WhatsApp   [2] הקשר
        ↓
   שליפה: דוגמאות מאושרות של העסק (embeddings / מילות מפתח) + התנגדויות מהידע העסקי               [3] ידע
        ↓ קריאה אחת ל-LLM (Anthropic, JSON מובנה, נתוני לקוח בתגיות = נתונים בלבד)                  [4] המלצה
   CoachRecommendation {objection, sayNow, why, confidence, basis, sources, latencyMs}
        ↓ dedupe (אותה התנגדות) / supersede (השיחה התקדמה)
   CoachCard (poll 2ש׳): מצב · התנגדות · "מה לומר עכשיו" · למה · מועיל/לא/דלג/הסתר
```

אחרי השיחה: `call.ended` → `learnFromCall` (LLM מחלץ רגעים עם ציטוט מילולי → `CoachExample` במצב "ממתין") · `deal.won/lost` → `attachDealOutcome` (תיוג התוצאה על הדוגמאות של שיחות אותו לקוח). מנהל מאשר/עורך/פוסל; רק דוגמאות מאושרות נשלפות.

עלות ושהייה נמדדות לכל סשן (`tokensIn/Out`, `sttSeconds`, `costUsd`, `latencyMs` = מסיום משפט הלקוח ועד יצירת ההמלצה) לפי מחירי מחירון (ניתנים לעריכה ב-env).

## 3. בידוד עסקים ואמינות
- כל הטבלאות תחת הקשר עסק + RLS ב-PostgreSQL (מיגרציה `20260925130000_sales_coach`). שליפת דוגמאות, ידע, תמלולים והמלצות – רק לעסק הנוכחי (נבדק).
- תמלול ו-WhatsApp נכנסים לפרומפט בתוך תגיות עם הוראה מפורשת שהם נתונים; תגיות סוגרות מוסרות מהטקסט; מחירים/תנאים רק מ-`<approved_knowledge>`; רשימת טענות אסורות.
- כשל ספק: הסשן מסומן `unavailable`, הכרטיס מציג "לא זמין", השיחה והחייגן ממשיכים.
- ההמלצות מוצגות לנציג בלבד; האודיו לא משתנה ולא נשמר.
- ללא מפתחות: הכרטיס אומר בדיוק מה חסר. ספק מדומה (`COACH_PROVIDER=mock`) קיים לבדיקות בלבד ומסומן "ספק AI מדומה".

## 4. מה נדרש להפעלה אמיתית
| הגדרה | מה זה נותן |
|---|---|
| `ANTHROPIC_API_KEY` | המלצות בזמן אמת + חילוץ למידה (`COACH_LLM_MODEL`, ברירת מחדל Haiku 4.5 בגלל השהיה) |
| `OPENAI_API_KEY` | תמלול חי של מקטעי האודיו מהדפדפן (whisper-1) + embeddings לשליפה דומה; בלעדיו – קלט הדמיה בלבד ושליפה במילות מפתח |
| `TELEPHONY_PROVIDER=telnyx` + מפתחות Telnyx | שיחה אמיתית עם אודיו בדפדפן (בהדמיה אין אודיו) |
| הגדרות → מאמן AI → "מופעל לעסק" + ידע עסקי | בלי ידע מאושר ההמלצות מסומנות "ידע עסקי בלבד/ללא דוגמאות" |
| אופציונלי: "ללמוד גם מהקלטות" | תמלול הקלטות שמורות אחרי השיחה (עלות STT) |

## 5. תוצאות בדיקה
ראו סעיף "תוצאות" בסוף המסמך (מתעדכן).
