# Store connections: installation and validation

The first form creates a StoreConnection only. It does not authenticate an API or install subscriptions. The setup screen now distinguishes API verification, signed event receipt, actual cart ingestion, and a correlated purchase. A probe confirms signature configuration only and cannot set the connection to verified.

## Shopify

Choose one existing integration route:

- **Manual:** Shopify Settings → Notifications → Webhooks. Create JSON subscriptions for Checkout creation, Checkout update and Order payment, version 2026-10. Use the Shopify delivery URL shown for this store. Paste the signing secret shown beneath Shopify's manual webhooks into UltraCRM. Send a Shopify test delivery, then verify a real development-store checkout and test payment; a sample delivery alone is not end-to-end verification.
- **Installed application:** supply its `*.myshopify.com` domain, valid installation Admin API access token, and application secret. The connector uses GraphQL Admin API 2026-10, reads subscriptions and creates missing CHECKOUTS_CREATE, CHECKOUTS_UPDATE and ORDERS_PAID subscriptions. API/GraphQL errors are failures, including HTTP 422. Existing subscriptions with the same topic and destination are reused. Configure the application's webhook payload version to 2026-10. Applicable checkout/order scopes and protected customer data access must already be granted. This connector does not create or approve a Shopify application, obtain an installation token, or implement public OAuth distribution.

Do not mix manual webhook signing keys with application signing secrets. Manual subscriptions are managed in Shopify; application subscriptions belong to that app. Remove an old UltraCRM theme script when moving to this checkout-only route. It tracks **checkout** activity, not anonymous baskets before checkout. No recovery URL is invented if Shopify omits it.

The current payload identifies checkout via `token`, and the order refers to `checkout_token`. Completed order payment, or a signed order with financial_status=paid, converts that exact checkout. Unpaid creation, cancellation and a matching email do not prove purchase. No checkout token means no guessed cart conversion.

## WooCommerce

The existing API connector checks permissions against actual WooCommerce resources and creates order/customer/product webhooks when allowed. Read access supports import; Read/Write is needed for automatic subscription creation. Restricted keys retain the existing manual-webhook instructions and per-resource failure display.

API order sync cannot observe a pre-order basket. Install `public/integrations/ultracrm-woocommerce.zip` in WordPress Plugins → Add New → Upload, activate with WooCommerce active, and configure WordPress Settings → UltraCRM with the **server events URL** and signing secret from this store's setup panel. Test the signed connection. Then exercise a cart and payment; the probe does not insert a test cart or claim success.

Plugin source: `integrations/woocommerce/ultracrm-carts.php`. No API or signing secret is inserted into browser JavaScript. Cart selection and available billing details come from the WooCommerce session; no anonymous name/email/phone is generated. Mutations and throttled user activity capture snapshots. Classic and block checkout hooks bind `_ultracrm_cart_id` onto the order. Verified paid-order hooks and order webhooks use this ID. `on-hold` is not treated as paid. Order-only connections continue to use `order:<id>` for unpaid orders.

The plugin queues delivery through Action Scheduler, signs each attempt, retries transient failures, and displays the last delivery result in WordPress settings. WP-Cron/Action Scheduler must run. Restoration URLs expire after seven days; they restore product/variation selections, never account identity or billing information. Current prices/stock apply; extension-specific cart add-on data is not restored. Remove old UltraCRM theme scripts to prevent duplicate tracking. Review historical browser-created carts before enabling recovery campaigns for a migrated connection.

## Other sites

Download `/integrations/ultracrm-server.mjs`. Use its Node.js function only on the server, preferably backed by the site's own durable event outbox. Set the endpoint and secret from the setup panel in server environment variables.

The request is JSON POST to `/api/webhooks/stores/events/<storeId>` with:

- `X-UltraCRM-Timestamp`: current Unix seconds (five-minute tolerance).
- `X-UltraCRM-Event-Id`: stable unique business-event ID, 8–160 characters, letters/digits/underscore/colon/dot/hyphen. Preserve on retries.
- `X-UltraCRM-Signature`: base64 HMAC-SHA256 of `timestamp + '.' + eventId + '.' + exact_raw_body`, using the signing secret.

Cart example:

```json
{"type":"cart","externalId":"cart-42","activityAt":"2026-10-02T12:00:00Z","total":120,"currency":"ILS","items":[{"name":"Product","quantity":2,"price":60}]}
```

Send `email`, `phone`, `name`, and a genuine `checkoutUrl` only when available. Send a fresh source activity time for real activity; preserve the original time for retries. Empty items clear a cart from abandonment. No background heartbeat should keep an inactive customer artificially active.

After **server-side payment verification**, send a new event ID:

```json
{"type":"order","externalId":"cart-42","orderId":"order-91","total":120,"currency":"ILS"}
```

Use the same cart ID as the paid checkout; allocate a new ID for the next cart. Probe with `{"type":"probe"}`. HTTP 202 acknowledges durable queue receipt, not completed processing. Check the setup health panel and retry failures after fixing their cause. The existing stores job processes retries; claims expire after five minutes if a worker dies.

