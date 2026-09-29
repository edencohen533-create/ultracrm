# WhatsApp connection per business and template images – 2026-09-30

Checked against Meta's official documentation (September 2026):
- Embedded Signup **v4** (v2 is deprecated as of 15.10.2026);
- Graph API v25.0;
- Cloud API Media reference;
- Resumable Upload API;
- template components.

## Connection

UltraCRM connects each SaaS customer through **Embedded Signup** (Facebook Login for Business with `config_id`). It does not use a general Business Manager connection.

The existing flow is described in `docs/WHATSAPP_EMBEDDED_SIGNUP.md`:
- start, cancel mid-way, error, reconnect, and disconnect with confirmation;
- the token is sealed on the server;
- signed webhooks, routed by `phone_number_id` / `waba_id`;
- the status is derived from facts only.

### What this change adds

- **Asset belongs to another business:** a phone number, or an active WhatsApp Business Account (WABA), that is already connected to another business on the platform is refused.
  - This applies to both Embedded Signup and the manual connection.
  - The asset moves only after the current business disconnects it. That is the explicit, audited process.
  - Before this change, only the phone was checked across businesses, so a second business could connect the same WABA through another number, and account events would reach both.
- **New permission "חיבור וניתוק חשבון WhatsApp" (`whatsapp.connect`):**
  - The business owner and business-level managers have it by default.
  - A team manager has it only if granted explicitly. An agent never does.
  - It applies to all connection routes and to the "חיבור וואטסאפ" settings screen.
- **Screen:** shows the business portfolio ID at Meta, plus a list titled "להשלמת ההגדרה". It contains only facts Meta reported:
  - the display name hasn't been approved yet;
  - no business ID was received;
  - no event has arrived from Meta yet;
  - no real test send has been done yet;
  - the number's quality rating is low.

### What must be set up at Meta (required in practice)

1. **The app:**
   - Type **Business**, with the products **WhatsApp** and **Facebook Login for Business**.
   - A Login for Business configuration with the `whatsapp_business_management` and `whatsapp_business_messaging` permissions. Its ID goes in `META_ES_CONFIG_ID`.
2. **Domains:** the UltraCRM domain in Valid OAuth Redirect URIs and in Allowed Domains for the JS SDK, over HTTPS.
3. **Webhook:**
   - `https://<domain>/api/webhooks/whatsapp`, with the verify token `META_WEBHOOK_VERIFY_TOKEN`.
   - Fields: `messages`, `account_update`, `message_template_status_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`.
4. **Business Verification** of the provider's business (Tech Provider).
5. **App Review:** Advanced Access for both permissions. Without it, only users with a role on the app can complete the flow.
6. **Environment variables:** `META_APP_ID`, `META_APP_SECRET` (server only), `META_ES_CONFIG_ID`, `META_GRAPH_VERSION`, `META_WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`.
7. **The connecting customer:** a payment method on their WABA, to send beyond the free window.

## Template images

Meta's rules for the header image: **JPEG / PNG, up to 5 MB, 8-bit RGB or RGBA**.

**In the builder**
- A "תמונה" header gets a file picker (computer, or the phone's gallery or camera).
- Also: preview (in the builder and in the WhatsApp preview), replace, remove, an upload progress bar, "בודק את הקובץ…", and clear errors.
- A public link is still available as an advanced option.

**Checks**
- In the browser: type and size, before anything is uploaded.
- On the server, on the bytes:
  - the file signature;
  - the PNG IHDR or JPEG SOF header: 8-bit, RGB/RGBA;
  - palette PNG, grayscale and CMYK are refused, each with an explanation.
- A bad file is deleted.

**Storage**
- The `media_assets` table, with RLS by `business_id` and a strict tenant model.
- Uploaded in chunks of up to 1 MB. Vercel limits request bodies to about 4.5 MB, while Meta allows 5 MB.
- The image is served only to its own business, through `/api/media/:id`.

**Submitting a template**
- The stored bytes go to the **Resumable Upload API**:
  1. `POST /{app-id}/uploads?file_name&file_length&file_type`
  2. `POST /upload:…` with `file_offset: 0`
  3. The response `h` is used as `example.header_handle`.
- The template keeps the image (`header_media_asset_id`).

**Sending**
- If the template has an uploaded image and no link was given, the image is uploaded to the sending number: `POST /{phone-number-id}/media`.
- It is sent as `{"type":"image","image":{"id":…}}`.
- The media ID is cached per number for 29 days (Meta: 30).
- If Meta refuses the upload, the send fails with a clear, retryable error. A message is never sent without its image.
- A local link is never assumed to be reachable by Meta.

**Compatibility**
- Link-based templates, campaigns and automations are unchanged. An explicit link overrides the uploaded image.
- For templates with their own image, campaigns, the campaign wizard and WhatsApp after a call no longer require a link.

## Tests

- `tests/integration/whatsapp-media.test.ts` (Graph mocked in-process):
  - chunked upload, a retried chunk, wrong offset;
  - isolation between businesses (read, continue, delete, submit);
  - refusals: type, size, content, palette, 16-bit, CMYK;
  - the exact Resumable Upload calls and `header_handle`;
  - send by media ID, reuse, re-upload after expiry, a link overrides, a clear failure;
  - a phone or WABA of another business;
  - the connect permission for owner, business manager, team manager and agent.
- `scripts/qa-template-images.mjs` (browser): refusing a GIF and an image over 5 MB, uploading 2.7 MB in chunks, preview, replace (the old image is deleted), remove, 390 px phone, connection screen.

## Not verified against Meta (no app, config ID or connected account in this environment)

1. The Embedded Signup popup itself against Meta, and completing the connection with a real account. The checklist is in `WHATSAPP_EMBEDDED_SIGNUP.md` §6.
2. That the token received from Embedded Signup (business integration system user) is accepted by the Resumable Upload API.
   - The documentation says "User access token".
   - If Meta refuses it, the submission shows "Meta לא אפשרה להעלות את קובץ הדוגמה" and nothing is sent.
3. Real approval of a template with an uploaded image, and a real send by media ID to a phone.
4. The limits on image dimensions: Meta does not publish a minimum or maximum for the header.
