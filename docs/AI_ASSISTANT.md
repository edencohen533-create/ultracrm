# עוזר AI

A single menu item, **עוזר AI** (`/ai`), with four tabs: **צ׳אט**, **ידע על העסק**, **אוטומציות** and **הגדרות והרשאות**.
Knowledge, automations and settings are visible only to people who manage the assistant: the owner always, plus managers as the owner defines.

## What is enforced on the server (not in the prompt)

| Rule | Where |
|---|---|
| Every tool call re-resolves the role and visible users (`visibleUserIds`/`ownerScope`). An agent sees only their own leads. "אני מנהל" changes nothing. | `src/server/ai/tools.ts` (`visibleLead`, `toolsFor` re-checked on every call in `engine.ts`) |
| Actions are only `AiAction` rows. `auto` executes immediately, `approve` needs an explicit approval, `off` is refused. "Done" is claimed only when `status=executed`. | `src/server/ai/actions.ts` (atomic claim, requester or manager, audit) |
| Automations come from a fixed catalog only. They are saved inactive (draft), and activation needs approval of the exact version (`versionAt`); a version changed in between is refused. By default they apply to new events only; applying to existing records is a separate approval with a count. | `src/server/ai/automations.ts` → the journey engine (`sequence-service`) |
| Knowledge: new sources are draft and internal. Only approved sources are retrieved. The customer-service agent gets only approved sources marked "מול לקוחות". Retrieval is chunk-based (Postgres FTS) and filtered by business plus RLS. | `src/server/ai/knowledge.ts` |
| Links must be public https (SSRF guard, no redirects, 3MB). Files: PDF, TXT, MD, CSV or HTML up to 5MB. | `safeFetch`, `extractFile` |
| Keys never reach the model or the UI. Diagnosis findings are redacted (phone numbers, emails, tokens). | `diagnostics.ts` (`redact`) |
| Without `ANTHROPIC_API_KEY`: questions are answered in basic mode, actions show "נדרש חיבור", and the customer-service agent does not answer. | `engine.ts`, `service-agent.ts` |

## Chat

- **Internal chat:** app chat and verified WhatsApp links use the same engine. Each reply on WhatsApp starts with the business name. Actions awaiting approval are approved on WhatsApp by replying "אשר" and cancelled with "בטל".
- **History:** chat history is saved per user and only that user can see it, managers included. Tool results are never replayed from history; data is fetched again with current permissions, so after a transfer the previous agent does not see the lead.

## Customer-service agent (WhatsApp, inside the existing inbox)

- **Default and channels:** off by default. It is enabled per channel; "סימולטור הדגמה" is a test channel with no real sending.
- **Business hours:** when to answer and what to send outside them.
- **Limits:** a per-conversation hourly limit and a daily limit.
- **Tools:** approved customer knowledge, `order_status` and `handoff`.
  - `order_status` answers only when the order number belongs to the phone the customer is writing from.
  - There is no delivery status in the system, and the agent does not make one up.
- **Handoff:**
  - The customer asks for a human (a deterministic rule).
  - A topic defined by the manager comes up.
  - There is no answer in the knowledge base.
  - A limit is exceeded.
  - The result is `aiMode=handoff` with a reason and a summary, shown in the inbox bar.
- **Human takeover:**
  - "קח טיפול" in the inbox, or any human reply, sets `aiMode=human`.
  - Before sending, the bot re-checks `aiMode`, so there are no parallel answers.
  - "החזר ל-AI" returns the conversation to the bot.
- **One reply per message:** dedupe `svc:<messageId>`, and only the newest message in a burst gets a reply. Bot messages are labelled "🤖 נשלח ע״י נציג AI".

## Diagnosis and repair

- **Diagnosis tools:**
  - `diagnose_automation`: automation version, trigger event, conditions, run and log, template and variables, WhatsApp connection, opt-out and consent, delivery. It classifies the result as `not_triggered` / `skipped` / `failed_send` / `sent_not_delivered` / `delivered` / `scheduled`.
  - `diagnose_messaging`, `diagnose_lead` (queues, locks, transfers, follow-ups, DNC) and `diagnose_missing_lead` (within the user's own scope only; permissions are never widened).
- **Repair catalog:**
  - `relink_template`, `set_step_variable` and `retry_failed_run` require approval. `retry_failed_run` does not run if a message already went out.
  - `release_stale_lock` and `resync_followups` are limited repairs that run automatically when allowed.
- **Before and after each repair:**
  - It checks that nothing changed since the diagnosis.
  - After it runs, the automation is simulated without sending.
  - It reports three separate statuses: "ההגדרה תוקנה", "הבדיקה עברה" and "שליחה אמיתית טרם אומתה".
- **Code bugs:** evidence is collected as a bug report (`external`). Nothing is fixed from the chat.
- **Incidents:** every diagnosis is saved as an `AiIncident` with a status (אובחנה / נדרש אישור / בוצע ואומת / בוצע ממתין לאימות / נדרש תיקון קוד או טיפול חיצוני / הועבר למנהל).

## What is needed to go live

1. `ANTHROPIC_API_KEY` (optional: `AI_ASSISTANT_MODEL` / `AI_SERVICE_MODEL`) in Vercel. Without it the "נדרש חיבור" status is shown.
2. A real WhatsApp connection (Meta) for the customer-service agent. It should be tested first on the simulator and on a test number.

Tests: `tests/integration/ai-assistant.test.ts` (the model is stubbed, no real sending).
