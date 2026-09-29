# Telephony providers – primary (Telnyx) and backup

Status 2026-09-29. **Backup candidate: Zadarma – partial, blocked until a live test passes; see `docs/TELEPHONY_ZADARMA.md`.** Before it: The code is ready for one; the only adapters today are Telnyx (real) and the simulation (never used for real calls). Production runs in simulation because the `TELNYX_*` variables are not set, so **nothing below has been verified against a live Telnyx account.**

## 1. Existing integration (before this change)

| Layer | Where | How it depends on Telnyx |
|---|---|---|
| Outbound dial | `src/lib/dialer/calls.ts` → `TelephonyAdapter.dialAgent` | Call Control `POST /v2/calls` to the agent's SIP address `sip:<user>@sip.telnyx.com`, then (on answer) conference + `dialLead` |
| Agent audio | `src/components/telephony/DialerProvider.tsx` | `@telnyx/webrtc` SDK with a login token from `/api/telephony/token` (per-agent telephony credential) |
| Inbound | `src/lib/dialer/inbound.ts` | Number → business routing; `answer` + conference + agent leg |
| Webhooks | `/api/webhooks/telnyx` → `src/lib/telephony/events.ts` | Ed25519 signature, `telephony_events` de-duplication per (provider, event id), forward-only state |
| Recordings | `/api/recordings/[callId]`, retention cron, coach learning | `GET /v2/recordings/{id}` (10-minute signed URLs), delete on retention |
| Hangup / DTMF / supervisor monitor | `calls.ts`, `monitor.ts` | Call Control actions with `command_id` |
| Attempts / queue | `queue.ts`, `events.ts afterCallFinalized` | Technical failure before ringing → lead back to queue, attempt not counted |
| Numbers | `src/lib/numbers/*` | Telnyx number inventory / purchase / verification (one platform account) |
| Permissions | `withAuth` module `telephony` (+ `telephony.use`, `telephony.recordings`) | – |

Problem found: every action – including hangup, polling, DTMF, recordings and webhooks on an **existing** call – used the global default adapter, not the provider that created the call.

## 2. What was implemented

- **Provider interface** (`src/lib/telephony/types.ts`): `TelephonyAdapter` with `capabilities` (outbound, inbound, conference, supervisor, recording, AMD, DTMF, **agent client**, lookup by reference), `configStatus()`, read-only `verifyConfig()`, `agentAddress()`, `findLegByReference()`, `deleteRecording()`, `verifyWebhook()/parseWebhook()`.
- **Registry** (`registry.ts`): `adapterFor(call.provider)` for every action on an existing call; a test-only slot for fake adapters (refuses to run outside tests). A provider without an implemented agent client, not configured, simulation or test-only → **never eligible for real calls** ("not configured").
- **Calls are bound to their provider**: calls, events (an event is matched only to a call of the same provider – a foreign `client_state` is ignored), inbound, monitor, recordings, retention all use `adapterFor(call.provider)`. Outbound numbers are selected only from the call's provider (`selectOutboundNumber(..., provider)`).
- **Data** (migration `20260929200000_telephony_provider_routing`, RLS on every business table):
  - `telephony_routing` – per business: primary, backup, mode, manual switch, breaker thresholds.
  - `telephony_provider_health` – circuit breaker per business + provider.
  - `telephony_switch_log` – manual / automatic switches, policy changes, breaker open / close.
  - `call_attempts` – one row per provider request that may create a leg (business, call, leg, provider, account ref, `command_key`, provider leg / session ids, from / to, status, failure class, HTTP status, times). A `Call` keeps one provider for life.
  - `telephony_provider_accounts` – platform-level result of the read-only account check.
  - Secrets stay in server env; only non-secret account references are stored.
