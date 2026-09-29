# Sales development status — 29 September 2026

PR #17 (scheduled follow-up check-ins, unsupported AI requests and initial first-dial SLA) is merged into main. The additions below are implemented on `feat/sales-development`; this is not a claim that they are deployed in production.

| Accepted scope | Implemented in this increment | Remaining dependency or limit |
| --- | --- | --- |
| Fast lead response | Clock or business-hour SLA, overdue alerts, aggregate reporting, one guarded reassignment to a recently connected eligible agent when both the rule and ownership policy permit it | Existing business dial windows, without a separate holiday calendar; no automatic dial command. An unavailable recipient or required manager approval leaves an alert for manual handling. |
| Quote to payment | Server-priced immutable quote revisions, discount approval, expiry/revocation, bearer sharing links stored as hashes, single customer acceptance | Payment provider is not selected. Hosted checkout, verified payment/refund webhooks and a separate payment ledger are not implemented. Acceptance never sets a deal to paid. |
| Expert assistance | Agent requests an available authorized manager with a summary; manager receives it in the actual agent-performance screen, connects in listen mode, then explicitly speaks to both parties | Real Telnyx media acceptance test requires the business's live setup; local tests use simulation. Availability means a recent application heartbeat, not proof that the microphone is connected. |
| Approved commercial offers | Catalog items/packages, currency, tax, quantities, discount limits, exceptional approval, written terms, private cost and gross margin snapshots | Each catalog item can represent a package; no automatic product recommendation or invented AI pricing. |
| Shared closing page | Mobile quote, terms, confirmation, view/acceptance state, version-bound consent | Customer confirmation is self-declared, not identity-verified digital signature; online payment awaits provider. |
| Presales qualification | Manager-configured WhatsApp questions, actual inbound quotations saved with message evidence, structured handoff and lead-card answers | Requires the existing AI and WhatsApp connections. Voice presales remains future scope. |
| Answer-rate diagnosis | Last seven days versus prior seven, caller/source/local-hour breakdown, pre-dial failures separated, sample threshold, SLA summary | Descriptive signal, not a causal conclusion or verified spam reputation. Current stored source labels can change historical grouping. |
| Originating Meta ad | Encrypted owner-configured ad-account connection, account checks, ad text/image and permitted video source; explicit missing-ID/permission states | Live Meta permissions and tokens require account acceptance testing. Lead Ads and website integrations must submit numeric source IDs through the existing lead API/custom fields; direct Meta Lead Ads subscription/OAuth onboarding is not added. No inferred attribution from names/UTM. Dynamic/current creative may differ from the original impression. |
| Buyer decision-maker | Consent-based sharing of the same focused quote; accepting person's declared name/role/consent recorded | No automatic message or outbound participant call. Link possession grants viewing/acceptance; no internal costs or CRM notes on the public page. |

## Where users configure and use it

- **הצעות וסגירה** (`/sales`): catalog, quote revisions, approval and share links. Lead cards link directly to a selected lead's quotes.
- **עוזר AI → הגדרות**: up to eight presales questions, one per line; empty disables qualification. Existing channel, hours, human-takeover and reply-limit controls still apply.
- **עוזר AI → מנהל AI → כללים**: for example, `תתריע על ליד ללא חיוג ראשון אחרי 5 דקות בשעות העבודה`. Transfer must be requested explicitly, reviewed, and allowed by the ownership approval policy.
- **ביצועי נציגים** (`/reports`): expert requests and diagnosis. During an answered call the call bar offers **בקש מומחה לסגירה**.
- Internal AI can read the permitted sales catalog/quotes, lead ad and diagnostics. It cannot itself join a phone call, manage ad budgets or collect payment; its responses must distinguish those unsupported actions from missing account connections.

## Meta attribution contract

The existing `POST /api/v1/leads` accepts `customFields`. Submit `metaAdId` (or `ad_id` / `facebook_ad_id`) as a string containing the actual numeric ID. Optional `adset_id`, `campaign_id`, and `leadgen_id` are preserved in the lead's creation snapshot. A contact update never retroactively replaces an older lead's snapshot. Existing historical leads are not backfilled by guessing. The supplied IDs are not proof that a particular person saw a specific impression.

## Validation and rollout

- Isolated local PostgreSQL with runtime RLS: quote arithmetic/discount approvals, private cost isolation, cross-business access, concurrent acceptance, revocation/expiry, ad account/media checks, quotation evidence and takeover, expert ownership/expiry, source snapshots, SLA policy and deduplication.
- Scripted AI test goes through the customer service handler and saves structured handoff context. No real model or customer messaging is used by that test.
- Browser: catalog → exception approval → mobile public acceptance; agent cost isolation; missing attribution; agent request → manager listen → speaking → listen in telephony simulation. Six scenarios passed with external browser traffic blocked.
- Unit suite: 141 passed, including working-time boundaries and closed-day skipping. Full integration suite: 360 passed across 48 files. Production build succeeded. Targeted lint reported zero errors (five React/image warnings).
- Five additive migrations: sales catalog/quotes with RLS, supervisor enum values, encrypted Meta connection with RLS, quote cost snapshots, lead attribution JSON. Only the local QA database has been migrated here.
- Prior Vercel preview failure was `DATABASE_URL is required`. An isolated preview database/configuration must be supplied; production credentials were not copied into preview.

## Primary API references consulted

- [Telnyx supervisor role switch](https://developers.telnyx.com/api-reference/call-commands/switch-supervisor-role): monitor, whisper and barge.
- [Meta official AdCreative SDK model](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py).
- [Meta official Ad SDK model](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py).
- [Meta official AdVideo SDK model](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/advideo.py).

Referral acquisition, replacement of the existing work queue, another coaching module, appointment calendars and an unrelated general dashboard remain excluded. No government-security certification is implied by these changes or tests.
