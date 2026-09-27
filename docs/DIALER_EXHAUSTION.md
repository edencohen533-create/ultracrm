# Dial-attempt quota, empty queue and campaign switching

## Attempt quota → "לא רלוונטי"
- **The setting:** "מספר ניסיונות חיוג ללא מענה לפני העברה ללא רלוונטי". 0 = off, which is the default.
  - The effective value is the first one set: the agent (personal dialer settings), then the campaign, then the business (settings → חייגן).
- **What counts as an attempt:** only a real dial, meaning a Call row with `lead_dialed_at` (`attemptStats`).
  - Technical failures, dials cancelled before going out, a repeated idempotency key and duplicate provider events don't count.
- **When it's checked:** when an unanswered outcome (`no_answer`/`busy`) is saved, in the same transaction and under the per-lead lock (`src/lib/dialer/exhaustion.ts`).
- **Which leads are never moved:**
  - A lead that was ever answered.
  - A lead with a future follow-up, or in "פולואפ" status.
  - A lead that is "מתאים" (qualified), closed, or has a closed deal.
- **What happens when the quota is reached:**
  - The lead moves to `unqualified` and `leads.close_reason` is set to "מוצו ניסיונות חיוג".
  - All of its queue rows become `exhausted`.
  - A `lead.status_changed` event is emitted, so automations run, and the change is audited.
- **Display:** the table and the lead card show "attempts/quota". The reason is shown on the card and is cleared on a manual status change.
- **Changing the quota:** applies to future attempts only. For existing leads there's a preview (`GET /api/dialer/exhaustion`) and a manager approval of exactly those leads (`POST`), each one re-checked.

## No leads available
- **One filter for everything:** `queueFilter` in `src/lib/dialer/queue.ts` is the only definition of "dialable" and is used both for claiming and for counting.
- **States (`queueAvailability`):**
  - `available`.
  - `waiting`: future follow-ups or retries, or outside dialing hours. The next time is shown.
  - `exhausted`: nothing left to handle.
  - `blocked`: a paused campaign, a paused business, or no permission. The reason is shown and it isn't reported as "no leads".
- **Dialer behaviour:** when `next-lead` comes back empty, the dialer stops. It doesn't retry automatically and doesn't dial just to use up the quota. The agent sees `NoLeadsPanel`: the reason, the next time, and other campaigns open to them, with those that have available leads first. "עבור לקמפיין" goes through `POST /api/dialer/campaigns/switch`:
  - Permission is re-checked.
  - It's refused during a call or while an outcome hasn't been saved.
  - It only ends the current session. Dialing starts with "הפעל חייגן", and follow-ups and the previous campaign's queue rows are unchanged.
- **Follow-ups in another campaign:** when one comes due, a banner is shown with a link back (`DueElsewhereBanner`).

## Manager alert
- **Deduping:** `DialerQueueAlert` holds a single open row per agent and campaign, which is the dedupe state. A new alert is possible only after a lead has been claimed again.
- **Delivery:** the `dialer.queue_empty` event is handled in the events worker.
  - Recipients: the owner, plus managers whose scope includes the agent. Never another business.
  - Channels: in-app on the campaigns page, and WhatsApp to managers linked to the assistant (the existing `AssistantDelivery` mechanism, with dedupe).

## Campaign permissions
- **Settings:** "למי הקמפיין פתוח" = all agents, or specific agents (at least one; an empty selection doesn't mean "everyone").
- **Enforcement:** permissions are enforced when listing, when counting, on `GET /api/lists/[id]` (a gap that was closed), when starting a session, on `next-lead`, on a dial and on a switch.
- **Other agents' personal lists** are never shown.

Tests: `tests/integration/dialer-exhaustion.test.ts`.
