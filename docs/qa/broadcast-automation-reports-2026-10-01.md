# Broadcast, automation and reporting follow-up — 2026-10-01

## Changes
- Broadcast rows reserve consistent space for status/actions while letting long names wrap. Narrow containers stack metadata and actions.
- Table headings follow document direction; automation names wrap and switches/actions align with their headings. Narrow screens scroll the table internally.
- Confirmed opt-out variants, including “אל תשלחו לי הודעות יותר”, “אל תתקשרו אליי יותר”, polite requests and Hebrew diacritics, use the existing suppression/DNC workflow. Static-list removal follows the business’s existing remove-from-lists setting. Explicit negations are not removals; uncertain phrases retain manual review.
- Agent performance now shows telephony. WhatsApp performance has a separate protected tab. Legacy WhatsApp report URLs redirect to it; module and role checks remain enforced.

## Verification
- 215 unit tests passed across 31 files.
- 23 focused integration tests passed across 5 files, including actual inbound opt-out messages removing static list membership and creating suppression/DNC records.
- Type checking, lint (no errors; 5 existing warnings), production build passed.
- Browser checks with isolated local demo data: desktop broadcast/automation alignment, separate telephony/WhatsApp metrics without a channel selector, legacy redirect, and 390px responsive layouts without document horizontal overflow. Automation table uses internal horizontal scrolling.
- No live customer messages or calls sent.

## Evidence
- automation-alignment-october.png
- broadcast-alignment-october.png
- whatsapp-report-tab-october.png

This follows the separately merged security audit in security-audit-2026-10-01.md. Tests provide coverage, not a guarantee of zero bugs.
