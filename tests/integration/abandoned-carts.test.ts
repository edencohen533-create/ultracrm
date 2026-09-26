/**
 * Abandoned carts end to end on the real DB: signed Shopify checkout webhook → cart + contact (+ consent from the store),
 * abandonment → cart.abandoned → journey sends WhatsApp with the cart link → Shopify order → "recovered".
 * WooCommerce: ping accepted, unsigned rejected, unpaid order = cart, paid order = converted. Site script endpoint:
 * origin allow-list, served script. Tenant isolation of carts.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { newPublicKey, sealStoreConfig, processAbandonedCarts } = await import("@/server/services/cart-service");
const { POST: shopifyHook } = await import("@/app/api/webhooks/stores/shopify/[storeId]/route");
const { POST: wooHook } = await import("@/app/api/webhooks/stores/woocommerce/[storeId]/route");
const { POST: trackPost } = await import("@/app/api/track/[key]/events/route");
const { GET: scriptGet } = await import("@/app/api/track/[key]/script/route");
const { saveSequence, sequenceSchema, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { processDomainEvents, waitForEvents } = await import("@/lib/events");

const sign = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64");
const P = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describe("abandoned carts", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>; let b: Awaited<ReturnType<typeof createBusiness>>;
  let shop: { id: string; publicKey: string }; let woo: { id: string; publicKey: string }; let waTpl: string;
  const SHOP_SECRET = "shpss_test_secret_123"; const WOO_SECRET = "woo_secret_456";
  const run = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn, a.session);
  beforeAll(async () => {
    a = await createBusiness("cart-a", { modules: { messaging: true, crm: true } }); b = await createBusiness("cart-b", { modules: { messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 0 } } } });
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    waTpl = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "cart_reminder", language: "he", category: "MARKETING", body: "שכחת משהו בעגלה: {{1}}", status: "APPROVED" } })).id;
    shop = await db.storeConnection.create({ data: { businessId: a.business.id, platform: "shopify", name: "Shop", domain: "shop.example.com", publicKey: newPublicKey(), abandonAfterMinutes: 30, config: sealStoreConfig({ webhookSecret: SHOP_SECRET }) } });
    woo = await db.storeConnection.create({ data: { businessId: a.business.id, platform: "woocommerce", name: "Woo", publicKey: newPublicKey(), config: sealStoreConfig({ webhookSecret: WOO_SECRET }) } });
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("Shopify checkout webhook (signed) → cart linked to a contact with store consent; bad signature rejected", async () => {
    const checkout = { id: 1, token: "tok_abc", email: "dana@example.test", phone: "+972501234777", currency: "ILS", total_price: "249.90", buyer_accepts_marketing: true, abandoned_checkout_url: "https://shop.example.com/checkouts/tok_abc/recover", customer: { first_name: "דנה", last_name: "כהן" }, line_items: [{ title: "קרם לחות", quantity: 2, price: "99.95" }, { title: "סרום", quantity: 1, price: "50" }] };
    const body = JSON.stringify(checkout);
    const bad = await shopifyHook(new Request("http://x", { method: "POST", body, headers: { "x-shopify-topic": "checkouts/create", "x-shopify-hmac-sha256": "nope" } }), P({ storeId: shop.id }));
    expect(bad.status).toBe(401);
    const res = await shopifyHook(new Request("http://x", { method: "POST", body, headers: { "x-shopify-topic": "checkouts/create", "x-shopify-hmac-sha256": sign(SHOP_SECRET, body) } }), P({ storeId: shop.id }));
    expect(res.status).toBe(200);
    const cart = await db.cart.findUniqueOrThrow({ where: { storeId_externalId: { storeId: shop.id, externalId: "tok_abc" } }, include: { contact: true } });
    expect(cart).toMatchObject({ status: "open", email: "dana@example.test", phoneE164: "+972501234777", checkoutUrl: "https://shop.example.com/checkouts/tok_abc/recover" });
    expect(Number(cart.total)).toBe(249.9);
    expect(cart.contact).toMatchObject({ fullName: "דנה כהן", consentStatus: "OPTED_IN", email: "dana@example.test" });
  });

  it("abandonment → journey sends WhatsApp with the cart link → Shopify order → recovered", async () => {
    await run(() => saveSequence(a.session, sequenceSchema.parse({ name: "שחזור עגלה", trigger: "CART_ABANDONED", stopOn: [], steps: [{ action: "send", channel: "whatsapp", templateId: waTpl, waitMinutes: 0, variables: { "1": "{cart_url}" }, condition: { requireNoReply: false } }] })));
    await db.cart.updateMany({ where: { storeId: shop.id, externalId: "tok_abc" }, data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) } });
    await run(() => processAbandonedCarts(a.business.id));
    const cart = await db.cart.findUniqueOrThrow({ where: { storeId_externalId: { storeId: shop.id, externalId: "tok_abc" } } });
    expect(cart.status).toBe("abandoned");
    await processDomainEvents({ businessId: a.business.id }); await waitForEvents(a.business.id);
    let msg = null;
    for (let i = 0; i < 30 && !msg; i++) { await run(() => processDueSequenceRuns()); msg = await db.message.findFirst({ where: { conversation: { contactId: cart.contactId! }, templateId: waTpl } }); if (!msg) await new Promise((r) => setTimeout(r, 4000)); }
    expect(msg).toBeTruthy();
    expect(JSON.stringify(msg)).toContain("https://shop.example.com/checkouts/tok_abc/recover");
    expect((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).recoveryMessageAt).not.toBeNull();
    const order = JSON.stringify({ id: 99, name: "#1001", checkout_token: "tok_abc", email: "dana@example.test", total_price: "249.90", currency: "ILS" });
    await shopifyHook(new Request("http://x", { method: "POST", body: order, headers: { "x-shopify-topic": "orders/create", "x-shopify-hmac-sha256": sign(SHOP_SECRET, order) } }), P({ storeId: shop.id }));
    expect(await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).toMatchObject({ status: "recovered", orderId: "#1001" });
  });

  it("WooCommerce: ping ok, unsigned rejected, unpaid order = cart, paid order = converted", async () => {
    expect((await wooHook(new Request("http://x", { method: "POST", body: "webhook_id=5" }), P({ storeId: woo.id }))).status).toBe(200);
    const pending = JSON.stringify({ id: 501, number: "501", status: "pending", currency: "ILS", total: "120.00", payment_url: "https://woo.example.com/checkout/order-pay/501/", billing: { first_name: "יוסי", last_name: "לוי", email: "yossi@example.test", phone: "0501234888" }, line_items: [{ name: "כובע", quantity: 1, price: 120 }] });
    expect((await wooHook(new Request("http://x", { method: "POST", body: pending, headers: { "x-wc-webhook-topic": "order.created" } }), P({ storeId: woo.id }))).status).toBe(401);
    await wooHook(new Request("http://x", { method: "POST", body: pending, headers: { "x-wc-webhook-topic": "order.created", "x-wc-webhook-signature": sign(WOO_SECRET, pending) } }), P({ storeId: woo.id }));
    const cart = await db.cart.findUniqueOrThrow({ where: { storeId_externalId: { storeId: woo.id, externalId: "order:501" } } });
    expect(cart).toMatchObject({ status: "open", phoneE164: "+972501234888", checkoutUrl: "https://woo.example.com/checkout/order-pay/501/" });
    const paid = pending.replace('"status":"pending"', '"status":"processing"');
    await wooHook(new Request("http://x", { method: "POST", body: paid, headers: { "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": sign(WOO_SECRET, paid) } }), P({ storeId: woo.id }));
    expect((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).status).toBe("converted");
  });

  it("site script: served; events accepted only from the store's domain; cart stored", async () => {
    const js = await scriptGet(new Request("http://x"), P({ key: shop.publicKey }));
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("/cart.js");
    const ev = JSON.stringify({ type: "cart", externalId: "web_1", phone: "0501234999", name: "גל", total: 80, currency: "ILS", items: [{ name: "גרביים", quantity: 2, price: 40 }] });
    expect((await trackPost(new Request("http://x", { method: "POST", body: ev, headers: { origin: "https://evil.example" } }), P({ key: shop.publicKey }))).status).toBe(403);
    expect((await trackPost(new Request("http://x", { method: "POST", body: ev, headers: { origin: "https://www.shop.example.com" } }), P({ key: shop.publicKey }))).status).toBe(204);
    expect(await db.cart.findUnique({ where: { storeId_externalId: { storeId: shop.id, externalId: "web_1" } } })).toMatchObject({ phoneE164: "+972501234999", status: "open" });
  });

  it("tenant isolation: business B sees none of A's carts or stores", async () => {
    expect(await withBusiness(b.business.id, () => db.cart.count(), b.session)).toBe(0);
    const { prisma } = await import("@/lib/db");
    expect(await withBusiness(b.business.id, () => prisma.cart.count(), b.session)).toBe(0);
    expect(await withBusiness(b.business.id, () => prisma.storeConnection.count(), b.session)).toBe(0);
  });
});
