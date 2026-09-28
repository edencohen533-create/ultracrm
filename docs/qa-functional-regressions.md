# Functional regression checks

Run these against an isolated, seeded local PostgreSQL database and a local production build. Never point QA seed/load scripts at production. The browser scripts below only accept localhost/127.0.0.1 and create demo records.

## Automated checks

```sh
npm test
npm run test:integration
npm run lint
npm run build
```

## Browser workflows

Seed the demo owner, manager and agents using the repository seed. Configure mock telephony, numbers and messaging providers; use an isolated local database, local application URL and local test secrets. For coach testing set `COACH_PROVIDER=mock`, `COACH_ALLOW_MOCK_IN_PRODUCTION=1` and `COACH_ALLOW_SIMULATION_INPUT=1` in the local environment. Do not enable those simulation switches in a live deployment.

Start the production server, then run sequentially (they mutate the same demo business):

```sh
node scripts/qa-functional-core.mjs http://localhost:3109
node --import dotenv/config scripts/qa-campaigns.mjs http://localhost:3109
node --import dotenv/config scripts/qa-coach.mjs http://localhost:3109
```

Core results/screenshots are saved under `.qa-local/functional-core`; campaign and coach screenshots under `.qa-local/functional`. Each script reports a nonzero exit code on failed checks. Browser core verifies persisted API state as well as rendered controls. It covers contact create/edit/custom fields, tasks/notes, lead creation, deal dates, CSV quoting, mock inbox drafts/replies, suppression/re-consent, failed loads, concurrent settings saves, tenant switching and viewport overflow.

Coach tests create a fresh answerable contact and feed both sides of a simulated conversation: learning correctly requires an agent response, not just a customer objection. Campaign tests create eligible recipients and wait for completed preflight before sending. These checks do not validate a live provider connection.

## Latest local evidence (2026-09-28)

- Unit/components: 104 tests in 20 files passed.
- Integration: 306 tests in 42 files passed in one full run.
- Build/TypeScript passed; lint had no errors and 127 existing warnings.
- Core browser workflows: 15 passed. Campaign wizard: 13 passed. Coach workflow: 8 passed.
- Local authorization sweep: 294 requests refused; tenant/agent isolation: 43 passed.
- Local recovery checks: 13 passed; post-load invariants: 14 passed.
- Two businesses / ten agents: 1,081 requests, zero technical errors, 61 mock calls, peak ten live calls. p50/p95/p99: 28/78/243 ms. No valid CPU/RSS measurements; not a production capacity claim.
- Installed dependency audit: zero reported advisories.

Legacy QA scripts may assume older labels/forms or pre-existing demo state. They are not all green and must not be treated as exhaustive certification. Remaining gaps include live providers, production infrastructure/recovery, sustained capacity, other browsers and full accessibility/security testing.
