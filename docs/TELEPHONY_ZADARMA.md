# Zadarma as a backup for Telnyx

Research and implementation 2026-09-29. **Conclusion: partial backup – outbound only, reduced call control, blocked until a live test on a real account passes.** Nothing here was run against a real Zadarma account (none is connected); all Zadarma HTTP traffic in the tests is intercepted.

Status labels: **documented** (official Zadarma page) · **verified by test** (our tests, mocked HTTP) · **needs provider answer** · **not supported** (the docs say so, or there is no API for it). Missing from the docs is not treated as "not supported".

## 1. Capabilities and requirements

| Topic | Finding | Status | Source (checked 2026-09-29) |
|---|---|---|---|
| Account | Natural person or legal entity; registration by email. | documented | zadarma.com/en/legal/terms-of-use/ |
| Documents | Tied to numbers, not the account: passport/ID, registration certificate, proof of address. | documented | zadarma.com/en/support/faq/virtual-numbers/documents-to-connect-number/ |
| SaaS for several businesses | Terms 12.6: reselling without an agreement with the sales department is prohibited. 3.4(b): no "auto-dialling forbidden by acting legislation". A reseller programme (sub-users, per-user API keys) exists. | documented / **needs provider answer** (is our use allowed, reseller approval) | legal/terms-of-use; zadarma.com/en/support/instructions/api/partners/ |
| Israeli numbers | Mobile 055 $3/month · geographic 02/03/04/08 and national 077 $4.5/month · toll-free 1809 $12/month. **072/073 are not listed.** | documented / 073 **needs provider answer** | zadarma.com/en/tariffs/numbers/israel/ |
| Number requirements | Company certificate or ID + current address. 2 concurrent lines per number (more for a fee). Active once the documents are verified. | documented | same page |
| Porting to Zadarma | "Port that number to Zadarma for free". Process and timeline are not documented. | documented / **needs provider answer** | tariffs/numbers/israel/mobile/ |
| External number as caller ID (e.g. the Telnyx number) | `PUT /v1/sip/callerid/` accepts "confirmed or purchased" numbers, but the extension-level method says "purchased numbers". There is no documented procedure for confirming Israeli numbers. | **needs provider answer** | zadarma.com/en/support/api/ |
| Does a verified caller ID route inbound calls? | No documentation says so. Inbound follows whoever holds the number. | **needs provider answer** (expect: no) | – |
| Dial model | `GET /v1/request/callback/` `from` (extension) → `to`. Rings `from` first, then `to`. Returns `{status, from, to, time}` with **no call id**. | documented | support/api/ |
| Agent audio in the browser | Official WebRTC widget: `get_key` (sip = extension, 72 h) + `loader-phone-lib.js` / `loader-phone-fn.js` from my.zadarma.com. It is a floating widget, not an SDK. There is no documented public WSS endpoint for SIP.js. | documented / WSS **needs provider answer** | support/api/; support/instructions/crm-zadarma/ |
| Hangup / hold / transfer / DTMF / conference / listen / whisper through the API | No such endpoints. Phone codes only: `#101#` transfer, `000n#` conference, `007`+extension then 4/5/6 = listen/whisper/barge. | **not supported via API** | support/api/; faq/pbx/dtmf/, /conference/, /supervisor/ |
| Webhooks | NOTIFY_OUT_START / OUT_END / RECORD. Fields: pbx_call_id, internal, destination, disposition, duration, is_recorded, call_id_with_rec. `zd_echo` URL check. Suggested IP range 185.45.152.40/30. | documented | support/api/ |
| Webhook signature | Header `Signature` = base64(hex(HMAC-SHA1)) of internal+destination+call_start (RECORD: pbx_call_id+call_id_with_rec), keyed with the API secret. **No timestamp.** | documented, **verified by test** (independent vector) | support/api/ |
| Do callback calls produce NOTIFY_OUT_*? How do we correlate them? | Not documented; there is no request id. | **needs provider answer** – the live test proves it per account | – |
| Webhook retries and ordering | Not documented. | **needs provider answer** | – |
| API auth | `Authorization: key:base64(hex(hmac_sha1(method+params+md5(params))))`. | documented, **verified by test** | support/api/ |
| API limits | 100 requests/min; 3/min for statistics methods; 429. | documented | support/api/ |
| Concurrency | Virtual PBX 5 channels by default (plans raise it); Israeli number 2 lines; Office IL plan 10 outgoing channels. | documented | faq/pbx/what-for-can-be-used-external-lines/; tariffs/plans/office/israel/ |
| Lookup after a timeout | `GET /v1/statistics/pbx/` (sip, destination, pbx_call_id). Zadarma advises against polling it. | documented (weak: no reference, 3/min) | support/api/ |
| Recordings | Per extension, default on. `GET /v1/pbx/record/request/` call_id + lifetime 180 s–60 days. `DELETE` supported. 200 MB free storage; recording is $2/month per extension beyond the first 5. | documented | support/api/; faq/pbx/how-to-record-calls/ |
| Prices to Israel | Landline $0.024–0.04/min, mobile $0.04–0.12/min, depending on plan and caller ID. Billing increment not found. | documented / increment **needs provider answer** | zadarma.com/en/tariffs/calls/israel/ |

