# Journey builder & free-text automations

## Save actions
| Action | New journey | Active journey |
|---|---|---|
| יציאה ללא שמירה | Asks to confirm if anything changed | Same – the live version is untouched |
| שמירה | Creates a **draft** (`status=draft`, `isActive=false`) – never runs | Saves `draft` only; the published version keeps running |
| שמירה והפעלה | Checks → approval → publishes version 1 | Checks → approval → publishes version N+1 |

Pause / resume is explicit in the automations list (`POST /api/sequences/:id/status`). Pausing stops new runs and runs in progress.

## Versions and runs
* Every publish writes a `SequenceVersion` (definition, checks, who approved, when) and an audit entry `journey.published`.
* A run pins the version it started with (`sequence_runs.version_id`) and finishes on it; new events use the new version.
* Activation applies to **new events only** – there is no backfill on existing contacts (the approval dialog states this and requires ticking it).

## Pre-activation checks (`POST /api/sequences/checks`, re-run on publish)
Schema & required fields · permissions per channel · package + active provider connection per channel · approved templates · static lists · loops (a TAG_ADDED journey re-adding its own tag) · double sends (same template < 60 min apart).
Also shown: external actions, a 30-day audience estimate, cost notes, and the running-runs policy.
Engine guards that were already in place: a unique run key per event (duplicate events start one run), sequence-originated messages never start another sequence, `MAX_AUTOMATION_DEPTH`, and consent / unsubscribe / frequency re-checked before each send.

## Free text (`POST /api/automations/interpret`)
One engine (`src/server/automations/translate.ts`) serves both the journey builder and the single-rule dialog.
* With `ANTHROPIC_API_KEY` set, the model proposes JSON restricted to the engine's triggers and actions. Unknown actions and template ids are dropped into "not supported". Without the key, a conservative Hebrew parser runs instead.
* Output: `definition` (a draft), `questions` (e.g. which template to use – never guessed), `unsupported` (never drawn as a node), `related` (existing settings that already do this: lead distribution, the "available now" rule), and a `summary` written in code.
* "תיקון הטיוטה הנוכחית" sends the current draft along; only what the text changes is replaced.
* Nothing the model writes is executed: the definition goes through `sequenceSchema` and the checks above.

## Simulation (`POST /api/sequences/simulate`)
Walks the steps for test data or a real contact (read-only) and explains each decision (condition held / not held, blocked, no template). Nothing is sent.