- **Routing** (`routing.ts`, feature flag `TELEPHONY_ROUTING=on`, default off = previous behaviour): `primary_only` (default) · `manual_backup` · `auto_failover`. The choice is made after all dial checks and reserves a breaker probe slot atomically (row lock).
- **Circuit breaker** (`breaker.ts`): threshold within a window → open; cooldown → half-open with N probe calls → closed; unreported probe slots are released after another cooldown.
- **Failure classes** (`classify.ts`): `provider_outage` (5xx, network), `account` (402 / 403 D-codes / 20100), `auth` (401), `rate_limit` (429 / 10011 / 90103 / D1-D3-D22), `invalid_request` (4xx – our request), `timeout`. Only outage / account / auth / timeout feed the breaker; auth and account trip it at once. **Busy, no answer and rejected are call results, never failures.**
- **Uncertain dials**: a timed-out dial is marked `uncertain` and **never re-sent** (Telnyx does not document `command_id` de-duplication for `POST /v2/calls`). Reconciliation waits for a webhook, then looks the leg up by our `client_state` (`GET /v2/connections/{app}/active_calls`). If it cannot be proven either way within 45 s, the call is closed (`provider_unconfirmed`), the attempt becomes `needs_settlement`, the lead's attempt is not counted and it is held for 60 minutes. The owner settles it in the admin panel.
- **No duplicate dials across providers**: the existing destination lock (`pg_advisory_xact_lock` on business + number) and the "number in a live call" check apply to calls on any provider; an uncertain call stays live and blocks the number. Idempotency keys stay per call.
- **Agent side**: the token is minted for the provider that will carry the next call and says which browser client it needs. The dialer sends the provider it is registered with; after a switch the server answers `409 agent_reregister_required` and the browser reconnects. A provider whose client is not implemented shows an explicit error – there is no silent fallback to Telnyx.
- **Webhooks**: stored before processing (existing), duplicates / late / reversed events are safe (existing), plus a replay sweep in the events cron for events stored but never processed, and a generic route `/api/webhooks/telephony/<provider>` for the next provider.
- **Admin** (Settings → Connections, business owner only): primary / backup, configuration vs account check vs real-call eligibility, breaker state, policy and thresholds, manual switch, dial attempts awaiting settlement, switch log. The end-to-end test (a real paid call) is listed as not run.

## 3. Telnyx requirements

"In code" = implemented in this repository. "Verified on the account" = **not verified for any item**: there is no Telnyx account connected (`TELNYX_*` not set in production). The admin panel's "Check configuration" performs the read-only checks marked ✓ once the keys are set.

| Requirement | Official source | In code | Checked by "Check configuration" |
|---|---|---|---|
| Call Control App (Voice API), `connection_id` for dials | developers.telnyx.com – `/v2/calls` (OpenAPI) | ✓ `TELNYX_CALL_CONTROL_APP_ID` | ✓ app exists / active |
| Outbound Voice Profile on the app (else 403 D38/D7) | support.telnyx.com/en/articles/4409457 | – | ✓ assigned |
| Numbers assigned to the Call Control App (inbound webhooks) | OpenAPI `/v2/calls`, phone numbers | numbers module | ✗ not checked |
| Webhook URL `…/api/webhooks/telnyx`, API version 2 | developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks | ✓ | ✓ URL + version |
| Webhook failover URL | same | – | – (it is a second delivery URL for the **same** provider – not a backup provider) |
| API key v2 (server only) | …/api-fundamentals/authentication | ✓ env only | indirectly (every check call) |
| Account level: Paid = 5 concurrent / 100 per day / 10 per hour; Verified needs KYC | …/account-setup/levels-and-capabilities/paid, /account-upgrade | – | ✗ **must be done in the portal** – a power dialer needs Verified |
| Balance | …/api-errors (20100) | failure class `account` | ✓ positive credit (amount hidden from business owners) |
| Allowed destinations (IL) on the profile (else 403 D13) | OpenAPI `OutboundVoiceProfile.whitelisted_destinations` | – | ✓ includes IL |
| Concurrent call limits (D1/D2/D3/D22) | …/sip-trunking/configuration/concurrent-limits | classified `rate_limit` | ✓ profile limit shown |
| Dial rate 30/s (429, 90103) | …/programmable-voice/dials-per-second-limit | classified `rate_limit`, no breaker trip | – |
| Israeli numbers (local/national/mobile), documents: registration certificate, address proof ≤ 3 months | support.telnyx.com/en/articles/5466651 | – | ✗ 073 availability **not confirmed** – check in the portal |
| Caller ID: a non-Telnyx number must be a Verified Number (else D51) | support.telnyx.com/en/articles/6790265 | numbers selected per provider | ✗ |
| WebRTC: per-agent telephony credential, JWT 24 h, refresh before expiry | …/voice/webrtc/sdk-commonalities, js-sdk authenticating | ✓ one credential per agent, token refreshed at 23 h | ✓ credential connection exists |
| Webhook signature Ed25519 on `timestamp|rawBody`, ±300 s | …/receiving-webhooks; telnyx-node `webhooks.ts` | ✓ raw body, 300 s window, dedupe by event id | – (unit-tested with a generated key) |
| `command_id` on call commands (60 s, per call) | …/voice-api-webhooks | ✓ on hangup / answer / DTMF / conference | – |
| `command_id` on Dial – semantics undocumented | OpenAPI `/v2/calls` | treated as **not** idempotent → no re-dial | – |
| Events at-least-once, out of order; retries on 408/429/5xx | …/webhooks fundamentals | ✓ dedupe, forward-only state, 500 on failure, replay sweep | – |
| Lookup after a timeout: `GET /v2/connections/{id}/active_calls` (+ `client_state`) | OpenAPI | ✓ `findLegByReference` | – |
| Recordings: `call.recording.saved`, signed URLs 10 min, 1-year retention, delete API, custom storage | …/storing-call-recordings; support 5377454 | ✓ streamed through the server on demand, deleted on retention | – |

