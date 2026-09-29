# SaaS isolation audit – 2026-09-29

Scope:
- all 256 API routes;
- webhooks, cron jobs, queues, files, caches, secrets;
- the data layer (Prisma scoping + PostgreSQL RLS);
- roles (owner / manager / agent, team scope) and plan modules.

Three independent read-only audits, then fixes and tests.

## How isolation works (unchanged, verified)

- **Session and business id:** the business comes only from the signed session and is re-checked against the membership in the database on every request. The business switcher validates membership. A `businessId` sent by the client is ignored (proven by a test).
- **Two independent layers:**
  1. The Prisma extension adds `businessId` to every query on tenant models (`src/lib/db.ts`).
  2. Inside a business scope, each statement runs as the non-owner role `ultracrm_runtime` with `app.business_id` set per transaction, under RLS policies on every table that has `business_id` (`src/lib/db-rls.ts`).
- **Webhooks:** verified before any write – Ed25519 (Telnyx), HMAC (Meta, Shopify/WooCommerce, Zadarma per business), per-credential keys (SMS / email).
- **Secrets:** sealed with AES-GCM and masked in responses.
- **Files:** recordings and attachments are streamed through the server behind scope checks – no public buckets.
- **Cron:** every job requires `CRON_SECRET`.

## Fixed in this change

| Severity | Problem | Fix |
|---|---|---|
| CRITICAL | **Account takeover across businesses.** Business A could create an account for someone's email with a password A chose. When business B later added that email, B's user was attached to A's account, and A could log into B. The response also revealed whether an email had an account. | **Invites** (`src/server/services/invite-service.ts`, `/invite/[token]`, `/api/invite/[token]`, `/api/users/[id]/invite`). An owner never sets a password: the membership stays inactive until the person opens a one-time link (only its hash is stored, 7 days). An unclaimed account's password is set by the link holder, which revokes older sessions. A claimed account requires its own password. The response is identical for new and existing emails. Existing accounts are marked claimed by the migration. |
| CRITICAL | **A business could register or activate another business's phone number**, splitting or diverting its inbound calls. The duplicate check ran inside the caller's own scope. | Duplicate check across all businesses; activation requires verified ownership (real telephony); inbound routes only to a verified number held by the receiving provider; **database guarantee:** unique index on `phone_numbers(e164) WHERE is_active`. |
| HIGH | A (team-scoped) manager could create API keys / outgoing webhooks and export the whole business, bypassing `crm.export` and their team scope. | Keys and webhooks are owner-only. `/api/v1/leads` requires `crm.export` and applies the key creator's data scope. |
| HIGH | The public cart tracker (key in the site snippet) accepted requests without `Origin`, set marketing consent, and accepted any cart link (phishing relay, spam). | With a domain set, `Origin` is required. Consent is never taken from it (only from signed store webhooks). The cart link must be on the store domain. Rate limited per key and per IP. |
| HIGH | SMS threads were readable and sendable in the inbox without the SMS module / `sms.view`. | The inbox scope includes only channels whose module and view permission the user has (`auth()` → `buildConversationScope`). This covers list, read, send, tags, notes and attachments. |
| HIGH | An agent could open a conversation with (and so take over) any contact that had no conversation yet. | `startConversation` requires `canAccessContact`. |
| HIGH | Coach transcripts / knowledge had no telephony module check and no team scope. | `module: "telephony"` on all coach review routes; lists filtered to visible agents; `assertCanSeeUser` on single items. |
| HIGH | One global FIFO event queue: one business's backlog starved everyone else's events. | Fair share: the businesses with the oldest due events, an equal slice each, interleaved. |
| HIGH | Retention cron: one business's error or a timeout stopped retention and business purges for all others. | The purge of due businesses runs first; each business has its own try/catch; time budget; rotating start; `maxDuration`. |
| MEDIUM | Zadarma: recording lookups by id across businesses; the simulated-supervisor branch was reachable from a signed Zadarma event; event ids were global. | Recording ids must be unique to one call (re-binding refused); supervisor prefix only for the simulation provider; webhook processing inside `withBusiness`; event ids prefixed with the account. |
| MEDIUM | Any business owner could overwrite the platform-wide Telnyx account check (which gates real calls for all businesses). | Platform-level provider checks are platform-admin only. |
| MEDIUM | A team-scoped manager could edit / merge / suppress other teams' contacts and transfer other teams' queue leads. | `assertCanEditContact` applies `canAccessContact` to managers; `transferLead` checks the holder and the target against the manager's scope. |
| MEDIUM | Dashboard showed unassigned leads and the business-wide activity feed to scoped users. The AI toggle on a conversation had no module check. Agents received full phone-number rows (costs, provider data). Post-call WhatsApp was not scope-checked for managers. Managers could disconnect any WhatsApp number. | Owner scope and feed only for full-business users; `whatsapp.reply` on the AI toggle; agents get basic number fields only; `assertCanSeeUser` on post-call WhatsApp; disconnect is owner-only. |
| – | Telephony tables added in PRs #20/#21 were not in the Prisma tenant list (RLS still covered them). | Added to `TENANT_MODELS`. |

