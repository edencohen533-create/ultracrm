# העוזר האישי בוואטסאפ (WhatsApp AI assistant)

בעל העסק (או משתמש מורשה) שואל בוואטסאפ בעברית חופשית ומקבל נתונים אמיתיים מה-CRM. גרסה 1 היא לקריאה בלבד.

## Flow
1. **Link:** Settings → "העוזר האישי בוואטסאפ" → add a phone. A signed-in user gets a one-time 6-digit code.
   - The code is stored hashed and is valid for 15 minutes.
   - The owner can link any user. A manager can link only their own phone. Agents always get `own` scope.
2. **Verify:** the code must be sent **from that phone** to the business's WhatsApp number.
   - Until verified, the phone gets only "waiting for verification". It receives no data, whatever it claims.
3. **Inbound:** the Meta webhook (signature-verified) reaches `MetaWhatsAppProvider.handleInboundMessage`, then `handleAssistantInbound`, before any contact or conversation is created.
   - Unlinked or revoked phones continue to the normal inbox unchanged.
   - A retried webhook is processed once, because `assistant_messages.inbound_key` is unique.
4. **Answer:** `src/server/assistant/brain.ts`.
   - **LLM mode** (`ANTHROPIC_API_KEY`, model `ASSISTANT_LLM_MODEL`, default `claude-sonnet-5`) uses Anthropic tool-use over the read-only tools in `tools.ts`.
   - **Rules mode** (no key, or `ASSISTANT_PROVIDER=rules`) uses the deterministic Hebrew router in `router.ts`. It is also the fallback when the LLM fails.
5. **Reply:** `transport.ts` uses the business's existing WhatsApp connection.
   - Inside the 24h service window it sends free text.
   - Outside the window it sends only the approved template set in settings, and keeps the report as `pendingReport` until the owner replies.

## Data rules
- All numbers come from server tools with fixed Prisma queries; there is no free SQL.
- The business comes from the link row, never from the message. Scope comes from `visibleUserIds` of the linked user, or own-only.
- Metric definitions:

  | Metric | Definition |
  |---|---|
  | Closed deals | `status=won` with `closedAt` in the period |
  | Recorded revenue | Sum of the amounts of those deals |
  | Payments received | Not in the system. The assistant says so and never invents it. |
  | New leads | Leads `createdAt` in the period |
  | Close rate | Leads from the period that have a won deal |
  | Calls | Outbound with an agent leg; answered = `answeredAt`; average talk time over answered calls |
  | Untreated leads | Status `new` |
  | Overdue tasks | Open tasks with `dueAt < now` |

- Every answer states the period, computed in the business timezone (weeks start Sunday).
- A failed tool returns "not available". It is never shown as 0.
- Customer names and notes are passed as data, and the system prompt says to ignore instructions inside them. The model gets only tool results, never the database.
- Ambiguity asks a question first: several agents with the same name, or several customers matching.

## Reports and alerts (automations cron, every 2 min)
- The reports are a daily summary (time and days), a weekly summary (last 7 days), an untreated-lead alert (N minutes, only leads that crossed the threshold in the last 24h), and a sales-goal alert (daily or monthly).
- Recipients are the selected links. If none is selected, every active link with business scope receives them.
- Pause stops the reports, but questions still work.
- Each send is claimed once in `assistant_deliveries` with a unique key (e.g. `daily:2026-09-26:<link>`).

## Log and security
- `assistant_messages` records each request, the reply, the tools used, status, model and latency. It has no secrets and is protected by RLS.
- Linking, verifying and revoking are also written to `audit_logs`.
- Revoking takes effect on the next message: the phone becomes a normal contact.
- Version 1 has no write tools. To add approved actions later, add a tool with an explicit confirmation step in `tools.ts`.

## Tests
- `tests/unit/assistant-periods.test.ts` and `tests/unit/assistant-router.test.ts`.
- `tests/integration/whatsapp-assistant.test.ts` covers verification, dedupe, exact numbers, follow-ups, clarification, own and cross-business scope, failure not shown as 0, the scheduler with dedupe and the 24h window, and revoke.

## Needs a live setup
- A real Meta connection, and an approved one-variable template for messages outside the 24h window.
- `ANTHROPIC_API_KEY` for free-language understanding. Without it, rules mode answers the listed questions.
- In demo mode, test through the settings simulator.
