# Reports – redesign and period comparison – 2026-09-30

## Layout

The reports page (`/reports`, `ReportsOverview`) runs top to bottom:
1. **Filters and dates:** a period (today / yesterday / 7 / 30 days / this month / last month / custom), a comparison (previous period of the same length / custom range / none), agent, campaign and product. Product appears only when products exist.
2. **Key metrics:** answer rate, new-lead close rate, deals won, revenue.
3. **More metrics.**
4. **Daily charts:** outbound calls and deals won, current period vs comparison.
5. **Detail by agent:** the existing table, following the same period and agent. Its own period picker and funnel are hidden.

Built with the existing components (`Panel`, `Select`, the tokens), in Hebrew and RTL. On a phone the cards are one column, and each chart scrolls inside its own box.

## Calculation (`src/lib/reports/compare.ts`, `src/server/reports/comparison.ts`)

**Days and ranges:**
- Days are business-timezone days, from 00:00 to 00:00, and handle DST correctly.
- A period that has not ended is cut at "now" and marked "השוואה חלקית". The previous period is compared up to the same point in time.
- A custom range of a different length is marked "טווחים באורכים שונים".

**Each metric** shows the current value, the comparison value and the change.

**Change:**
- **Counts and amounts:** difference + relative %.
- **Rates:** percentage points separately from relative change.
- **Zero base:** "לא היה בתקופה הקודמת" / "ללא שינוי (0 בשתי התקופות)" / "אין נתונים להשוואה" – never an infinite %.

**Trend by meaning:**
- Response time and "never dialed" are better when lower.
- Talk time is neutral and is not coloured.

**Filters:** identical for both periods.
- Campaign – native for calls, and through the contact for leads and deals.
- Product – through `customFields.product` of the contact.

**A definition for each metric** is shown in a "?" next to it (click, keyboard, phone).

**Real data only:** calls with an agent leg, deals marked won (revenue in ILS only), leads created in the period.

## Permissions and isolation

- The routes require a manager and the telephony module.
- Every query includes `businessId` and the user's visibility (`visibleUserIds`) – aggregates too.
- An agent outside the scope → 403.
- Another business's campaign → 404.

## Removed

The "אבחון ירידה במענה ועמידה ביעד חיוג" panel no longer appears on the page. The same removal is in PR #28.

## Tests

- `tests/unit/report-compare.test.ts` (10):
  - day boundaries in Asia/Jerusalem, including DST;
  - previous period of the same length, partial period, different lengths;
  - zero base, points vs relative, direction.
- `tests/integration/reports-comparison.test.ts` (5) – known data:
  - a week vs the previous week: 6 vs 2 calls; the 23:59 call is included and the 00:01 call goes to the next day;
  - zero deals → "from zero";
  - agent filter;
  - an empty period;
  - isolation from another business;
  - an agent refused by the route.
- `scripts/qa-reports.mjs` (browser, 7/7):
  - order of the sections, no diagnostics;
  - percentage points;
  - partial comparison and different lengths;
  - definitions by click and keyboard;
  - agent filter;
  - a 390 px phone.
