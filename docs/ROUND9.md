# Round 9

- **Abandoned carts moved under אוטומציות.** Automations now has three tabs: rules and journeys, abandoned carts, and Webhooks & API. The old `/carts` address redirects.
- **Store API connection.** In the store setup, the manager enters the store's API details once. The system checks them and registers the webhooks in the store by itself (`src/server/services/store-api.ts`).
  - Shopify needs the store address (myshopify.com), an Admin API token and the API secret key.
  - WooCommerce needs the site address with a Consumer key and secret.
  - Keys are stored encrypted. Only public https addresses are allowed (`src/lib/safe-url.ts`).
- **Webhooks and API for Make and Zapier.** Screen: Automations → Webhooks ו-API.
  - Outgoing webhooks: pick the events to subscribe to. Each send is signed with `X-UltraCRM-Signature: sha256=HMAC`. It is retried up to 6 times, and there is a delivery log and a test button. Sending runs in the events cron every minute.
  - API keys: the key is shown once and only its hash is stored. Endpoints: `POST /api/v1/leads` (no duplicate open lead), `GET /api/v1/leads?since=`, `GET /api/v1/me`.
- **Dialer: "המשך לליד הבא".** After hanging up there is no documentation screen.
  - Unanswered call: the result is saved automatically, and the button appears right in the call strip.
  - Answered call: quick results (מעוניין, לא מעוניין, מכירה). "תיעוד מלא" opens the full form, for example for a callback.
- **Excel / CSV import in the CRM.** Map the columns, then assign to an agent or to automatic distribution. There is a preview and an error report. An existing contact with an open lead gets no duplicate lead; it is moved to the chosen agent instead.
- **The "קבץ" option was removed from the CRM.**
- **WhatsApp to the agent on a new lead.** Settings live in the "חלוקת לידים" tab: enable, choose an approved template, and each agent's personal phone.
  - It covers new leads, automatic distribution and transfers.
  - It needs an approved template, and there is no duplicate sending.
- **"ביצועי נציגים" report.** New columns:
  - Average talk time.
  - Response time to a new lead (median).
  - Leads not yet dialed.
  - Conversion from new leads.
  - Conversion from leads transferred from another agent.
  - Conversion from all leads.
  - Average deal value.
- **Deal closed.** The same window opens from the "הומר לעסקה" status, from "+ עסקה חדשה", and from "בוצעה מכירה" in the dialer.
  - It records products with quantity, price, purchase date and end date, the deal value and a note.
  - Saving creates a won deal and writes a note. The contact is marked as an existing customer and leaves the other dial lists.
  - The contact moves to the "לקוחות קיימים – חידושים" dial list. Their queue row becomes due on the product's end date, so that dialer calls only customers whose product has ended.
  - A new purchase settles renewals that were already due (up to 14 days ahead).

Tests: `tests/integration/round9.test.ts` (7/7), with external HTTP simulated. Browser QA: `scripts/qa-round9.mjs` (10/10 on production; `QA_ONLY=R9` runs one step).

Not verified against live services:
- Shopify and WooCommerce were verified with simulated responses only, not with a real store.
- Webhooks were verified against example.com.
- WhatsApp to agents was verified with the demo provider, not Meta.
