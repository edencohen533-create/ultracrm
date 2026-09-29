# Dialer: automatic documentation and in-call payments – 2026-09-30

## Call documentation

**Nothing blocks the next call:**
- The "השיחה ממתינה לתיעוד" bar is removed.
- The server no longer refuses a call, session, next lead or campaign switch with `outcome_required`.
- Instead, `autoFinalizePendingCalls` closes calls left without a result, through the regular `saveOutcome` path, so queue, retries, follow-ups and exhaustion work unchanged.

**What the automatic result is set to:**
- According to what the provider reported: busy → "תפוס", not answered → "אין מענה".
- Answered → a new result, `answered` "ענה – תועד אוטומטית":
  - The row in the queue is closed.
  - A CRM lead moves from "חדש" to "נוצר קשר". Nothing is guessed, such as "interested".
- The result form stays available, marked optional (for a follow-up, a sale or a block).

**AI documentation** (`documentCall`, on `call.ended`):
- **Claim per call:** duplicate events and double retries do not run twice.
- **"done" only together with the stored documentation.**
- **When a model is configured and fails** (error / invalid format), or there is no transcript: `failed` with the reason. Nothing is marked done, and the raw transcript is not shown as AI documentation.
- **Without a model at all:** the timed transcript is the documentation (source "transcript", shown as such).
- **In the call history:** "תיעוד AI בהכנה…" or "תיעוד ה-AI נכשל: … · נסה שוב" (non-blocking).
  - Retry via `POST /api/calls/:id/documentation`, for the agent of the call or a manager who sees them.

## Payment during a call

**Official documentation checked (Sept 2026) – PayPlus:**
- `PaymentPages/generateLink` with `api-key` + `secret-key` → `page_request_uid` + `payment_page_link`.
- `refURL_callback` is signed: `hash` = base64(HMAC-SHA256(secret, JSON)) and `user-agent: PayPlus`.
- `PaymentPages/ipn` returns the transaction status.
- Test environment: `restapidev.payplus.co.il`.

**Connection:** Settings → Connections → "תשלומים – ספק סליקה" (owner).
- PayPlus: API key, secret key and payment page UID. The keys are encrypted and never shown again.
- Or a sandbox provider, which never charges.
- Before this, UltraCRM had no payment provider at all.

**The "תשלום" button** is in the dialer screen and in the call bar. It opens a window over the call, with no navigation, so the call and its audio are not touched. It shows:
- The customer's details.
- A choice of product (with VAT), approved quote or open deal.
- The amount. Changing it needs the new permission "שינוי סכום בגבייה"; agents get only "גבייה מלקוח" by default.

**Payment itself:**
- Happens only on the provider's page, embedded in the window, opened in a new window, or sent to the customer on WhatsApp (within the 24-hour window).
- Card numbers or CVV never pass through UltraCRM, the logs, the transcript or the AI.

**Preventing a double charge:**
- One idempotency key per attempt, so a double click or a network retry returns the same request.
- An open request for the same customer + item + call is reused.
- One provider page per request.
- A notification is verified and then stored once (`PaymentEvent` unique on provider + event). A duplicate notification is ignored.

**Status:**
- Only a verified notification, plus a server-to-server check with the provider (`fetchStatus`).
- Plus a check of a pending request every ~10 seconds while the window is open (missed or late notifications).
- Closing the window changes nothing.
- A payment confirmed after cancellation is shown as paid, marked "אושר אחרי ביטול".

**Linking:**
- Customer, call, agent and the source (product / quote / deal).
- An audit entry: payment.requested / succeeded / failed / cancelled / link_sent.
- A receipt is shown if the provider returned a link. UltraCRM has no receipt mechanism of its own.

**Isolation:**
- The tables are under RLS by business.
- A notification is routed by the connection id and verified with that connection's own secret.
- Another business gets 404.

## Tests

- `tests/integration/dialer-autodoc-payments.test.ts` (6):
  - automatic closing of answered / unanswered calls when a session opens, with the lead status "נוצר קשר";
  - AI documentation: failure → failed (not done), duplicate, retry through the route → done, no transcript → failed;
  - payments: price with VAT, double click → one request, approval confirmed by the provider, duplicate notification ignored;
  - decline, forged signature (401), amount change without permission (403), late approval after cancel;
  - isolation between businesses, no card data in events, encrypted keys;
  - the PayPlus adapter against a faked API: the call, the headers, signature verification, status 000.
- `tests/integration/dialer-exhaustion.test.ts` was updated: switching campaigns after a call without a result is no longer refused (the call is closed automatically).
- `scripts/qa-dialer-payments.mjs` (browser, simulated telephony + sandbox), 8/8:
  - a call → "תשלום" → double click on create = one request;
  - closing the window during the call (the call stays, the request stays pending);
  - approval on the provider page → "שולם";
  - decline → "נכשל";
  - hanging up with no result → no bar, and a new session is not blocked.

## Not verified / limits

- **PayPlus against the real API:** no keys, and no real charge was made. Checked only against the documentation and a faked API.
  - The exact response fields of `PaymentPages/ipn` (the field names for the transaction / `status_code`) are not detailed in the documentation. The code looks for `status_code` "000" in several common locations.
  - It should be checked in the PayPlus test environment before going live.
- **Embedding the PayPlus page in an iframe** depends on PayPlus's headers. If blocked, "פתח בחלון נפרד" / "שלח ללקוח" work.
- **Cancelling a page at the provider:** no API for this was found in the documentation. A local cancel stops tracking, and a payment that arrives afterwards is shown as paid.
- **SMS for the link:** not supported (SMS requires an approved template). WhatsApp only.
