# Direct WhatsApp Cloud API connection (single business – Solina) – 2026-10-03

The system is currently for Solina's internal use. The connection is **direct**: Solina's own Meta app, a System User token, Solina's WABA and number.

The Tech Provider route (Embedded Signup for other businesses) is **paused**, not deleted:
- The code, the screens and `docs/WHATSAPP_EMBEDDED_SIGNUP.md` stay as they are.
- In direct mode the "Connect WhatsApp" button (Embedded Signup) is hidden, and a "Connect the business number" button appears instead.

## Rules verified against Meta's official documentation (October 2026)
- **No App Review / Advanced Access needed.** A Direct Developer working with assets of its own business portfolio needs neither.
  Source: `whatsapp/solution-providers/app-review`.
- **The app must be in Live mode.** Some webhooks are not sent in Dev mode.
  Source: `whatsapp/webhooks/overview`.
- **System User token:**
  - Created in Business settings → System users.
  - The system user is assigned the app with full control, and the WABA.
  - Permissions: `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`.
  - Source: `whatsapp/access-tokens`.
- **Webhook signature:** `X-Hub-Signature-256` = HMAC-SHA256 of the raw body with the App Secret. The app is subscribed to the WABA with `POST /{WABA_ID}/subscribed_apps`.
- **Number state:** `platform_type` (`CLOUD_API` / `ON_PREMISE` / `NOT_APPLICABLE`), `status` (must be `CONNECTED` to send), and `is_on_biz_app` (coexistence with the WhatsApp Business app).
- **Coexistence** (the same number in the WhatsApp Business app and in the API at once) is available **only through Embedded Signup by a Tech Provider / Solution Partner**. It is not available to a business connecting directly with its own app.
- **`register`:** limited to 10 requests per 72 hours.

## Environment variables (Vercel → Production)

| Name | Secret? | Content |
|---|---|---|
| `WHATSAPP_DIRECT_BUSINESS_ID` | no | The ID of Solina's business in the system. The token is used only for this business |
| `WHATSAPP_DIRECT_WABA_ID` | no | WhatsApp Business Account ID |
| `WHATSAPP_DIRECT_PHONE_NUMBER_ID` | no | Phone Number ID (not the phone number itself) |
| `WHATSAPP_SYSTEM_USER_TOKEN` | **yes** | The System User's permanent token |
| `META_APP_SECRET` | **yes** | The App Secret (webhook signature verification + debug_token) |
| `META_APP_ID` | no | Already set (1653153909742880) |
| `META_WEBHOOK_VERIFY_TOKEN` | yes | Already set |
| `WHATSAPP_CONNECT_MODE` | no | Optional: `direct` turns on direct mode before the IDs are set |

Each command asks for the value; paste it in the terminal, not in a chat:
```
cd ~/ultracrm
npx vercel env add WHATSAPP_DIRECT_BUSINESS_ID production
npx vercel env add WHATSAPP_DIRECT_WABA_ID production
npx vercel env add WHATSAPP_DIRECT_PHONE_NUMBER_ID production
npx vercel env add WHATSAPP_SYSTEM_USER_TOKEN production --sensitive
npx vercel env add META_APP_SECRET production --sensitive
npx vercel deploy --prod
```
To replace a value that already exists, add `--force` to the same command.

## How it works in code
- `src/lib/meta/graph.ts`:
  - `directWhatsAppEnv()` reads the variables.
  - `metaConfigOf()` gives the token to a row with `tokenSource: "env"` only when the business, the WABA and the number match the variables exactly.
- The `provider_credentials` row (`connection_method = direct`) stores **IDs only**. There is no token in the database.
- **`src/server/services/whatsapp-direct-service.ts`:**
  - `connectDirect` (owner only, only for the business set in the variable). It runs these checks:
    - `debug_token`: valid, this app, both permissions.
    - The WABA is readable, and the number belongs to the WABA.
    - The number's state is read **without changing it**.
  - It then subscribes the app to the WABA (subscribe does not change the number), and saves the row.
  - `registered` is marked only when Meta reports `CLOUD_API`.
  - `registerDirect`: rarely needed (see "Who decides" below).
- Everything else is the existing infrastructure, shared with the other connection routes:
  - **Webhook:** signature verification against the App Secret before anything is touched.
  - **Duplicate handling:**
    - Inbound messages are deduplicated by `inboundKey` (unique).
    - Statuses are deduplicated by a `wamid:status:timestamp` ledger.
  - **Routing:** messages by `phone_number_id`, account events by WABA.
  - Contacts by phone number.
  - Media in both directions.
  - Templates: sync, plus a status webhook.
  - Broadcasts:
    - pacing, plus the messaging limit by tier;
    - opt-in consent required for marketing;
    - a template required outside the 24 hours;
    - "הסר" / opt-out across all channels;
    - Meta error classification (`src/lib/meta/errors.ts`): retry only on temporary errors, and block on token/permission errors.

## Who decides whether the number is registered
| `platform_type` per Meta | Meaning | What the system does |
|---|---|---|
| `CLOUD_API` | Already on Cloud API (possibly with coexistence) | Connects. No re-registration |
| `NOT_APPLICABLE` | In the WABA but on no API | Offers an explicit "Register" button with the business's existing two-step PIN and a confirmation window. The PIN is not stored |
| `ON_PREMISE` | On a server/provider with the On-Premises API | Blocks registration. A coordinated migration is needed |
| Other / unknown | — | No action |

**A number still active in the WhatsApp Business app** that is not yet in the WABA cannot be added directly without deleting it from the app:
- Deleting it from the app removes the chat history on the phone.
- Coexistence is not available on the direct route.

**A number with another provider (BSP):** migrate it to Solina's WABA:
1. The current provider turns off two-step verification.
2. `POST /{WABA}/phone_numbers` with `migrate_phone_number=true`.
3. `request_code` / `verify_code`.
4. `register`.

The display name, quality and limit carry over. The system does not do this automatically.

## Checks
- `node scripts/meta-go-live-check.mjs <env file>`:
  - In direct mode it does not require `META_ES_CONFIG_ID`.
  - It checks the token, the WABA, the number (no change), the subscription, templates, signed and unsigned webhooks, and the data deletion callback.
- Test send: one message only, and only when requested explicitly:
  `--send-test-to +9725XXXXXXXX [--template hello_world --lang en_US]`.
  In the UI, a test send goes only to numbers on the connection's allow-list.
- Unit tests: `tests/unit/whatsapp-direct.test.ts`.
