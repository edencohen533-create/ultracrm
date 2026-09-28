# "מנהל AI": operational AI layer

The AI assistant (עוזר AI) → **מנהל AI** tab, for owners and managers. Code: `src/server/ops/*`.

It connects the CRM, WhatsApp, the dialer and agent performance. It detects opportunities, recommends a concrete action, and executes it only by rules and approvals.

## What it's built on (existing mechanisms)
| Need | Mechanism |
|---|---|
| Events: new lead, WhatsApp, call ended, status, follow-up, deal | The event outbox (`src/lib/events`) and the automations job (every 2 minutes), where `runOpsTick` runs |
| Lead distribution | `pickOwner` (round robin / least loaded) under a per-business lock. A temporary allocation is a layer on top (`applyAllocation`) under the same lock |
| "Available now" from WhatsApp | `src/lib/dialer/availability.ts`: rule-driven validity, and the fallback when the agent isn't connected |
| Opt-out request | `suppressContact` (block + DNC, waiting for manager review) |
| Manager / agent WhatsApp | Verified `AssistantLink`s, `sendToLink` (24-hour window / template) |
| Lead view | The lead window and timeline (history, calls, messages, follow-ups, deals) |

## Numbers are computed in code (`metrics.ts`)
- **handled:** distinct leads the agent actually dialed. **answered:** answered dials. **wins:** won deals.
- **Close rate:** today vs. the personal average (30 prior days) vs. peers today on leads from the same sources. Source mix and lead age are shown too.
- **Confidence:** the Wilson lower bound of today's rate. "Hot" is declared only above sample thresholds (`minHandled`, `minWins`, `minBaselineHandled`). Otherwise it says **"אין מספיק נתונים"** with the reason.
- **Capacity (`agentCapacity`):** remaining shift minutes × handling pace (today, or the personal average), minus the existing load (untouched leads + follow-ups until the end of the shift).
  - **Unknown shift = not available.** Shifts are set in the team table.
- **The model** only adds a short interpretation to the numbers (when connected). It never produces numbers.

## Process: two-step approval
**ממתין לאישור מנהל → ממתין לאישור נציג → הקצאה פעילה → הושלם**, plus: rejected / expired / cancelled / not executed / needs adjustment.

1. **Detection:** a recommendation with evidence, the exact change vs. the regular distribution, the scope (number of leads / until the end of the shift), and the capacity.
2. **Manager approves (or edits: mode, count, campaign, source):** this approves a ceiling only. Nothing is assigned. There are three explicit modes:
   - **Extra leads beyond his regular share:** he keeps his turn and also gets leads from other agents' turns.
   - **Priority on the next leads:** the next N go to him.
   - **Weighted distribution:** X% of the next N.
3. **The agent is asked** on WhatsApp at their verified number, and in the app (a banner):
   - Possible answers: "כן" / a number / "לא היום".
   - Free text is parsed. An unclear answer gets a clarification request and assigns nothing.
   - No reply is never an approval. The request expires no later than the end of the shift.
4. **Execution only after the agent approves (≤ what the manager approved):**
   - Re-checks: the agent is active, has permission, has campaign access, is in the distribution, is under the load rule, and has capacity.
   - **If capacity changed while waiting → needs adjustment**, with nothing assigned.
   - Then: the allocation (and optionally existing leads **with no owner**; never another agent's leads).
   - "Approved" and "actually allocated" are shown separately. It is marked done only after the allocation.
5. **Return:** when the quantity is reached or the shift ends, distribution returns to the regular policy by itself.
   - Cancel stops the allocation. Leads already assigned stay with the agent.
6. **Tracking:** extra leads not handled in the last 90 minutes of the shift → one alert to the manager. Nothing is moved automatically.

Every transition is an atomic status change, so a second approval or reply does nothing. While waiting, the regular distribution keeps going with no reservation.

## Rules in free text (`rules.ts`)
- **Kinds:** `momentum`, `extra_leads_policy`, `availability`, `load_cap`, `approval_policy`.
- **Fields:** trigger, conditions, action, scope, validity, limits, approval.
- **Translation:** by the model when connected, otherwise by patterns.
- **Before activation:** a plain-language summary and targeted questions. A vague phrase ("חזק", "הרבה", "מעל הממוצע") gets a threshold proposed for approval, never an invented meaning.
- **Management:** edit in a form, set autonomy (insight / recommendation / automatic within limits), priority, pause, delete.
- **Default:** changing distribution and transferring ownership needs manager approval (`approval_policy`), which overrides "automatic".
- **Built-in rules** (visible and editable):
  - Approval policy.
  - Momentum (recommendation).
  - Extra leads with agent approval.
  - "Available now" (15 minutes).

## WhatsApp: approvals and separation
- Only verified numbers of the business (`AssistantLink`). A customer message never reaches the command parser. It can only trigger an approved rule, such as availability.
- **Manager:** `אשר 4821` / `דחה 4821`.
  - "כן" without a number acts only when there's exactly one open recommendation. With several, it asks which one.
- **Agent:** tied to the specific request (by code, or the single open one).
- **Anti-flood:** at most N alerts per day, plus a cooldown per agent and kind.

## "Available now" (in addition to what existed)
- **Validity:** taken from the rule.
- **Agent not connected to the dialer for X minutes:** an alert to the manager, or (by the rule) a proposed transfer to a connected, authorized agent. By default the transfer needs manager approval.
- **"אל תתקשרו":** goes through the existing opt-out mechanism, which blocks right away and waits for a manager's review.

## Log and impact
- **Log:** every stage is recorded: what was detected (the numbers), who approved and through which channel, what was executed, and each lead that was allocated (`ai_ops.lead_allocated`).
- **Impact:** a descriptive comparison of allocated leads (dialed / closed) against the personal average. It's explicitly labeled as no proof of causation, with no control group, and small samples are marked.

## If the model is unavailable
Everything works. Numbers, texts and rule parsing are done in code, and distribution continues as usual.

## Tests
- `tests/integration/ai-ops.test.ts` covers:
  - A small sample doesn't trigger.
  - An unknown shift gives an insight only.
  - An overloaded agent gets nothing.
  - The full flow: manager → agent "רק 3" → 3 extra leads on the real distribution → return to round robin.
  - A double approval executes once.
  - An expired allocation stops affecting distribution.
  - A capacity change gives "needs adjustment".
  - No reply gives "expired".
  - WhatsApp "כן" with two open recommendations doesn't act.
  - Free-text rules, the load rule, and isolation between businesses.
- Migrations: `20260928220000_ai_ops_manager`, `20260928223000_ops_dual_approval`.
