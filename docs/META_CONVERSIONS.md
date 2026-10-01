# המרות למטא – Conversions API

## Where
- דוחות ← שיווק ומכירות ← **"המרות למטא"** (`/reports/marketing/meta`).
- Access is the same gate as the marketing report: `crm.marketing_view` plus a business-wide data scope.
- Managing (connection, rules, retry) needs `crm.marketing_connect`.

## Connection (per business: `meta_capi_connections`)
- **Separate from the ads-reading connection** (`meta_ad_connections`, `ads_read`). Sending needs its own token: Events Manager → dataset → Settings → Conversions API → *Generate access token*.
- **Choosing the dataset:** it can be picked from the pixels of the connected ad accounts (`GET /act_{id}/adspixels`) or entered manually. Reading pixels does not grant sending.
- **Token storage:** sealed with `ENCRYPTION_KEY`. Only a hint (`…abcd`) is returned, and it never appears in logs.
- **Check:** `GET /{dataset}?fields=id,name` with the token. The result is set from Meta's real answer (`ok` / `revoked` / `error`).
- **Test event:** sent only with a Test Event Code. While the code is set, every event is sent with it (Test events), so there is no production signal.
- **Sending on/off:** allowed only after a successful check.
- **Graph version:** `META_GRAPH_VERSION` (default v25.0). Endpoint `POST /{dataset_id}/events`.

## Rules (`meta_capi_rules`)
- **Triggers:**
  - lead created;
  - lead → status (the business's own statuses, by id);
  - meeting scheduled / attended;
  - deal won;
  - payment confirmed;
  - custom contact field → value.
- **Optional conditions:** Meta campaign id (from the stored lead source), product, lead source.
- **Event types:**
  - Standard event (validated list: Lead, Schedule, Purchase, …).
  - Custom Event: English letters/digits/_, starts with a letter, ≤40 characters, not a standard name. This is our conservative rule; Meta doesn't publish an exact one.
- **action_source:**
  - `system_generated` = the CRM / Conversion Leads route: `custom_data.event_source = "crm"`, `lead_event_source`, and Meta's `lead_id` unhashed.
  - phone_call / chat / physical_store / email / other.
  - website and app are not offered: they need browser data the CRM doesn't have.
- **Value source:**
  - none / deal amount / amount actually paid / custom money field (+ currency) / fixed (+ currency).
  - Purchase requires a value.
  - "Includes VAT / shipping / discounts" is documented on the rule only. It is separate from report filters.
- **Templates:** Lead, Schedule, Purchase (confirmed payment), AppointmentAttended (custom), CRMQualifiedLead (custom).
- **Preview:** shows the event and the identifier field names only, never personal data.

## Queue (`meta_capi_events`)
- **Where events come from:** domain events (`lead.created`, `lead.status_changed`, `deal.won`, `appointment.scheduled`, `appointment.attended`, `contact.field_changed`) via the `meta.conversions` handler, plus a read-only scan of confirmed payments. The payment flow is untouched.
- **Snapshot at the time of the event:** `event_time` = when it happened; `value` / `currency` / hashed identifiers are fixed then. A retry sends exactly the same content.
- **Deduplication:**
  - A unique `(business, dedupe_key)` key per business.
  - A purchase is keyed by the deal, or by the payment when there's no deal. So close + payment, a re-save, a duplicate event, a retry or parallel workers never create a second Purchase.
  - `event_id` is stable: `purchase-deal-<id>` or `<Event>-<type>-<id>`.
- **Missing data:** `pending_data` with a reason, never an invented value. Once the data is completed, "נסה שוב" re-evaluates it with the same `event_id`.
- **Errors:**
  - Auth/permission errors set the connection to `revoked`, pause sending and keep events queued.
  - Temporary/throttle errors retry with backoff (1, 5, 30, 120, 360 minutes; 6 attempts).
  - Invalid → `failed` with a reason.
- **Expiry:** events older than Meta's 7-day window become `expired`.
- **Privacy:**
  - Contacts who opted out or are blocked are `skipped`.
  - Never sent: IP / user agent (never invented), call or message content, free notes, sensitive data.
- **Site Purchase:** "האתר כבר שולח Purchase" = one agreed source. A CRM purchase matching a store order (same contact, same total, ±48h) is `skipped`, with the order number as the reason.
- **Statuses shown:**
  - "התקבל ב-API" means Meta answered `events_received`.
  - Appearing in Events Manager and attribution to ads are **not** shown: there is no evidence for them in the API.
- **Corrections:** Meta does not allow deleting or correcting a received event; cancellations and refunds are not reversed there.
- **Cron:** `/api/jobs/meta-capi` every minute (payments scan + sending), and also right after a matching CRM change.

## Appointments (`appointments`)
- Lead card → "פגישות".
- Scheduling emits `appointment.scheduled` once per appointment.
- A new time is the same appointment (`appointment.rescheduled`, not mapped to Schedule).
- Attended / no-show / cancelled close it; attended emits `appointment.attended` once.

## Custom Conversions
Creating them by API needs `ads_management` on the ad account. The existing connection is read-only, so nothing is created automatically. The screen gives the exact manual steps in Events Manager.

## Needs a live Meta connection (not verified here)
- A real dataset token.
- Seeing test events under Events Manager → Test events.
- Match quality / diagnostics, which need extra permissions; the screen links to Events Manager.
- Turning a received event into an optimisable conversion: a Custom Conversion and campaign setup in Meta.
