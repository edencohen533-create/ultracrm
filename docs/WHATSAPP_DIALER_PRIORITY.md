# WhatsApp → dialer: "זמינה עכשיו"

When a customer the dialer is working (an outbound call in the last 14 days, open lead) replies on WhatsApp about availability, her lead owner's dial queue updates by itself.

## Flow
1. The incoming message raises `message.received`, which runs the handler `dialer.whatsapp-availability` (`src/lib/events/handlers.ts`) → `handleInboundAvailability` (`src/lib/dialer/availability.ts`).
2. **Intent detection:**
   - With `ANTHROPIC_API_KEY` set, AI reads the conversation context. Otherwise a conservative rule-based detector runs, where a negation always wins.
   - Intents: `now` / `later` (with a time) / `unavailable` / `do_not_call` / `unclear`.
   - Low confidence changes nothing in the queue. The message goes to the agent for review.
3. **What each intent does:**

| Intent | Result |
|---|---|
| now ("אני זמינה עכשיו", "אפשר עכשיו") | The queue rows become due now, and a `CallbackSignal` (status `active`) puts her at the head of the owner's queue. |
| later with an explicit time ("בעוד חצי שעה", "מחר בעשר", "מחר בשלוש אחה״צ") | A follow-up in the business timezone. A newer request replaces the previous one. |
| later without a time, or an ambiguous time ("אחר כך", "מחר בשלוש") | For the agent to review. The agent confirms "now" or picks a time. |
| unavailable ("אני לא זמינה עכשיו", "בעצם לא עכשיו") | Cancels an active priority. Never prioritizes. |
| do_not_call | Cancels the priority and goes to the agent for review. Nothing is added to DNC automatically. |

## Prioritization
- `claimNextLead` sorts first by the time of the owner's active signal, oldest first. That puts her ahead of new leads and follow-ups.
- A live call is never interrupted. She is simply the next claim.
- **Dialer on (power, idle):** `DialerProvider` dials her automatically in turn.
- **Dialer off or paused:** a banner at the top of the screen with "חייג עכשיו". The dialer is never started automatically.
- **Nothing is bypassed:** DNC, opt-out, a closed lead, a pending transfer, permissions, the dial window and attempt limits all apply.
  - The check uses the dialer's own filter (`queueFilter`).
  - If she can't be dialed, the signal becomes `ineligible` with the reason, and the agent sees it.
- **No duplicates:**
  - Uniqueness per `messageId` (idempotent).
  - One active signal per contact.
  - The dialer's lock (`FOR UPDATE SKIP LOCKED`) prevents parallel dialing.

## Validity
- `availableNowTtlMinutes` (settings → חייגן, default 15). After it passes, the job `/api/jobs/events` marks the signal `expired`, and the agent sees "לא טופל בזמן".
- A dial attempt (outcome saved) marks it `handled`. From there the outcome decides.
- Manual cancel: "בטל עדיפות" in the banner.
- The whole feature can be turned off in settings → חייגן.

## Display
- **Banner** (`HotLeadsBanner`): tag, time, message, "פתח שיחה", "חייג עכשיו", "בטל עדיפות", confirmation for review items.
- **Tag** "זמינה עכשיו — התקבלה תשובה בוואטסאפ": in the dialer lead card, the leads table and the lead drawer.
- **Timeline** entry "זמינות מוואטסאפ", plus audit `lead.priority_now` / `lead.priority_cancelled` / `lead.follow_up_from_whatsapp`.

## API
- `GET /api/dialer/hot`.
- `POST /api/dialer/hot/:id` with `{action: cancel | ack | confirm, now? | date+time}`.
- The data is also in `/api/dialer/state` (`hot`).

## Migration and tests
- Migration: `20260928180000_callback_signals`, with RLS.
- Tests:
  - `tests/unit/availability-intent.test.ts`
  - `tests/integration/whatsapp-dialer-priority.test.ts`, including the acceptance test.
