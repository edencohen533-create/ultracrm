# Packages and permissions

Two layers, and both are required: **business entitlement** (what the business bought) ∩ **user permission** (what the business manager granted the user). Everything is decided in one place, `src/lib/access/engine.ts`, and anything undefined is denied.

## Modules and actions (`src/lib/access/catalog.ts`)
Only actions that exist in the product are listed:
- **CRM:** view, create, edit, export, lead transfer. There is no lead or contact delete endpoint, so there is no "delete" action.
- **Dialer:** use the dialer, change personal settings, manage team settings and campaigns, access recordings.
- **WhatsApp:** view conversations, reply, assign conversations, manage automations, prepare broadcasts, approve and send broadcasts.
- **SMS / email marketing:** view, create and edit drafts, approve and send campaigns.

Sending actions are separate from draft actions. A permission does not override quotas, send limits or approvals that already exist. Meta advertising is not in the system, so it is not shown.

## Data scope
Per user: personal / team / business. `visibleUserIds` (`src/lib/auth.ts`) uses the assigned scope, or the role when none is assigned. The existing lead-assignment rules stay in place: a lead transferred away from an agent is no longer visible to them unless their scope is wider.

## Where to configure

| What | Where | Who |
|---|---|---|
| Packages (modules, seats per module, measurable quotas), versions | `/platform` → חבילות | Platform admin |
| Assign a package to a business, add-ons / trials / temporary grants, access status | `/platform` → עסקים → ניהול | Platform admin |
| User permissions in any business | `/platform` → עסקים → ניהול → משתמשים | Platform admin |
| User permissions table (users × modules, seats) | הגדרות → מודולים והרשאות | Business owner / manager |
| Package overview + upgrade request | הגדרות → חבילה ומכסות | Business owner / manager (read-only) |

**Appointing a platform admin** (not possible from inside the app): `node scripts/set-platform-admin.mjs you@example.com`. Revoke with `--revoke`.

## Rules
- **Package versions:** editing a package creates a new version. Businesses stay on their version until the change is applied explicitly, with an impact preview.
- **Entitlement changes:** always previewed first, showing users who lose access, campaigns, journeys, inbox automations, the service agent and the dialer.
  - A seat overflow requires an explicit choice of who stays. Users are never picked arbitrarily.
  - A removed module is closed for users. Buying it again does not reopen it for anyone automatically.
  - Nothing is deleted. Running campaigns are paused and journeys skip the send step, checked again right before sending, so there is no double send. Active calls are not dropped.
- **No self-escalation:**
  - Nobody can edit their own permissions.
  - A manager edits agents in their scope only, and cannot grant actions or scope they don't have.
  - The owner always has everything in the package.
  - A business cannot change its own package. The old self-upgrade endpoint was removed.
  - The last active owner cannot be removed; this check is serialized with a lock.
- **Seats:** assigned under a per-module lock, so parallel requests cannot exceed the limit.
- **Access policy is separate from payment:**
  - Access status: active / trial / grace (with an end date) / suspended.
  - Payment status: `manual` means there is no subscription billing connection. It is shown as manual assignment and is never presented as verified.
  - For a future billing integration: set `billingStatus` / `accessStatus` only from verified events with dedup. Never grant access based on a "payment succeeded" page alone.

## Enforcement (all layers)
- **APIs:**
  - `withAuth({ module, perm })` covers every route, including an action derived from a URL parameter, such as the channel.
  - `organizationRequest(handler, need)` covers the inbox, campaigns and templates. For campaigns the need is derived from the campaign's or draft's channel (`src/lib/access/campaigns.ts`).
  - The business is always taken from the authenticated session. A business ID sent by the browser is never trusted.
- **Screens:**
  - The menu shows only what is allowed. Managers also see modules outside the package with a "לא בחבילה" mark.
  - `AccessGate` and `/no-access` handle direct URL access.
  - Home and the post-login redirect go to the first allowed screen.
- **Exports and downloads:** `crm.export`, `telephony.recordings`, and view permission on campaigns and attachments.
- **Background jobs:** campaigns (the channel's entitlement plus the creator's send permission), journeys (per step), WhatsApp inbox automations, the service agent, and scheduled reports.
- **AI assistant:** tools are filtered and checked again on every call. The rules fallback and the linked WhatsApp assistant check too.
- **External API (API keys):** acts with the permissions of the key's creator.
- **Existing users:** changes apply without logging in again, because each request reads the permissions from the database. Package data is cached for up to 5 seconds per server.

## Safe migration of existing users
- **Split of the old messaging module:** `messaging` became WhatsApp + SMS + email, with the same value.
- **Existing packages:** each became version 1, and the businesses were pinned to it. Nothing changed for them.
- **Users without explicit permissions:** derived from their role exactly as before.
  - Agents: CRM (view/create/edit, plus transfer if הרשאות allowed it), the dialer (use + personal settings), WhatsApp (view + reply). No SMS/email, because they never had those screens.
  - Managers: all actions, with data scope per the existing setting.
  - These users appear in the table as "מיפוי אוטומטי". An owner can approve the mapping, and any package change stores it explicitly first.
- **Businesses without a package** (8 at the time of the migration) keep the previous default (all modules). In `/platform` they are marked "נדרש שיוך חבילה".

## Migrations
- `20260928150000_plans_permissions`: tables, data conversion, RLS.
- `20260928160000_legacy_overrides_to_grants`: old overrides on a pinned business become add-ons.

Tests: `tests/integration/plans-permissions.test.ts`.
