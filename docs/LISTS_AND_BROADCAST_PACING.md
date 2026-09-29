# Lists administration, broadcast builder and WhatsApp pacing – 2026-09-30

## Dial lists (`src/lib/dialer/list-admin.ts`)

### Active / inactive

The switch is on every list card; the button also stays inside the list.

When a list is inactive:
- It supplies no leads. `claimNextLead` now refuses the list itself.
  - Before this change, only the agent-access check refused it.
  - A caller that skipped that check could still pull leads from an inactive list.
- It gets no automatically distributed leads:
  - AI allocation (`ops/engine`);
  - new-lead routing (`lead.created`).
- Reserved (`locked`) leads return to the queue.
- Open queue alerts are closed.

**Calls in progress are never touched.** The response reports how many there are.

Reactivating brings the queue back exactly as it was.

### Move leads

"העבר לידים" is on the card and moves all leads. "העבר לרשימה…" is on the selected leads inside a list. The target can only be a list of the same business.

**What moves with each lead:**
- The queue row keeps its id, so calls and tasks stay linked.
- It keeps its status, attempts, handling agent, schedule and DNC.

**A contact already in the target list is merged, not duplicated:**
- The stronger state is kept (DNC first).
- Attempts take the maximum; the handling agent is kept.
- Call and task history is re-pointed to the target row.
- The source row is deleted.

**Leads in a live call are not moved**, and they are reported.

An audit entry `list.leads_moved` is written.

### Delete list

The confirmation shows:
- the number of leads;
- open sessions;
- calls in progress.

To confirm, the user types the list name.

**The delete is refused while there is a live call.** Otherwise it:
1. ends open dialer sessions on the list;
2. deletes queue alerts;
3. clears the list from AI allocations;
4. deletes the queue rows and the list.

**What stays:** contacts, leads, calls, tasks and notes. Their list reference becomes empty.

**System lists** (personal follow-ups, existing customers) cannot be deleted; they can be deactivated.

An audit entry `list.deleted` is written.

## Broadcast builder

### Leaving the builder

The builder autosaves every change. So "leaving without saving" puts things back as they were:
- A new draft (created by "יצירת קמפיין…", `?new=1`) is deleted.
- An existing draft is restored to the exact state it had when opened (`POST /api/campaigns/drafts/:id/revert`):
  - the name, step and data are replaced, not merged;
  - a template copy or a DRAFT campaign created in the meantime is deleted;
  - a campaign already scheduled or sent is never touched.

When there are changes, a dialog offers "המשך עריכה" / "צא בלי לשמור" / "שמור וצא".

Defaults the builder fills in by itself (the only sender) do not count as changes. An untouched new draft is not kept.

### Logo

- In the builder, the "U" logo at the top right goes to the home screen, with the same protection.
- In the side menu, the logo now goes to `/`, which redirects by the user's modules. Before, it went to `/leads`, which is closed to users without CRM.

### Other changes

- The "קהלים ואנשי קשר" and "תבניות" shortcuts were removed from the broadcasts area. The pages stay in the main menu.
- The create button now names its channel: "יצירת קמפיין וואטסאפ" / "יצירת קמפיין SMS" / "יצירת קמפיין אימייל". It opens the builder on that channel.

## WhatsApp sending pace

### The setting

"שלח ל־X נמענים כל Y דקות/שעות":
- X is 1–100,000; the interval is 5 minutes to 24 hours.
- An invalid value shows an error on the spot and is not saved. The server validates it too (`throttleSchema`).
- Estimated finish = the maximum of:
  - the user's pace;
  - how long Meta's limit takes, for the recipients above the remaining capacity.

### Server enforcement (`src/jobs/campaign-runner.ts`)

The durable server queue is cron-based. It was already in place and was extended:
- **Pace:** recipients claimed within the current interval are counted.
- **Meta limit (official docs, Sept 2026):** unique users per 24 hours, per business portfolio. Tiers: 250 → 2,000 → 10,000 → 100,000 → unlimited.
  - It is read from `whatsapp_business_manager_messaging_limit`. The code now requests this field, falling back to the deprecated field.
  - Every contact that got a template in the last 24 hours is counted, conservatively. A contact already counted does not use the limit again.
  - A connection that did not report its tier gets 250, Meta's minimum.
  - The simulation has no limit.
- **Hitting the limit:** the campaign stays RUNNING with the reason "מגבלת Meta…" and continues automatically when capacity frees up. The reason is cleared when sending resumes.
- **User pace above the limit:** the lower one applies.

**Unchanged and still active:**
- pause / resume;
- controlled retries for transient failures, with backoff and at most `MAX_AUTO_ATTEMPTS`;
- a rate-limit answer from Meta pauses the campaign for the rest of the run;
- a unique `requestKey` per attempt.

**After a crash:**
- A recipient stuck in "PROCESSING" for over 10 minutes becomes UNKNOWN. It is never sent again automatically.
- All other recipients continue.

**Right before each send**, the runner checks again:
- the block (suppression / do-not-contact);
- consent;
- a blocked contact;
- new: the recipient's phone is valid. An invalid one becomes SKIPPED with a reason.

## Tests

- `tests/integration/lists-campaign-pacing.test.ts` (6):
  - deactivating while a dialer session runs (a live call, a reservation, claim refused, reactivation);
  - moving selected and all leads (status, attempts, owner, DNC, call history, merge, live call, another business);
  - deleting (name, live call, sessions, what is kept, system list);
  - leaving without saving (restore, audit);
  - Meta limit (already-messaged contacts do not count, reason, continues when it frees up);
  - invalid number, pause / resume, crash without a double send, completion.
- `scripts/qa-lists-campaigns.mjs`, browser (8): switch, move, delete with count and name, button per channel, no shortcuts, leaving a new draft / continuing to edit / logo / an untouched draft, restoring an existing draft, pace validation and saving.

## Not verified

- Actually reaching Meta's limit on a real account.
- Whether Meta counts messages inside the customer service window. The code counts them too, so it is more conservative than required.
