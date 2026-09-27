# CRM: dial attempts, transfer, follow-ups, "waiting for a call today"

Server logic lives in `src/lib/crm/lead-ops.ts`. Hooks are in the dialer (`src/lib/dialer/queue.ts`, `calls.ts`) and in `src/lib/crm/pipeline.ts`.

## Menu
- The side-menu item "לידים" is now called **CRM**. The route (`/leads`) and every capability are unchanged.

## Dial attempts
- **What counts:**
  - An attempt is an outbound call whose lead leg was actually dialed (`calls.lead_dialed_at`).
  - Each attempt is one `Call` row with a unique idempotency key. Replayed provider events only update that row.
  - A click that failed before the lead was dialed is not counted.
- **Attribution:**
  - Each call belongs to the contact's lead that was current when the call was placed.
  - Older calls go to the contact's first lead, which backfills existing leads from the call history.
  - Attempts live on the lead, not on the agent, so a transfer keeps them.
- **Where it shows:**
  - A "ניסיונות חיוג" column in the list, and the count plus last-attempt time in the lead card.
  - A click on the count opens the history: date, time, agent and result (`GET /api/leads/:id/attempts`).

## Transfer (managers)
- **How:**
  - From a row, the lead card, or several selected leads (`POST /api/leads/transfer`).
  - A manager's owner select also goes through the transfer.
  - Only an active user of the same business can be the target. A manager can pick only within their team.
- **Effects:**
  - The lead and its contact move to the new agent.
  - Open tasks and follow-ups move with the same times.
  - The lead is removed at once from the previous agent's personal queue, and locks they hold are released.
  - Other lists now prefer the new agent.
- **Enforced on the server:**
  - The previous agent loses the lead API, the contact card, the timeline, notes, editing, search and dialing.
  - The new agent sees the full history: calls and notes by earlier agents.
- **Audit:** `lead.transferred {from, to, by, at}`.
- **During a live call or a started attempt:**
  - The lead is marked pending (`leads.pending_transfer_*`) and nobody can dial it.
  - The transfer runs right after that call's outcome is saved, with a cron safety net.

## Follow-ups
- **Status and time:**
  - New status `follow_up` ("פולואפ"). Its time is one open callback task linked to the lead.
  - Choosing the status opens a date + time picker (business timezone) with an optional note.
  - The server refuses the status without a time (`follow_up_time_required`) and refuses past times.
  - A time outside the dial window returns `outside_dial_window` with the nearest valid time.
- **Edit and cancel:**
  - Editing cancels the previous task and moves the queue time. There is always exactly one schedule.
  - Cancelling (`DELETE /api/leads/:id/follow-up`) cancels the task, moves the lead to "contacted" and takes it out of the callback queue.
  - Leaving the status or closing the lead also cancels the schedule.
- **Without a time:** a follow-up with no time shows "נדרש תזמון" and is never auto-dialed.

## Dialer integration
- **Queue entry:**
  - The follow-up time is the earliest time the lead enters the queue.
  - It is synced as a `callback` row due at that time in the assignee's personal list (`syncFollowUpQueue`).
  - This happens on schedule, on transfer, and every time the dialer starts, so follow-ups set while the dialer was off enter on the next start.
- **Claim guards (SQL):**
  - Never before an open follow-up's time, and never a follow-up without a time.
  - Never a lead with a pending transfer.
  - A contact with open CRM leads is auto-dialed only by the owner of one of them, so unassigned leads are not dialed.
  - The same checks run again right before dialing (`assertDialAllowed`).
  - Parallel dialing is already prevented by `FOR UPDATE SKIP LOCKED`, the per-destination advisory lock and "one live call per number".
- **Priority, in the agent's dialer settings:**
  - "פולואפים לפני לידים חדשים" (`hot`) or "לידים חדשים לפני פולואפים" (`new_first`).
  - Inside the follow-up group, the oldest due time goes first. This applies to every strategy, including the business default as a tie-break.
- **After an attempt, when the outcome is saved:**
  - Callback: the new time replaces the old one.
  - Retry outcome: the follow-up moves to the retry time of the existing retry policy, so it does not loop.
  - Retries exhausted, or a manual call without a queue: the follow-up closes and the lead shows "נדרש תזמון".
  - Answered: the follow-up is done and the lead goes back to "contacted".

## "Waiting for a call today" (manager card on the CRM page)
- **What is counted:** open, non-DNC leads, each counted once in the total.
- **Categories:**
  - New leads with no attempt yet, of any age.
  - Follow-ups due today, including later today.
  - Overdue follow-ups from earlier days.
  - "Follow-up without a time" is shown separately and is not in the total.
- **Filters:**
  - The whole business (within the manager's scope), one agent, or unassigned.
  - Unassigned leads are counted and flagged, but are never dialed before assignment.
- **Consistency:** the card and the list filter (`/api/leads?waiting=…`) use the same function (`waitingToday`), so the numbers equal the lists.
- **Refresh:** automatic every 30 seconds and after every action on the page.

## Tests
- `tests/integration/crm-followups.test.ts` exercises real simulated calls. It covers:
  - Attempts are counted once.
  - Transfer access and queue.
  - Follow-up timing.
  - Both priority modes.
  - Reschedule, dialer off and live-call transfer.
  - The no-answer retry.
  - The waiting numbers match the lists.
  - Isolation.
- `scripts/qa-crm-followups.mjs` is the browser QA on production.