## 4. Inbound vs outbound with two providers

- **Outbound**: a backup can dial only with caller IDs it owns or has verified. A Telnyx number cannot be presented through another carrier unless that carrier verifies it (and vice versa – Telnyx D51). Numbers are therefore selected per provider; the backup needs its **own** numbers (or verified caller IDs).
- **Inbound**: a number is routed by exactly one carrier (whoever holds it). A backup provider does **not** receive calls to Telnyx numbers. Options, all requiring arrangements with the carriers: separate inbound numbers on the backup; carrier-side forwarding from Telnyx to a backup number (only helps if Telnyx itself is up); porting (one carrier at a time). Nothing here is automatic.
- An **active call never moves** between providers (legs, conference and media live at the provider that created them).

## 5. Remaining direct dependencies on Telnyx (the backup would still depend on these)

1. **Browser client**: only `@telnyx/webrtc` exists. A backup needs its own client (its SDK, or SIP.js / JsSIP against its WSS SIP endpoint) – `agentClient` must be implemented in `DialerProvider.tsx` and added to `IMPLEMENTED_AGENT_CLIENTS`. Until then the backup is "not configured" by design.
2. **Agent identity**: `User.sipUsername` / `User.telnyxCredentialId` are Telnyx's. A second provider needs its own per-agent credential store (read through `agentAddress()`).
3. **Numbers module** (`src/lib/numbers/*`): inventory, purchase and ownership verification talk to Telnyx only.
4. **SMS** (`src/server/channels/sms/telnyx-sms.ts`) – a separate channel, not part of voice failover.
5. **Enum** `TelephonyProvider { mock, telnyx }` – a new value (migration) per provider.
6. **Setup screen text** in Settings → Connections is Telnyx-specific.

## 6. Connecting a second provider and enabling a real backup

1. Choose the provider (it must support: outbound PSTN dial with a status webhook, conference/bridge, a browser client, recording, lookup of live calls by our reference).
2. Account: KYC / business verification, Israeli numbers or verified caller IDs, allowed destinations incl. IL, concurrency and rate limits, balance.
3. Code:
   - add the enum value (migration),
   - implement `TelephonyAdapter` (+ `verifyWebhook` / `parseWebhook`, `verifyConfig`, `findLegByReference`, `agentAddress` with its own per-agent credentials),
   - add it to `BUILTIN` in `registry.ts` and to the provider enum in `/api/telephony/routing`,
   - implement its browser client in `DialerProvider.tsx` and add it to `IMPLEMENTED_AGENT_CLIENTS`,
   - point its webhooks to `/api/webhooks/telephony/<provider>`,
   - buy / verify its outbound numbers (`phone_numbers.provider = <provider>`).
4. Set its server env; run **Check configuration** for both providers (read-only).
5. End-to-end test (paid, manual, with consent): one outbound call through the backup with a test agent – audio both ways, hangup, recording, webhooks – then inbound if relevant.
6. Rollout: `TELEPHONY_ROUTING=on` in production (behaviour unchanged: every business stays `primary_only`) → one pilot business in `manual_backup` → `auto_failover` with conservative thresholds → others.

## 7. Tests

- `tests/unit/telephony-routing.test.ts` (11): failure classes, breaker transitions / probes / slot release, eligibility (simulation, unconfigured Telnyx, missing agent client), Telnyx signature (raw body, tampering, 10-minute-old timestamp rejected).
- `tests/integration/telephony-routing.test.ts` (14, real DB, fake providers – no real calls): flag off; primary-only outage (no switch, breaker opens); automatic failover (logged once) with the active call staying on its provider; busy / no answer / rejected never count; rate limit vs auth; controlled recovery with a single probe slot; timeout → uncertain → leg adopted by lookup, no redial on any provider, number blocked meanwhile; unprovable timeout → settlement, lead not charged and held, owner settles; duplicate / late / reversed webhooks and a foreign provider's event ignored; concurrent dials to one number → one call; re-register required after a switch; backup without agent client never used; manual switch logged; business isolation incl. RLS.
- Regression: RLS, tenant isolation, events, CRM follow-ups, dialer exhaustion, numbers, provider webhooks, WhatsApp→dialer priority, CRM regressions – all passing.
