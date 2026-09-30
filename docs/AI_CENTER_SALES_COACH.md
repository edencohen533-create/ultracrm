# AI Center & sales coach

## Navigation
- The menu item "עוזר AI" is now **"מרכז ה־AI"** (`/ai`).
- Tabs: צ׳אט · מנהל AI · **שירות לקוחות** (was "ידע על העסק") · **מאמן מכירות** (new) · אוטומציות · הגדרות והרשאות.
- Old links keep working: `/ai?tab=knowledge` still opens the customer-service knowledge.
- Settings → "מאמן AI" now points to `/ai?tab=sales`.
- **Customer-service knowledge** (`knowledge_sources`) is not shared with sales by default. An approved source is used by the in-call sales assistant only when a manager ticks **"שיתוף עם מאמן המכירות"** (`sales_shared`). It is used as a *fact*, never as sales phrasing.

## Recordings (`/api/coach/recordings…`)
- **Upload:**
  - Chunked (2 MB chunks, up to 25 MB, the transcription limit).
  - Accepted types: MP3/M4A/WAV/OGG/WEBM. The type is checked on the bytes' signature, not only the browser's claim.
  - Stored per business in `sales_recording_chunks` with RLS.
  - Duplicates: the same file (sha256) is never stored or processed twice. A partial unique index enforces it; a deleted file may be uploaded again.
- **Pick an existing call:**
  - One sales recording per call; picking it again returns the existing one.
  - The audio stays at the telephony provider and streams through the server.
- **Background processing:**
  - Runs right after upload (`after()`) and from the cron `/api/jobs/sales-coach` every 2 minutes. That run also retries recordings that got stuck and re-checks deals waiting for payment.
  - Timed transcription (Whisper `verbose_json`), then structured extraction.
- **States:** מעלה / ממתין / בעיבוד / מוכן / ללא תמלול / נכשל, each with a reason.
  - "ללא תמלול" means no speech was found, so no insights and no model call.
  - A missing `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` marks the recording "נכשל" with that reason; it can be retried after connecting.
- **Re-processing:**
  - Retrying a failed recording is free.
  - A finished recording needs an explicit force (it costs transcription again). Pending candidates from it are replaced; approved knowledge stays.
- **Delete:** audio and transcript are removed, pending insights are removed, and approved insights are flagged "לבחינה מחדש".

## Insights (`sales_insights`)
- **Kinds:** opening, discovery, objection (+ what the customer said), offer, closing, improvement.
- **Kept with each insight:** the quote, the timestamp, and the source recording / deal.
- **Nothing is trusted as-is:**
  - The transcript is data inside `<transcript>` (sanitized per line). Instructions in it are ignored.
  - Risk flags come from the model plus code checks:
    - customer details (redacted in the text);
    - promises;
    - discounts / unusual prices;
    - prices.
  - Customer details block approval until edited.
  - Promises, discounts and prices need an explicit acknowledgement.
- **Review actions:**
  - approve;
  - edit, which creates a new version (`parent_id`/`root_id`, the old one becomes `superseded`);
  - reject;
  - remove from use;
  - restore an earlier version (as a new version).
- **Audit:** every action is logged (`sales_insight.*`).

## Learning from closed deals
- **Setting:** "ללמוד אוטומטית מהקלטות של עסקאות שנסגרו" (settings key `coach.learnFromRecordings`).
- **Condition:**
  - `won`: the deal's status is won, by its meaning, not its label.
  - `paid`: won **and** a `payment_requests` row with status `succeeded`, linked to the deal (`source_type=deal`) or to one of its calls. This only reads the recorded status; payment logic is untouched.
- **Calls included:**
  - Answered, recorded calls with the deal's contact.
  - From the lead's creation (or 30 days before closing if there is no lead) until 2 h after closing.
  - Calls linked to another lead of the same customer are excluded.
  - At most the 5 latest.
- **Result:**
  - Candidates go to the review queue.
  - `sales_deal_learnings` records the condition, the calls and the status: waiting_payment / queued / no_recordings / changed.
- **Auto-publish:**
  - Off by default.
  - When on: only the chosen kinds, only insights with no flag, only from deals that meet the condition.
  - Audited (`sales_insight.auto_published`) and revertible.
- **Deal changes:** a deal that leaves "won" (`deal.lost`, new `deal.reopened` event) sends auto-published insights back to review and flags everything learned from it.
- **Call documentation:**
  - Previously the same checkbox also fed call documentation from recordings.
  - That is now its own setting, `coach.documentFromRecordings`.
  - The migration copies each business's current value.

## In-call assistant
The "שאל את ה-AI" chat in the dialer now also gets:
- Approved sales insights, as **wording** ("ניסוח מוצע").
- Shared service sources, as **facts**. A fact is shown only when it cites a real approved source, with the source title; any other fact is dropped.

"Learning" means extracting and retrieving knowledge. No model is re-trained.

## Download recordings
One component, `RecordingDownload`, is used in:
- call history (table + drawer);
- the dialer lead card;
- the lead drawer;
- the customer timeline;
- calls inbox;
- the sales coach.

Rules:
- Every download goes through the server (`/api/recordings/:callId?download=1`, `/api/coach/recordings/:id/audio?download=1`).
- It needs `telephony.recordings` **and** the new `telephony.recordings_download`. Business managers get it through their template; owners always have it.
- Responses are `no-store`, and every download is audited (`recording.downloaded`). No public or permanent links.
- The component shows clear states:
  - still recording (`recording_pending`);
  - failed;
  - no longer kept, because retention now sets `calls.recording_purged_at`.
