# WhatsApp software review readiness — 2026-09-29

Scope: UltraCRM as a Tech Provider for other businesses using WhatsApp Business Platform. Facebook Ads approval is separate. Never describe simulated delivery as a real WhatsApp test.

## Implemented in this release

- Free-form WhatsApp opt-outs hold marketing across channels pending review. Re-consent requires evidence. Exact STOP/הסר behavior remains supported.
- New manual/imported marketing opt-in requires consent evidence. CSV import supports `consentEvidence`, with row-level errors and preview. Existing contacts are not automatically opted in by imports.
- Signed deletion callbacks are transactional, serialize repeated requests, delete linked signup records and replace the requester's raw identifier with a fingerprint. Confirmation codes are alphanumeric; repeated deletion requests return the same receipt within 24 hours.
- Daily retention clears historical message-body copies in domain events, including copies of already-purged messages. Expired signup attempts are removed after 30 days; deletion receipts after 90 days.
- Business deletion immediately removes advertising credentials and signup attempts as well as messaging tokens.
- Public instructions now distinguish removal/deauthorization from a separate deletion request.
- A dedicated reviewer can be created in a new isolated business with `scripts/create-reviewer.mjs <email> --business <new-slug> --create-isolated`. This refuses existing emails and slugs; it does not send mail. Store credentials privately, never in Git or a PR. Revoke after review.

## Production preparation completed

An isolated `meta-review-isolated` business and dedicated reviewer account were provisioned. Login, single-business isolation and access to WhatsApp settings were verified. Credentials are stored only in the operator's local protected output file. There are no customer contacts or live WhatsApp credentials in this review business.

## Still blocked by Meta configuration / real assets

Production lacks `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`. Therefore Embedded Signup and signed deletion/deauthorization callbacks cannot operate yet. Do not fabricate these values or weaken signature verification. Enter the App Secret directly in Vercel, not in chat. The existing verify token, encryption and public identity settings are present.

The operator must complete or provide access to the Meta App Dashboard configuration and required business verification. Verify WhatsApp Embedded Signup v4, allowed domains, both WhatsApp Advanced Access permissions, and subscriptions to messages, message_template_status_update, phone_number_quality_update and account_update. Follow current dashboard verification requirements; do not assume historical Access Verification guidance overrides it.

After configuration, run `scripts/meta-go-live-check.mjs` with a protected production environment file, delete that temporary file, and connect a real authorized test number. The reviewer business is prepared but is not yet a live messaging demonstration.

## Submission package

Use the permission-specific written descriptions and recording scripts in `META_APP_REVIEW.md`:

1. `whatsapp_business_management`: record creation/submission of a WhatsApp template.
2. `whatsapp_business_messaging`: record a message sent from UltraCRM and visibly received in WhatsApp; also verify inbound reply and delivery status.

Record separate clips, attach written explanations for each permission, supply the isolated reviewer credentials privately, and actually submit the application. Screenshots or a simulator do not establish real delivery. The existing English UI and public privacy/terms/deletion/support pages support the review.

Government use has separate eligibility restrictions: verify the customer's category and required Solution Provider route before onboarding. Approval of this app does not grant permission for prohibited sectors or authorize unsolicited campaigns.

## Official references

- [WhatsApp App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)
- [Deletion requests](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback)
- [Messaging Policy](https://whatsappbusiness.com/policy/)
