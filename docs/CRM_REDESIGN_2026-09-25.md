# CRM redesign and personal agent settings — 2026-09-25

Implemented from the supplied Hebrew screenshots:

- Leads: orange/white RTL layout, date/source/product/campaign/ad/owner/status filtering, sorting, page grouping, bulk selection and updates, scoped totals and owner distribution, new leads, deal conversion, call and WhatsApp actions. The dialer remains beside the lead table, movable between upper corners and expandable/minimizable.
- Lead drawer: editable contact/attribution fields, status and assignee, notes, call summaries, recordings and missed calls; existing authorized recording endpoint and chat composer.
- Reports replaced by agent performance: date/agent filters, CSV, funnel, live presence and call durations, sortable rows. Selecting an agent opens the call drawer with customer/campaign, listen and push-to-talk whisper. `/manager` redirects to reports; live-floor navigation removed. Monitoring APIs remain available for the integrated drawer.
- CRM settings: each agent can edit their own settings; managers can edit visible team members and owners everyone in their business. Blue tabbed editor follows the reference; settings persist on business membership (`User.crmSettings`), so the same account can have independent preferences in different businesses.

## Applied dialer behavior

Preferences remain absent until explicitly saved, preserving existing behavior for other agents. Personal strategies order actual queue claims. Retry phases distinguish new leads and follow-up cycles; due callbacks start a new cycle. Business/list attempt limits remain authoritative ceilings, and personal waiting intervals cannot shorten a configured interval. On exhaustion the queue item leaves automatic dialing; the contact and CRM lead are preserved. Technical failures before ringing do not consume either attempt counter.

The unanswered daily limit counts automatic calls to the same destination across the business, using business-local midnight. It is checked when claiming and again under the destination lock when dialing. Manual dialing retains existing rules. Number rotation uses enabled eligible numbers after the configured consecutive unanswered streak per agent/destination; random or ordered selection is supported. Explicit caller-ID and fixed campaign assignments take priority. Ownership verification, reputation review, DNC, daily usage and concurrency limits are retained.

Follow-up handoffs are opt-in, team-scoped and limited to accessible lists. Outcome saving can assign another eligible team member; manual taking moves the pending callback and associated open callback task atomically. General CRM access does not expand.

## Validation

- 149 integration tests passed (16 files), including 10 new personal-settings tests, 4 leads tests and 3 performance tests.
- 50 unit tests passed (9 files).
- Production build (`next build --webpack`) and TypeScript passed. Targeted ESLint has zero errors (existing/effect warnings remain).
- Browser: lead filtering/detail/edit note, floating dock sides, performance filter/export/old-page redirect, mobile overflow, agent/manager independent settings persistence, cancellation. Simulated call: lead table retained, manager listens, holds/releases whisper, closes drawer without dropping agent call, then agent hangs up and saves outcome.
- No real calls, paid number purchases, or external messages were used in validation. Real audio/recording playback still requires the connected provider.

## Deployment / external dependencies

Deployed to production on 2026-09-25 as `dpl_Be7ETCp8Fh5RhL9PmvpLwHusMu2a` (Vercel Ready). Production alias: https://ultracrm-edencohen533-9754s-projects.vercel.app. Production migrations successfully applied: `20260925160000_sequence_task_optional_template`, `20260925180000_agent_crm_settings`, `20260925181000_call_destination_history_index`. Migrations completed before the production deployment became ready. The last migration uses `CREATE INDEX CONCURRENTLY` and must not run inside a transaction.

No external advertising/order source was provided. Advertising spend, CAC, CPL and profit remain unavailable rather than fabricated. Revenue and conversions use authorized CRM deals. Source refresh reloads stored contact fields; it does not claim to synchronize an unconfigured advertising platform.

Production smoke checks: `/login` HTTP 200; `/api/crm-settings`, `/api/reports/agents` and `/api/leads` return 401 without an application session. Existing Vercel deployment protection remains enabled.
Production browser smoke: login email/password form rendered successfully with no JavaScript errors, using authorized Vercel access.

2026-09-25 production-alias correction: the user-facing https://ultracrm-eta.vercel.app still pointed at the morning deployment because the initial rollout used --skip-domain. Ran `vercel promote` for dpl_Be7ETCp8Fh5RhL9PmvpLwHusMu2a to move all production domains. Use ultracrm-eta.vercel.app for future production verification.
