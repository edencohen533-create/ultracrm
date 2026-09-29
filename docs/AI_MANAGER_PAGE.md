# AI assistant → AI Manager page – 2026-09-30

What each section actually does, based on the code (`src/server/ops/*`, `src/app/api/ops/*`). The help texts on the page ("?") say the same, with nothing beyond it.

| Section | In practice |
|---|---|
| **AI Manager active** (`aiOps.enabled`) | `runOpsTick` checks the active rules in the automations cron, about every 2 minutes; "בדוק עכשיו" checks immediately. It creates recommendations, requests and alerts. When off: nothing new is created and no alerts are sent. Allocations already approved are **not** cancelled automatically. |
| **WhatsApp alerts and approvals** (`aiOps.notifyWhatsApp`) | Recommendations and requests are also sent to managers and agents with a verified AssistantLink. They can reply with the request number. Requires the WhatsApp assistant to be enabled. Limited to `maxAlertsPerDay` per day, with `cooldownMinutes` between alerts of the same kind for the same agent. |
| **Recommendations** (`pending_manager`, `needs_adjustment`) | Waiting for a manager decision. Approve (with an editable count), reject, or let it expire (never carried out). Approving a lead allocation sends a request to the agent; the allocation starts only after the agent approves. |
| **Open requests** (`pending_agent`, `waiting_connection`, `needs_attention`, `active`) | Waiting for the agent, waiting for them to connect to the dialer, an active allocation, a missed first-dial deadline. Can be cancelled; when it ends, distribution goes back to normal. |
| **Measured impact** | Per approved allocation ("momentum"): period, allocated / dialed / closed leads (observed). Comparison: the leads the same agent received in the 14 days before, and how many of them closed before it started. Percentages only from 20 leads; an empty state with no data. No control group, so a difference is never attributed to the AI. |

## Changes

- **Help ("?") next to each section:**
  - opens on click / tap / Enter / Space and closes on Escape or a click outside;
  - linked to its button (`aria-controls`);
  - placed inside the screen on a phone.
- **Switches (`OpsToggle`):**
  - they change on the first click, save once, and a click during the save does nothing;
  - clicking the label works;
  - on failure they go back to the real state and show "לא נשמר" plus a message;
  - they follow the server only when its value changes, never during their own save;
  - the state survives a reload.
- "המלצות" and "בקשות פתוחות" are now separate sections.
- Measured impact has a new design and a server calculation with a defined comparison (`overview.ts`).
- **Removed:** the "אבחון ירידה במענה ועמידה ביעד חיוג" panel (from the reports screen), including the "רענן אבחון" button, the `/api/sales/diagnostics` route, and the chat's `sales_diagnostics` tool.
  - The report metrics (outbound calls, answers, deals, talk time) are unchanged.
  - The server calculation `src/server/sales/diagnostics.ts` and its tests stay.
  - The first-dial deadline rule, its alerts and its log in AI Manager are not affected.
- The long "ללא מודל…" badge now wraps and no longer causes sideways scrolling on a phone.

## Tests

- `tests/unit/ops-toggle.test.tsx` (6):
  - one click / double click;
  - clicking the label;
  - server error reverts;
  - syncing with the server;
  - help by click and keyboard;
  - impact – empty state and small samples.
- `tests/integration/ai-ops-clarity.test.ts` (3):
  - saving and reading back the settings, an agent refused;
  - impact numbers and the comparison;
  - removal of the actions.
- `scripts/qa-ai-ops-clarity.mjs` (browser):
  - all 5 help icons by click and keyboard;
  - one click, save, reload;
  - a simulated server error;
  - measured impact;
  - a 390 px phone;
  - the reports screen without the panel.