## Tests

- **New `tests/integration/saas-isolation.test.ts` (8)** – two businesses, owner / business manager / team manager / agents, all through the real route handlers with real session cookies:
  - Tampered ids: A's users (owner, manager, agent) get 404/403 on B's contact, lead, call recording, conversation and queue lead, and B's rows are unchanged.
  - A client-supplied `businessId` is ignored.
  - Roles: agent vs another agent's lead / contact / inbox takeover; team manager vs another team's contact and queue lead; manager cannot create API keys; agent cannot read the Zadarma account.
  - Modules: SMS threads invisible without the SMS module; coach refused without telephony.
  - Invites: the takeover scenario end to end – no chosen password, identical responses, the link holder claims the account and revokes older sessions, one-time link, the attacker's link needs a password they do not have.
  - Phone numbers: registration and activation refused, and the database index refuses a second active row.
  - Tracker: no / foreign `Origin` refused, consent and a foreign cart link dropped.
  - Fair queue: B's newest event is processed despite A's backlog.
- **Regression (local DB):** 19 + 15 integration files. All pass except `learn-from-conversation` (full-text search on the local embedded DB – it fails on unchanged code too). `sales-expansion` was fixed: its telephony mock predated `adapterFor`.
- **Unit and build:** unit suite 162; tsc; lint 0 errors; `next build`.
- **Browser:** invite created, link shown; accepted on a 390 px phone (Hebrew RTL, no overflow); lands inside the business.

## Not fixed yet (needs a decision or infrastructure)

1. **Production connects as the table owner (`neondb_owner`).** RLS applies only while a business scope is set (every request, and the webhooks that call `withBusiness`). Code that forgets the scope runs unfiltered at the database level; the Prisma layer still filters it for tenant models.
   - **Fix:** a dedicated login role without ownership / BYPASSRLS for the app, the owner for migrations only, and an explicit system role for cron / login.
   - This is a Neon + Vercel environment change, not code.
2. **Global unique keys** `TelephonyEvent(provider, providerEventId)`, `ProviderWebhookEvent(provider, eventId)`, `Message.inboundKey`.
   - Where a business controls its own signing key (mock SMS / email, Resend secret), it could pre-empt another business's event ids and get its real events dropped as duplicates.
   - It needs predicting provider ids.
   - **Fix:** include the credential / business in the key (migration + dedupe code changes).
3. **Link tables** (`contact_tags`, `campaign_recipients`, `distribution_list_members`) have RLS on one parent only. The app validates references by hand (`tenant-references.ts`).
4. **Policy details:**
   - The `users` / `accounts` policies let a business scope read `password_hash` of its members' accounts.
   - `support_requests`, `meta_deletion_requests` and the platform tables are writable by the runtime role.
5. **Per-business limits on shared resources:**
   - the login rate limit is per instance, in memory;
   - no rate limit on `/api/v1` keys;
   - no platform cap on dials per business on the shared Telnyx account;
   - no AI / STT spend cap per business.
6. **Cron fairness details:**
   - outgoing-webhook delivery has no per-business time budget and does not auto-disable failing endpoints;
   - the business runner shares one deadline across up to 25 businesses;
   - no per-handler timeout in the event worker (a hung handler still uses the tick; a timeout would need idempotent handlers first).
7. **Smaller role gaps:**
   - approving an AI action does not re-check the requester's current permissions;
   - campaign / draft lists without `?channel=` show every channel to a manager with one channel;
   - an agent can dial a contact by id without `canAccessContact`;
   - team-scoped managers can administer business-wide dial lists / DNC / scripts (acceptable only if "team" limits what they see, not what they manage).
8. **Invites need no email, by design today:** the owner hands over the link. With a platform email sender the link could be emailed to prove mailbox ownership.
