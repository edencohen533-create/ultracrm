# Meta App Review – WhatsApp Tech Provider submission guide

Everything the product needs for review is built and deployed. This file covers what to fill in at Meta, and the exact videos and texts to submit.

## Status (checked 2026-09-28 against production)
Ready: public pages, privacy policy matches the two permissions, signed webhook, Embedded Signup flow, template/quality webhooks, in-app deletion, English UI, app icon.
Still open (not code):
- [ ] `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` missing in Vercel – until set, `/api/meta/data-deletion` and `/api/meta/deauthorize` answer 503 and Embedded Signup cannot open.
- [ ] `PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS`, `SUPPORT_EMAIL` missing – the public pages name only "UltraCRM", with no legal entity or contact email. Must match the verified business.
- [ ] Own domain (recommended): Business Verification expects the business's own website; `*.vercel.app` cannot be domain-verified.
- [ ] No reviewer account in production yet (step 4).
- [ ] No real WhatsApp test yet (step 5).

## 0. Before you start (outside the code)
1. **Business Verification** (Business Settings → Security Center). Required before Advanced Access.
2. **Two-factor authentication** on the Facebook account that admins the app.
3. **Production environment (Vercel)** – set these environment variables:
   - `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`
     - `META_ES_CONFIG_ID` is the Facebook Login for Business configuration of type *WhatsApp Embedded Signup*.
   - `NEXT_PUBLIC_APP_URL`: the public domain.
   - `PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS`, `SUPPORT_EMAIL` (and optionally `PRIVACY_EMAIL`, `PLATFORM_PRODUCT_NAME`). These are shown on the privacy / terms / support pages; reviewers expect a real operator name and contact.
4. **Reviewer login** (run it yourself; the password is printed only to your terminal):
   ```
   node scripts/create-reviewer.mjs reviewer@<your-domain>
   ```
   After approval: `node scripts/create-reviewer.mjs reviewer@<your-domain> --revoke`.
5. **Real WhatsApp check:** connect your own WhatsApp Business number once through **Settings → WhatsApp → Connect WhatsApp**, and send a test message. Until now the WhatsApp flows were only verified against the simulator.

## 1. App Dashboard settings
| Field | Value |
|---|---|
| App icon | `docs/meta/app-icon-1024.png` (1024×1024, the "U" mark) |
| Category | Business and pages / Messaging |
| App domains | your domain (e.g. `ultracrm-eta.vercel.app`) |
| Privacy Policy URL | `https://<domain>/privacy` |
| Terms of Service URL | `https://<domain>/terms` |
| User data deletion | **Data Deletion Callback URL**: `https://<domain>/api/meta/data-deletion` (instructions page: `https://<domain>/data-deletion`) |
| Deauthorize callback (Facebook Login for Business → Settings) | `https://<domain>/api/meta/deauthorize` |
| Valid OAuth redirect / allowed domains for the JS SDK | `https://<domain>` |
| WhatsApp → Configuration → Webhook | Callback `https://<domain>/api/webhooks/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to **messages**, **message_template_status_update**, **phone_number_quality_update**, **account_update** |
| Contact email | the `SUPPORT_EMAIL` address |

## 2. Permissions to request (Advanced Access) – only these two
Requesting permissions you don't use is a common rejection reason.

### `whatsapp_business_management`
> UltraCRM is a CRM for small and medium businesses. Each business connects its own WhatsApp Business Account through our Embedded Signup. We use whatsapp_business_management to read the business's WABA and phone number details, register the phone number for the Cloud API, subscribe our app to the WABA's webhooks, and create and submit message templates on the business's behalf and track their approval status. Business owners manage all of this from Settings → WhatsApp and from the WhatsApp templates screen. We access only the WABAs that the business explicitly shares with us during Embedded Signup.

### `whatsapp_business_messaging`
> Businesses use UltraCRM's shared team inbox to reply to customers who message them on WhatsApp, and to send approved template messages (for example follow-ups after a call) to customers who opted in. We use whatsapp_business_messaging to send and receive messages, media and delivery/read statuses for the business's phone number. Opt-out requests ("STOP") are honoured across all channels, and messages outside the 24-hour window require an approved template.

## 3. Screencasts (one video per permission, English UI)
Before recording, click **English** (login page, bottom of the side menu). Record the business-facing screens, not the customer's side, except where you show the message arriving on WhatsApp.

**Video A – `whatsapp_business_management`** (about 2 minutes)
1. Log in as the reviewer. Go to **Settings → WhatsApp**, click **Connect WhatsApp**, complete Embedded Signup (select business, WABA, phone number) and show the connected card with quality rating and messaging limit.
2. Side menu → **WhatsApp templates** → **Create template**. Fill in the name, category, language, body with a variable, and a button. Show the preview, then submit.
3. Show the template in the list as "Pending approval", and after approval (the webhook updates it automatically) as "Active – approved".

**Video B – `whatsapp_business_messaging`** (about 2 minutes)
1. On a phone, send a WhatsApp message to the connected business number. Show it arriving in UltraCRM's **WhatsApp** inbox.
2. Reply from the inbox. Show the reply arriving on the phone (WhatsApp mobile or Web visible in the recording).
3. Outside the 24-hour window, or from the lead card, send an approved template. Show it arriving on the phone and the delivered/read status in UltraCRM.

## 4. Reviewer instructions (paste into the submission)
> Login: https://<domain>/login – email/password below. The interface language can be switched with the "English" button on the login page and at the bottom of the side menu. WhatsApp settings: Settings → WhatsApp. Templates: side menu → WhatsApp templates. Inbox: side menu → WhatsApp. Data deletion: Settings → Account and https://<domain>/data-deletion. Support: https://<domain>/support.

## 5. What reviewers will find (built)
- **Public pages:** landing `/`, privacy `/privacy`, terms `/terms`, data deletion `/data-deletion` (with confirmation-code status), support `/support` (contact form stored for the platform team: `/platform` → Support & deletions).
- **Meta callbacks:** signed data-deletion and deauthorize callbacks. They disconnect and erase the connection's tokens and Meta IDs, and return `{url, confirmation_code}`.
- **In-app deletion:** "Delete my user" (any user) and "Delete business and all data" (owner). Tokens are erased immediately; everything is purged after 14 days by the daily job and can be cancelled until then.
- **Embedded Signup:** code exchange → token checks → WABA/phone read → webhook subscription → number registration.
- **Webhooks:** signature verified. Handles messages, statuses, template status (real time), quality/messaging tier, and account updates.
- **Messaging:** 24-hour window enforcement, templates, media, opt-out handling across channels.
- **English UI:** the whole interface can be switched to English.

## 6. After approval
Onboard customers with Embedded Signup. Each business adds its own payment method in WhatsApp Manager before sending (Tech Providers do not share a credit line).