The optional browser script now offers explicit `.cart(...)` calls only. It no longer scrapes arbitrary form fields, polls platform carts, or claims an order completed from a thank-you URL. Browser orders are rejected, invalid payloads return 400, and failed persistence returns 503. A configured matching origin is required. This is a compatibility surface for untrusted cart signals, not payment proof.

## Abandonment and consent

Cart timestamps use source activity time. Duplicate/stale cart activity cannot postpone abandonment. Conditional updates prevent a simultaneous paid order from being reopened. A paid-before-cart tombstone prevents late creation from reopening it. Empty carts do not become abandoned; anonymous carts remain anonymous. Recovery journeys stop when their cart becomes active, empty, converted or recovered. Store email-marketing opt-in does not grant blanket WhatsApp/SMS consent.

## Verification performed and remaining release gates

- Full unit suite (2026-10-03): 265 passed. The focused regression suite: 30 passed (signatures, event-ID binding, replay expiry, honest probe status, invalid payloads, browser purchase rejection, stale activity, anonymous identity, empty carts, paid-before-cart, explicit correlation, Shopify GraphQL failures and reuse).
- Type checking and production build passed during implementation; final results recorded in the PR.
- Plugin 1.0.1 executed on PHP 8.3 (official WordPress PHP.wasm): 11 lifecycle assertions passed using WordPress/WooCommerce test doubles. `tests/php/woocommerce-cart-lifecycle.php` also runs with native PHP. This is not a full WordPress/WooCommerce installation test.
- Rendered actual React components in an isolated browser fixture with sample API responses. Verified the creation-to-setup UI, custom/Woo instructions, and journey layout at 367px and 1280px without horizontal page overflow. This is UI verification, not backend or platform verification.
- Integration test fixtures were updated for paid events and explicit marketing consent. **Database integration tests for this change have not run**: local PostgreSQL startup failed with sandbox IPC permission errors (`shmat: Operation not permitted`).
- **No real store installation/payment tested.** Need a controlled Shopify development store and WooCommerce staging store, their normal authorized credentials, and local/staging PostgreSQL that can start. Do not mark release as end-to-end verified until these checks pass.

Acceptance run: create store → install/configure hooks/plugin → reject bad signature → real cart with quantity/price/customer changes → refresh activity → wait past threshold → abandon → new activity stops reminders → abandon again → paid checkout converts the same cart → replay events causes no duplicate/reopen → purchase with another cart ID does not close this cart. Run Woo classic and block checkout separately; confirm failed/offline delivery retries and expired recovery links.

## Official references checked 2026-10-02

- [Shopify manual webhooks](https://help.shopify.com/en/manual/fulfillment/setup/notifications/webhooks)
- [Shopify webhook payloads](https://shopify.dev/docs/api/webhooks/latest)
- [Shopify checkout identifier change](https://shopify.dev/changelog/posts/removed-checkout-id-from-checkouts-and-orders-webhooks)
- [GraphQL webhook subscription creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate)
- [WooCommerce webhook configuration](https://woocommerce.com/document/webhooks/)
- [WooCommerce REST API keys](https://woocommerce.com/document/woocommerce-rest-api/)
- [WooCommerce Store API checkout](https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/checkout)
- [WooCommerce block checkout hook reference](https://woocommerce.github.io/code-reference/files/woocommerce-src-storeapi-routes-v1-checkout.html)

## Follow-up investigation 2026-10-03

Solina (`https://www.solina.co.il/`) exposes WooCommerce 10.6.2 assets. No UltraCRM activity script was observed on the inspected public homepage. This alone cannot distinguish an absent plugin from an unconfigured plugin or cached HTML. A public add-to-cart click was attempted, but subsequent browser observations timed out; successful cart creation and CRM receipt are unverified. No payment was submitted. Admin access/configuration and a controlled test purchase remain necessary. Native PostgreSQL startup remains blocked by OS shared-memory permissions.

Plugin 1.0.1 fixes empty-cart delivery before session rotation, invalidates emptied-cart restoration links, captures the allowlisted classic checkout billing fields before order creation, captures coupon/restoration mutations, and prevents phantom carts from empty visits or deferred captures after payment. Secrets remain server-side. Abandonment now commits its state change and outbox event in one transaction, so a failed event insert remains retryable. Unit tests assert transactional use and error propagation; actual database rollback still needs the database integration run.

Official WooCommerce source checked:
- [Classic checkout order-review implementation](https://woocommerce.github.io/code-reference/files/woocommerce-includes-class-wc-ajax.html): updates customer addresses but does not populate guest email/phone from order-review data.
- [Cart lifecycle hooks](https://woocommerce.github.io/code-reference/files/woocommerce-includes-class-wc-cart.html): `woocommerce_cart_emptied` runs after contents are cleared.