## 2. Chosen route and why it is partial

Compared with what the dialer needs:

| Our operation | Via Zadarma |
|---|---|
| Agent first, then customer | ✓ callback: agent's extension first (in the Zadarma widget), then the customer |
| Server-controlled conference / bridge | ✗ the bridge is inside the callback |
| Hang up from our UI | ✗ refused with a message; the agent hangs up in the widget |
| DTMF from our UI | ✗ from the widget only |
| Supervisor listen / whisper | ✗ refused (Zadarma offers only the 007 code from a supervisor's phone) |
| Recording | ✓ |
| Reconciliation after a timeout | ◐ statistics lookup; if it cannot be proven → settlement |
| Inbound | ✗ not implemented (it would need numbers held at Zadarma) |

A SIP trunk behind our own media server (e.g. FreeSWITCH) would restore full control, but it is an additional component outside this project. A callback is **not** presented as equivalent to the browser dialer: the UI and this document list what is missing.

## 3. What was implemented (files)

- `src/lib/telephony/zadarma.ts` – the adapter:
  - signed API client (RFC1738 query, HMAC-SHA1 hex→base64), timeout → `TelephonyRequestTimeout`;
  - error classes (auth / account / capacity / rate limit / outage);
  - callback dial;
  - statistics lookup, throttled to 1 per 25 s per business, which never claims "no call";
  - widget key; recording link and delete;
  - read-only check (balance, extensions, caller ID);
  - every unsupported action throws `TelephonyUnsupportedError` (409 `provider_capability_missing`).
- `src/lib/telephony/zadarma-webhook.ts` + `src/app/api/webhooks/zadarma/[account]/route.ts`:
  - per-business webhook URL; signature checked with that business's secret; `zd_echo` handled;
  - matching by extension + destination + 30-minute window, then by `pbx_call_id`;
  - de-duplication id `${event}:${pbx_call_id}:${call_start}`;
  - OUT_START = agent connected + customer leg id, deliberately **not** "ringing", so provider failures stay technical failures;
  - OUT_END = answered (from duration) + hangup; RECORD = recording;
  - provider failures (no money / limits / failed) feed the breaker; busy / no answer / wrong number never do.
- `src/lib/telephony/types.ts`, `classify.ts`, `registry.ts`: capabilities `dialModel`, `serverHangup`, `agentClient: "zadarma-widget"`, failure class `capacity`, per-business readiness.
- `src/lib/telephony/routing.ts`:
  - per-business eligibility: credentials, approved caller ID, extensions, passed check, **passed live test**;
  - daily backup call limit; capacity failover only when the business allows it;
  - both providers down → `503 telephony_unavailable` before anything is created;
  - switch alerts.
- `src/lib/telephony/breaker.ts`: anti-flapping – a re-trip soon after closing doubles the cooldown (up to 8×); failures arriving while open change nothing.
- `src/lib/telephony/alerts.ts`: manager alert on failover / recovery / breaker open. The switch log is the in-app record; WhatsApp goes to managers linked to the assistant; each alert is sent once.
- `src/lib/dialer/calls.ts`, `events.ts`, `monitor.ts`:
  - the callback provider dials the customer itself (no second dial);
  - reconciliation for callback: lookup after 60 s, settlement after 180 s, close after 3 h without an end event;
  - hangup / DTMF / monitoring refused with a reason;
  - the caller ID comes from the approved Zadarma account (never a Telnyx number through Zadarma);
  - the account's concurrent limit is enforced.
- `src/components/telephony/DialerProvider.tsx`:
  - loads the official Zadarma widget with the server-minted key;
  - the agent is told to answer and hang up there;
  - going back to Telnyx reloads the page (the widget cannot be unloaded).
- Data (migration `20260929210000_zadarma_backup`, RLS):
  - `telephony_provider_credentials` – sealed key and secret, caller ID and its approval, test numbers, concurrent limit, last check, live test;
  - `telephony_agent_endpoints` – agent → extension;
  - routing columns `backup_daily_call_limit`, `failover_on_capacity`; breaker `trips`, `closed_at`; switch log `notified_at`, `delivery`.
- Admin (Settings → Connections, owner only):
  - `src/components/telephony/ZadarmaSection.tsx` – capabilities table, write-only credentials, caller ID with source and explicit approval, approved test numbers, extensions, read-only check, live test to a test number only, webhook URL, prices with source;
  - API `/api/telephony/zadarma` (+ `/check`, `/extensions`, `/live-test`), `src/server/services/zadarma-admin-service.ts`.

## 4. Tests

Passed (local DB; Zadarma HTTP intercepted – **mocks, not a real account**):
- `tests/unit/zadarma.test.ts` (9):
  - API and webhook signatures against vectors computed independently in Python from the PHP samples;
  - disposition mapping;
  - capacity policy;
  - anti-flapping.
- `tests/integration/telephony-zadarma.test.ts` (11):
  - primary down → signed callback from the agent's extension with the approved caller ID, alert sent once;
  - webhook flow start / answered / end / duplicate / late / recording, with the recording link requested with the business's own key;
  - bad signature and cross-business posts rejected;
  - busy vs "no money" (technical failure, no attempt charged, lead back to pending, breaker opens);
  - hangup / DTMF / listen refused;
  - timeout → adopted from statistics, or settlement with no second callback;
  - both providers down → refused before any record is created;
  - concurrent limit;
  - two businesses in parallel on their own keys;
  - no live test → not eligible; the live test only to an approved number, passing on the end event;
  - controlled return to the primary.
- Regression: telephony-routing (14), rls, tenant-isolation, events, crm-followups, dialer-exhaustion, numbers, provider-webhook-reliability, whatsapp-dialer-priority, review-crm-regressions, followup-checkin, lead-response-sla – all passing; unit suite 161; tsc; lint 0 errors; `next build`.

**Not run:**
- any real Zadarma request;
- the widget registering and ringing;
- whether callback calls emit NOTIFY_OUT_* (the live test does this);
- webhook retries and ordering at Zadarma;
- inbound;
- real recording download;
- load.

## 5. What is needed to turn it on

From you:
1. A Zadarma account.
   - Ask their sales team whether multi-business SaaS use is allowed (or join the reseller programme), and confirm that auto-dialling is fine for your use.
2. An Israeli number at Zadarma (documents), or confirmation that the Telnyx number can be verified there as caller ID. Set it as the caller ID of the agents' extensions **in Zadarma**.
3. A virtual PBX with an extension per agent. Recording on if needed. WebRTC widget domain = `ultracrm-eta.vercel.app`.
4. In Zadarma → Integrations and API:
   - API key + secret;
   - PBX call notifications URL = the URL shown in our settings;
   - enable OUT_START, OUT_END, RECORD.
5. Test phone numbers you own.

From Zadarma (questions to send):
1. Do callback calls emit NOTIFY_OUT_*? Any way to correlate a request to its events?
2. Any API to hang up / hold / transfer a live call?
3. Is there a public WSS SIP endpoint, or is the widget's API supported?
4. Can an Israeli external number be verified as caller ID?
5. Webhook retries and ordering?
6. Porting from Israel: process and time?
7. Billing increment?

## 6. How to turn it on and off

On:
1. `TELEPHONY_ROUTING=on` in Vercel (already deployed code; off = unchanged behaviour).
2. Settings → Connections → Zadarma:
   - key, secret, caller ID + source → "Save and approve caller ID";
   - extensions; approved test numbers;
   - "Check configuration" (read-only) must pass;
   - "Run live test" – answer on your extension; it passes when Zadarma's end event arrives.
3. Telephony providers panel:
   - backup = Zadarma;
   - policy "Manual switch" for a pilot (or "Automatic failover" later);
   - daily limit; capacity failover on/off.

Off (any of these, immediate for new calls; active calls finish on their provider):
- policy "Primary only";
- or backup = none;
- or `TELEPHONY_ROUTING=off`.

To remove the account: delete its row – the secrets go with it – and delete the webhook in Zadarma.

## 7. Conclusion

**Partial backup, blocked in production until the live test passes.**

- **Outbound calls:** can continue through Zadarma when Telnyx fails. The agent works in Zadarma's widget, with no hang-up from our UI, no DTMF from our UI and no supervisor listening. Recordings, statuses, attempts and follow-ups stay consistent (tested with mocks).
- **Inbound calls:** not covered. Telnyx numbers do not receive calls through Zadarma, and Zadarma-held numbers are not routed by UltraCRM.
- **Caller ID:** customers see the number approved in Zadarma. Unless Zadarma verifies the Telnyx number, a customer's call-back reaches the Zadarma number, which UltraCRM does not route today.
- **Keeping the original number reachable** needs porting, carrier forwarding, or verification at Zadarma plus separate inbound handling.
