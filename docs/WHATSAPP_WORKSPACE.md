# WhatsApp workspace – 2026-09-29

## 1. Creating a lead from the WhatsApp assistant (`src/server/assistant/create-lead.ts`)

Example: "תוסיף ליד: דנה כהן, 0501234567, מגנזיום, מקור פייסבוק".

**Who can use it**
- Only a phone with a verified `AssistantLink` of this business.
- The user needs the `crm.create` permission.
- A customer who writes the same text is an ordinary inbox message; they never reach the command.

**How the text is read**
- Fields can be labeled ("טלפון …", "מוצר …", "מקור …") or plain comma-separated parts, in any order.

**When something is missing**
- The assistant asks one focused question. Order: name, then a valid phone, then product, then source.
- Product and source may be answered "אין"; they are then left empty.
- "בטל" drops the draft. A draft expires after 30 minutes.
- An unrelated question drops the draft and is answered normally.

**Product matching**
- The product is matched against what the business already knows: coach knowledge products, items that were sold, and earlier leads' products.
- Several matches: the user picks one.
- No match: the user's own words are kept.

**Source**
- A general source ("פייסבוק") is stored only as the lead source.
- No campaign or ad is derived from it: `sourceAttribution` stays null.

**Checks before saving**
- The phone is normalized.
- Block list: DNC, a do-not-contact request or a blocked contact means no lead is created, and the reason is given.
- An existing open lead (in any number format) is not duplicated; the reply links to it.
- A contact owned by another agent is not touched.
- The lead goes through the existing assignment rules (`lead.created` → `pickOwner`).

**Idempotency and confirmation**
- A retried webhook is dropped by the inbound key, and the message key is remembered as well.
- The confirmation (details and a link) is sent only after the lead is saved.
- An audit entry `assistant.lead_created` is written.

## 2. Customer file next to the conversation (`customer-file-service.ts`, `contact-profile-panel.tsx`)

**Layout**
- Fixed on the conversation's side (the left side in RTL) from the `lg` width.
- On narrower screens, a "תיק לקוח" button in the conversation header opens a drawer.
- Loaded per conversation and keyed by it, so switching threads never mixes customers.

**Contents**
- **Lead:** owner, status, source, product, campaign, ad, created date.
- **Purchases:** won deals and their items (quantity, price, service end date).
- **Open opportunities:** open deals, shown together with purchases when both exist.
- **Store orders:** converted or recovered carts.
- **Documents:** files (PDF and similar) from this customer's conversations that the user can open, served by the existing scope-checked `/api/attachments` route.
  - View only; nothing is re-sent to the customer.
- A missing value is shown as "חסר".

**Visibility**
- Without `crm.view`, or for a contact that belongs to another agent, only the contact identity is shown.
- Leads and deals follow the owner scope, like the contact card.

**Receipts**
- There is no receipt source in UltraCRM (no accounting or payment integration).
- Receipts appear only if they were exchanged as files in a conversation.

## 3. Interface

- The internal notes bar in the conversation was dark (`dark:bg-amber-950`, a bordeaux color). It is now white with dark text.
- The WhatsApp area lists WhatsApp threads only; "כל הערוצים" is gone.
  - Users with the SMS or email module get a WhatsApp / SMS / email selector, with no mixed view.
- The navigation item is renamed "שיחות וואטסאפ".
- Contacts: a "WhatsApp" button next to "חייג" (`POST /api/contacts/:id/whatsapp`) opens this contact's latest thread that the user can see, or a new empty one.
  - Opening a thread sends nothing.
  - With no valid number, or when the contact is fully blocked, the button is disabled and the reason is shown.
  - With a marketing-only block, the thread opens for manual replies.
- The conversation header no longer makes the whole page scroll sideways on a phone.

## Tests

- `tests/unit/lead-command.test.ts`: parsing and product matching.
- `tests/integration/whatsapp-workspace.test.ts` (6 tests):
  - lead from free text, right business, assignment, link, no campaign or ad;
  - retried webhook;
  - focused questions and choosing between several products;
  - "אין" answers and "בטל";
  - duplicate in another format, block list, a customer can't run the command;
  - customer file (all sections, no mixing, restricted views, other business);
  - WhatsApp button (reuse, other agent's contact, blocked).
- `scripts/qa-whatsapp-workspace.mjs`: browser check on desktop and 390 px.
