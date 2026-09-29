# Central do-not-contact – 2026-09-29

A person who asks to stop being contacted is blocked **per business**, on every channel and every campaign or list of that business:
- auto-dial;
- manual dial;
- WhatsApp;
- SMS;
- marketing email.

Nothing is shared between businesses.

## Source of truth

The existing `Suppression` ledger (`src/lib/suppression.ts`), mirrored into the dialer's `DncEntry` list.

Each row holds:
- the normalized identifier (E.164 phone or lower-cased email);
- `contactId`;
- `kind`: `unsubscribe` | `do_not_call` | `wrong_person` | `unclear` | `complaint` | `unsubscribe_link` | `manual`;
- `source`: the channel;
- `reason`;
- `evidence`: the exact message text;
- `messageId`: the triggering message;
- `createdAt`;
- the review state and the revocation details.

A request is applied to **every** phone and email of the contact.

## What an inbound message means (`src/lib/contact-requests.ts`)

Messages are classified by context, not by a single word. The same rules apply to WhatsApp and SMS.

| Customer writes | Result |
|---|---|
| "הסר", "STOP", "תפסיקו לשלוח", "תמחקו אותי", "אל תשלחו לי יותר הודעות" | unsubscribe: marketing and automatic outreach stopped, number added to DNC (no calls) |
| "אל תתקשרו אליי", "תפסיקו להתקשר" | same as unsubscribe (kind `do_not_call`) |
| "מספר שגוי", "זו טעות, אני לא האדם שאתם מחפשים" | wrong person: **everything** blocked, including service messages |
| "זו טעות", "לא מעוניין", "למה אתם שולחים לי?" (weak signal only) | held for review: automatic outreach, campaigns and auto-dial are paused. Manual dial is still possible. A manager confirms (which adds DNC) or dismisses with a documented reason |
| "יש טעות בחשבונית", "טעיתי בשעה", "אל תסירו אותי" | nothing |

## Enforcement (server side)

- **Messages:**
  - `sendBlockReason` is checked when a message is created, and again right before the provider call in every worker: campaigns, events, sequences, channel sends.
  - Automated sends are refused for anyone with an active request, whatever the message category.
  - A manual reply to a message the customer sent is still allowed, unless the case is wrong person.
- **Calls:** `callBlockReason` runs:
  - on every dial (manual, preview, power);
  - again when the lead leg is actually dialed (a request that arrives while the agent leg connects stops the call before the customer's phone rings);
  - in the WhatsApp-availability "call now" path.
- **Dial queue:** `queueFilter` never pulls a contact that meets any of these conditions:
  - it is blocked;
  - it has a DNC number (primary **or** additional phone);
  - it has an active request on any of its identifiers.
- **Pending work is cancelled when the request arrives:**
  - queued messages;
  - campaign recipients;
  - sequence runs;
  - automation events;
  - dial-list rows (set to `dnc`);
  - callback tasks.

  Calls already in progress are not hung up.
- **Nothing bypasses the block:**
  - The block is stored per identifier.
  - A duplicate card that shares a phone (as an additional number) is blocked too.
  - A re-import, a status change or a list move does not touch the ledger.
  - The number format does not matter: every entry point normalizes to E.164.

## UI

`ContactBlockNotice` explains the block: what the request was, the channel, the date, what is blocked, and who can lift it. It appears in:
- the contact card (the "call" button is disabled);
- the conversation;
- the dialer lead card.

## Lifting

Only a manager who can see the contact can lift a block, and only with documented renewed consent (at least 5 characters).
- The rows are **revoked, not deleted**, so history is kept.
- The DNC entries are removed.
- An audit entry `contact.resubscribed` is written.
- There is no automatic expiry.

## Essential service messages

There is currently no receipts or transactional flow in UltraCRM, so no exemption was added.

Until one exists:
- a service message can only be a person's manual reply;
- automated sends of any category are blocked.

If receipts are added later, they need their own explicit category that marketing templates or automations cannot use. Otherwise the exemption becomes a bypass.

## Tests

- `tests/unit/contact-requests.test.ts` covers the classification: phrasings, "טעות" in another context, negations, and weak signals.
- `tests/integration/do-not-contact.test.ts` (real DB) covers:
  - an unsubscribe while a message, campaign, sequence, dial-queue lead and callback are queued;
  - "don't call me";
  - wrong number;
  - "טעות" in context and the review flow;
  - a duplicate card;
  - a re-import;
  - a local number format;
  - an additional phone;
  - two businesses;
  - lifting with evidence and audit.
- `scripts/qa-do-not-contact.mjs` is the browser check: the notice on the contact card and in the conversation, desktop and 390 px RTL, then lifting it.
