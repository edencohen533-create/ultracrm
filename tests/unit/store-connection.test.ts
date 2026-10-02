// @vitest-environment node
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findStore: vi.fn(), updateStore: vi.fn(), cart: vi.fn(), order: vi.fn(), enqueue: vi.fn(), process: vi.fn(), after: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("@/lib/events", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/crm/contacts", () => ({ findOrCreateContactByPhone: vi.fn() }));
vi.mock("@/lib/suppression", () => ({ contactForIdentifier: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { storeConnection: { findFirst: mocks.findStore, findUnique: mocks.findStore } }, prisma: { storeConnection: { update: mocks.updateStore } } }));
vi.mock("@/lib/tenant", () => ({ withBusiness: (_: string, fn: () => unknown) => fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/server/channels/registry", () => ({ openConfig: (v: unknown) => v, sealConfig: (v: unknown) => v }));
vi.mock("@/server/services/cart-service", async importOriginal => {
  const actual = await importOriginal<object>(); return { ...actual, ingestCart: mocks.cart, ingestOrder: mocks.order };
});
vi.mock("@/server/services/woo/events", () => ({ enqueueStoreItem: mocks.enqueue, processStoreEvents: mocks.process }));
vi.mock("@/server/services/store-order-service", () => ({ upsertStoreOrder: mocks.snapshot, shopifyOrderSnapshot: (x: unknown) => x }));
import { POST as serverEvent } from "@/app/api/webhooks/stores/events/[storeId]/route";
import { POST as browserEvent } from "@/app/api/track/[key]/events/route";
import { POST as shopify } from "@/app/api/webhooks/stores/shopify/[storeId]/route";
const store = { id: "s1", businessId: "b1", platform: "custom", isActive: true, domain: "shop.example.com", config: { webhookSecret: "secret_for_testing" } };
const params = { params: Promise.resolve({ storeId: "s1" }) };
const hmac = (raw: string) => crypto.createHmac("sha256", store.config.webhookSecret).update(raw).digest("base64");
function request(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  return new Request("https://crm.example/api", { method: "POST", body: raw, headers: { "x-ultracrm-timestamp": timestamp, "x-ultracrm-signature": hmac(`${timestamp}.event-id-123.${raw}`), "x-ultracrm-event-id": "event-id-123" } });
}
beforeEach(() => { vi.clearAllMocks(); mocks.findStore.mockResolvedValue(store); mocks.enqueue.mockResolvedValue({ event: { id: "ev1" }, duplicate: false }); });
describe("signed server events", () => {
  it("durably enqueues an anonymous cart, preserving real activity time", async () => {
    const event = { type: "cart", externalId: "c1", activityAt: new Date(Date.now() - 60_000).toISOString(), items: [{ name: "Product", quantity: 2, price: 4 }], total: 8, currency: "ILS" };
    const result = await serverEvent(request(event), params);
    expect(result.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(store, "webhook", "ucrm.cart", { ...event, id: "event-id-123" });
    expect(mocks.after).toHaveBeenCalledOnce();
  });
  it("rejects expired requests, even with valid HMAC", async () => {
    expect((await serverEvent(request({ type: "probe" }, "1000000000"), params)).status).toBe(401); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("binds the event ID to the signature", async () => {
    const r = request({ type: "probe" }); r.headers.set("x-ultracrm-event-id", "changed-id-123");
    expect((await serverEvent(r, params)).status).toBe(401);
  });
  it("rejects invalid HMAC", async () => {
    const r = request({ type: "probe" }); r.headers.set("x-ultracrm-signature", "wrong");
    expect((await serverEvent(r, params)).status).toBe(401);
  });
  it("probe does not mark event verification or create test data", async () => {
    expect((await serverEvent(request({ type: "probe" }), params)).status).toBe(200);
    expect(mocks.updateStore).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("requires cart correlation for purchases", async () => {
    expect((await serverEvent(request({ type: "order", orderId: "o1" }), params)).status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("requires source activity time, rejecting future activity", async () => {
    for (const activityAt of [undefined, new Date(Date.now() + 86400_000).toISOString()]) expect((await serverEvent(request({ type: "cart", externalId: "c1", activityAt }), params)).status).toBe(400);
  });
  it("reports duplicate acknowledgement honestly", async () => {
    mocks.enqueue.mockResolvedValue({ event: null, duplicate: true });
    const r = await serverEvent(request({ type: "order", orderId: "o1", externalId: "c1" }), params);
    expect(await r.json()).toMatchObject({ duplicate: true, status: "queued" });
  });
});
describe("untrusted browser events", () => {
  const send = (event: unknown, origin = "https://shop.example.com") => browserEvent(new Request("http://crm/api", { method: "POST", body: JSON.stringify(event), headers: { origin } }), { params: Promise.resolve({ key: "public-key" }) });
  it("cannot forge a purchase", async () => { expect((await send({ type: "order", orderId: "o1", externalId: "c1" })).status).toBe(403); expect(mocks.order).not.toHaveBeenCalled(); });
  it("returns 400 for malformed cart instead of false success", async () => { expect((await send({ type: "cart" })).status).toBe(400); });
  it("returns retryable failure when persistence fails", async () => { mocks.cart.mockRejectedValueOnce(new Error("unavailable")); expect((await send({ type: "cart", externalId: "c1" })).status).toBe(503); });
  it("rejects wrong origins", async () => { expect((await send({ type: "cart", externalId: "c1" }, "https://evil.example")).status).toBe(403); });
  it("strips browser consent and activity timestamp", async () => { await send({ type: "cart", externalId: "c1", acceptsMarketing: true, activityAt: "2099-01-01T00:00:00Z" }); expect(mocks.cart).toHaveBeenCalledWith(store, { externalId: "c1" }); });
});
describe("Shopify purchase evidence", () => {
  function hook(topic: string, body: unknown) { const raw = JSON.stringify(body); return shopify(new Request("http://crm", { method: "POST", body: raw, headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": hmac(raw) } }), params); }
  it("does not convert an unpaid order", async () => { await hook("orders/create", { id: 1, checkout_token: "c1", financial_status: "pending" }); expect(mocks.snapshot).toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled(); });
  it("converts a paid order using checkout_token", async () => { await hook("orders/paid", { id: 1, checkout_token: "c1", total_price: "10" }); expect(mocks.order).toHaveBeenCalledWith(store, expect.objectContaining({ externalId: "c1", orderId: "1", total: 10 })); });
  it("rejects a checkout lacking the current API token", async () => { expect((await hook("checkouts/create", { id: 12, updated_at: new Date().toISOString() })).status).toBe(400); expect(mocks.cart).not.toHaveBeenCalled(); });
  it("rejects signed events addressed to another app-connected shop", async () => { mocks.findStore.mockResolvedValue({ ...store, config: { ...store.config, apiShop: "mine.myshopify.com" } }); expect((await hook("orders/paid", { id: 1 })).status).toBe(403); });
});
