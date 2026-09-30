/**
 * WooCommerce end to end against a simulated store (an in-memory WooCommerce REST API v3 – pagination headers,
 * webhooks, refunds, permissions, outages, rate limits). Real DB, real routes. Nothing is charged, ordered or sent.
 * Covered: good connection, missing permissions / read-only key, initial import of existing data (silent), a new
 * order + update via signed webhook, cancel + refund, duplicate + out-of-order deliveries, an outage during sync and
 * reconcile after it, an existing CRM contact, a receipt from a separate system, two businesses / two stores with the
 * same order ids, disconnect keeping history, and freshness for the AI.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, afterEach, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { newPublicKey, sealStoreConfig, storeSecret } from "@/server/services/cart-service";
import { setWooTransportForTests } from "@/server/services/woo/client";
import { connectWoo, disconnectWoo, recheckWoo } from "@/server/services/woo/connect";
import { previewSync, startSync, runSyncStep, startReconcile } from "@/server/services/woo/sync";
import { processStoreEvents } from "@/server/services/woo/events";
import { storeHealth, storeFreshness } from "@/server/services/woo/health";
import { createApiKey } from "@/server/services/integrations";
import { POST as webhookPOST } from "@/app/api/webhooks/stores/woocommerce/[storeId]/route";
import { POST as receiptPOST } from "@/app/api/v1/orders/receipts/route";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");

// ─── Simulated WooCommerce ──────────────────────────────────────────────────────────────────────────────────────
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Shop { orders: Obj[]; customers: Obj[]; products: Obj[]; refunds: Map<number, Obj[]>; webhooks: Obj[]; mode: { deny?: string[]; readOnly?: boolean; down?: boolean; rate?: number; downAfterOrderPages?: number }; calls: string[] }
const shops = new Map<string, Shop>();
const newShop = (host: string): Shop => { const s: Shop = { orders: [], customers: [], products: [], refunds: new Map(), webhooks: [], mode: {}, calls: [] }; shops.set(host, s); return s; };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function transport(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url); const shop = shops.get(u.host);
  if (!shop) return Promise.reject(new Error("getaddrinfo ENOTFOUND"));
  const method = (init.method ?? "GET").toUpperCase(); const path = u.pathname.replace("/wp-json/wc/v3", "");
  shop.calls.push(`${method} ${path}`);
  if (shop.mode.downAfterOrderPages !== undefined && method === "GET" && path === "/orders") { if (shop.mode.downAfterOrderPages === 0) shop.mode.down = true; else shop.mode.downAfterOrderPages--; }
  if (shop.mode.down) return Promise.resolve(json({ message: "down" }, 503));
  if (shop.mode.rate) { shop.mode.rate--; return Promise.resolve(json({ code: "rate" }, 429, { "retry-after": "1" })); }
  const resource = path.split("/")[1];
  if (shop.mode.deny?.includes(resource)) return Promise.resolve(json({ code: "woocommerce_rest_cannot_view", message: "no" }, 403));
  if (method !== "GET" && resource === "webhooks" && shop.mode.readOnly) return Promise.resolve(json({ code: "woocommerce_rest_cannot_create", message: "no" }, 401));
  const list = (items: Obj[]) => {
    const per = Number(u.searchParams.get("per_page") ?? 10), page = Number(u.searchParams.get("page") ?? 1);
    const after = u.searchParams.get("after"), mod = u.searchParams.get("modified_after");
    const f = items.filter((x) => (!after || new Date(`${x.date_created_gmt}Z`) > new Date(after)) && (!mod || new Date(`${x.date_modified_gmt}Z`) > new Date(mod))).sort((a, b) => a.id - b.id);
    return json(f.slice((page - 1) * per, page * per), 200, { "x-wp-total": String(f.length), "x-wp-totalpages": String(Math.max(1, Math.ceil(f.length / per))) });
  };
  if (resource === "system_status") return Promise.resolve(json({ environment: { site_url: `https://${u.host}` } }));
  if (resource === "webhooks") {
    const id = Number(path.split("/")[2]);
    if (method === "GET") return Promise.resolve(json(shop.webhooks));
    if (method === "POST") { const w = { id: shop.webhooks.length + 1, ...JSON.parse(String(init.body)) }; shop.webhooks.push(w); return Promise.resolve(json(w, 201)); }
    if (method === "PUT") { const w = shop.webhooks.find((x) => x.id === id)!; Object.assign(w, JSON.parse(String(init.body))); return Promise.resolve(json(w)); }
    if (method === "DELETE") { shop.webhooks = shop.webhooks.filter((x) => x.id !== id); return Promise.resolve(json({ id })); }
  }
  if (resource === "orders" && path.endsWith("/refunds")) return Promise.resolve(json(shop.refunds.get(Number(path.split("/")[2])) ?? []));
  if (resource === "orders") return Promise.resolve(list(shop.orders));
  if (resource === "customers") return Promise.resolve(list(shop.customers));
  if (resource === "products") return Promise.resolve(list(shop.products));
  return Promise.resolve(json({ code: "rest_no_route" }, 404));
}
const gmt = (daysAgo: number, min = 0) => new Date(Date.now() - daysAgo * 86400_000 + min * 60_000).toISOString().replace(/\.\d+Z$/, "");
let seq = 0;
const order = (o: Partial<Obj> & { id: number }) => ({ number: String(o.id), status: "processing", currency: "ILS", total: "200.00", date_created_gmt: gmt(10), date_modified_gmt: gmt(10), date_paid_gmt: gmt(10), payment_method: "payplus-payment-gateway", payment_method_title: "PayPlus", transaction_id: `tx${o.id}`,
  billing: { first_name: "נועה", last_name: "לוי", phone: `05${String(20000000 + ++seq)}`, email: `c${seq}@example.com` }, shipping: {}, customer_id: 0, refunds: [], meta_data: [],
  line_items: [{ id: o.id * 10, name: "פרוביוטיקה", product_id: 5, variation_id: 0, sku: "PRO-30", quantity: 2, price: 100, subtotal: "200", total: "200", total_tax: "0", meta_data: [] }], ...o });

// ─── Test setup ─────────────────────────────────────────────────────────────────────────────────────────────────
let A: Awaited<ReturnType<typeof createBusiness>>, B: Awaited<ReturnType<typeof createBusiness>>;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const mkStore = async (biz: typeof A, name = "W") => db.storeConnection.create({ data: { businessId: biz.business.id, platform: "woocommerce", name, publicKey: newPublicKey(), config: sealStoreConfig({}) } });
const creds = (host: string) => ({ siteUrl: `https://${host}`, consumerKey: "ck_test_1234567890", consumerSecret: "cs_test_1234567890" });
const deliver = async (storeId: string, topic: string, payload: unknown, opts: { delivery?: string; secret?: string } = {}) => {
  const s = await db.storeConnection.findUniqueOrThrow({ where: { id: storeId } });
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", opts.secret ?? storeSecret(s)).update(raw, "utf8").digest("base64");
  return webhookPOST(new Request(`http://localhost/api/webhooks/stores/woocommerce/${storeId}`, { method: "POST", body: raw, headers: { "x-wc-webhook-signature": sig, "x-wc-webhook-topic": topic, "x-wc-webhook-delivery-id": opts.delivery ?? crypto.randomUUID() } }), { params: Promise.resolve({ storeId }) });
};
const syncAll = async (u: SessionUser, storeId: string) => { for (let i = 0; i < 20; i++) { const st = await run(u, () => runSyncStep(storeId, Date.now() + 10_000)); if (!st || st.status !== "running") return st; await db.storeConnection.update({ where: { id: storeId }, data: { syncState: { ...(st as object), nextAt: undefined } as never } }); } throw new Error("sync did not finish"); };

describe("WooCommerce connection end to end", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    setWooTransportForTests((url, init) => transport(url, init));
    A = await createBusiness("woo-a", { modules: { crm: true, messaging: true } }); B = await createBusiness("woo-b", { modules: { crm: true, messaging: true } });
    accounts.push(A.account.id, B.account.id);
  }, 900_000);
  afterEach(() => { for (const s of shops.values()) s.mode = {}; });
  afterAll(async () => { setWooTransportForTests(null); if (A) await destroyBusiness(A.business.id); if (B) await destroyBusiness(B.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("connect: real checks per resource, 8 webhooks with our secret, sealed keys; reconnect repairs instead of duplicating", async () => {
    const shop = newShop("good.example.com");
    const s = await mkStore(A);
    const r = await run(A.session, () => connectWoo(s, creds("good.example.com")));
    expect(r.access).toMatchObject({ orders: true, customers: true, products: true, webhooksRead: true });
    expect(shop.webhooks).toHaveLength(8);
    expect(new Set(shop.webhooks.map((w) => w.secret)).size).toBe(1);
    const saved = await db.storeConnection.findUniqueOrThrow({ where: { id: s.id } });
    expect(JSON.stringify(saved.config)).not.toContain("cs_test_1234567890");
    expect(saved).toMatchObject({ apiStatus: "ok", webhookStatus: "configured" });
    expect((await run(A.session, () => storeHealth(saved))).webhooks.status).toBe("waiting_verification"); // configured ≠ verified
    shop.webhooks[0].status = "disabled"; shop.webhooks.push({ ...shop.webhooks[1], id: 99 }); // WooCommerce disabled one; a stray duplicate
    await run(A.session, () => connectWoo(saved, creds("good.example.com")));
    expect(shop.webhooks).toHaveLength(8);
    expect(shop.webhooks.every((w) => w.status === "active")).toBe(true);
  });

  it("missing permissions are explained and nothing is saved; a read-only key → manual webhook instructions", async () => {
    const shop = newShop("denied.example.com"); shop.mode.deny = ["orders"];
    const s = await mkStore(A);
    await expect(run(A.session, () => connectWoo(s, creds("denied.example.com")))).rejects.toMatchObject({ code: "woo_permission" });
    const after = await db.storeConnection.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.apiStatus).toBe("failed"); expect(JSON.stringify(after.config)).not.toContain("ck_test");
    await expect(run(A.session, () => connectWoo(s, creds("nowhere.example.com")))).rejects.toMatchObject({ code: "woo_unreachable" });
    const ro = newShop("readonly.example.com"); ro.mode.readOnly = true;
    const s2 = await mkStore(A);
    const r = await run(A.session, () => connectWoo(s2, creds("readonly.example.com")));
    expect(r.webhooks.status).toBe("manual_required");
    expect(r.webhooks.manual?.deliveryUrl).toContain(`/api/webhooks/stores/woocommerce/${s2.id}`);
    expect(r.webhooks.manual?.topics).toHaveLength(8);
  });

  let store: Awaited<ReturnType<typeof mkStore>>; let shop: Shop;
  it("initial import: preview counts, existing order with bundle + refund, silent (no automations / carts / leads), existing CRM contact linked", async () => {
    shop = newShop("shop-a.example.com");
    const existing = await db.contact.create({ data: { businessId: A.business.id, fullName: "שם מה-CRM", phoneE164: "+972521112233", phoneRaw: "x" } });
    shop.customers.push({ id: 7, email: "noa@example.com", first_name: "נועה", last_name: "שם מהחנות", billing: { phone: "052-111-2233" }, date_modified_gmt: gmt(20) });
    shop.products.push({ id: 5, name: "פרוביוטיקה", sku: "PRO-30", type: "simple", status: "publish", price: "100", date_modified_gmt: gmt(30) });
    shop.orders.push(order({ id: 100, customer_id: 7, billing: { first_name: "נועה", last_name: "", phone: "+972 52-111-2233", email: "noa@example.com" }, refunds: [{ id: 1, total: "-100" }],
      line_items: [
        { id: 1000, name: "מארז בוקר", product_id: 8, quantity: 1, price: 300, subtotal: "300", total: "300", total_tax: "0", meta_data: [{ key: "_bundle_cart_key", value: "k1" }, { key: "_bundled_items", value: ["x"] }] },
        { id: 1001, name: "מגנזיום", product_id: 9, quantity: 2, price: 0, subtotal: "0", total: "0", total_tax: "0", meta_data: [{ key: "_bundled_by", value: "k1" }] },
      ] }));
    shop.refunds.set(100, [{ id: 1, line_items: [{ quantity: -1, meta_data: [{ key: "_refunded_item_id", value: "1001" }] }] }]);
    store = await mkStore(A, "shop A");
    await run(A.session, () => connectWoo(store, creds("shop-a.example.com")));
    store = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(await run(A.session, () => previewSync(store, { orders: "365", customers: true, products: true }))).toEqual({ customers: 1, products: 1, orders: 1 });
    const eventsBefore = await db.domainEvent.count({ where: { businessId: A.business.id } });
    await run(A.session, () => startSync(store, { orders: "365", customers: true, products: true }, "initial"));
    const st = await syncAll(A.session, store.id);
    expect(st).toMatchObject({ status: "done" });
    const o = await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "100" } });
    expect(o).toMatchObject({ imported: true, contactId: existing.id, status: "partially_refunded" });
    expect(o.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: "1001", kind: "component", parentKey: "1000", refundedQuantity: 1 })]));
    expect(o.payment).toMatchObject({ transactionId: "tx100", title: "PayPlus" });
    expect(await db.contact.count({ where: { businessId: A.business.id, phoneE164: "+972521112233" } })).toBe(1);
    expect((await db.contact.findUniqueOrThrow({ where: { id: existing.id } })).fullName).toBe("שם מה-CRM"); // CRM field not overwritten
    expect((await db.contact.findUniqueOrThrow({ where: { id: existing.id } })).customerSince).not.toBeNull(); // existing customer, not a new lead
    expect(await db.lead.count({ where: { contactId: existing.id } })).toBe(0);
    expect(await db.cart.count({ where: { storeId: store.id } })).toBe(0); // no abandoned-cart flow
    expect(await db.domainEvent.count({ where: { businessId: A.business.id, createdAt: { gte: new Date(Date.now() - 60_000) }, type: { in: ["contact.created", "lead.created", "cart.abandoned"] } } })).toBe(0);
    void eventsBefore;
    expect(await db.storeProduct.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("a new order and its update via signed webhook; unsigned is refused; the event is verified", async () => {
    const o = order({ id: 101, date_created_gmt: gmt(0, -5), date_modified_gmt: gmt(0, -5) });
    expect((await deliver(store.id, "order.created", o, { secret: "wrong-secret" })).status).toBe(401);
    expect((await deliver(store.id, "order.created", o)).status).toBe(200);
    const saved = await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "101" } });
    expect(saved).toMatchObject({ imported: false, status: "processing" });
    const upd = { ...o, status: "completed", date_modified_gmt: gmt(0, -1), line_items: [{ ...o.line_items[0], quantity: 3 }] };
    await deliver(store.id, "order.updated", upd);
    const after = await db.storeOrder.findUniqueOrThrow({ where: { id: saved.id } });
    expect(after.status).toBe("completed");
    expect(JSON.stringify(after.changes)).toContain("quantity_changed");
    expect((await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } })).webhookStatus).toBe("verified");
  });

  it("cancel and refund", async () => {
    const o = order({ id: 102, date_modified_gmt: gmt(0, -10) });
    await deliver(store.id, "order.created", o);
    await deliver(store.id, "order.updated", { ...o, status: "cancelled", date_modified_gmt: gmt(0, -9) });
    expect((await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "102" } })).status).toBe("cancelled");
    const r = order({ id: 103, date_modified_gmt: gmt(0, -8) });
    shop.refunds.set(103, [{ id: 2, line_items: [{ quantity: -2, meta_data: [{ key: "_refunded_item_id", value: "1030" }] }] }]);
    await deliver(store.id, "order.updated", { ...r, status: "refunded", refunds: [{ id: 2, total: "-200" }] });
    const ref = await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "103" } });
    expect(ref.status).toBe("refunded");
    expect(ref.items).toEqual([expect.objectContaining({ key: "1030", refundedQuantity: 2 })]);
  });

  it("a duplicate delivery is one event; an older event arriving late never overwrites newer data", async () => {
    const o = order({ id: 104, status: "completed", date_modified_gmt: gmt(0, -2) });
    const delivery = crypto.randomUUID();
    await deliver(store.id, "order.updated", o, { delivery });
    const dup = await deliver(store.id, "order.updated", o, { delivery });
    expect(await dup.text()).toBe("duplicate");
    expect(await db.storeEvent.count({ where: { storeId: store.id, resourceId: "104" } })).toBe(1);
    await deliver(store.id, "order.updated", { ...o, status: "processing", date_modified_gmt: gmt(0, -30) }); // older version, arrives after
    expect((await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "104" } })).status).toBe("completed");
    expect(await db.storeEvent.count({ where: { storeId: store.id, resourceId: "104", status: "stale" } })).toBe(1);
  });

  it("an outage during sync pauses and resumes from the same page; reconcile catches what webhooks missed", async () => {
    for (let i = 0; i < 60; i++) shop.orders.push(order({ id: 200 + i, date_created_gmt: gmt(5), date_modified_gmt: gmt(5) }));
    await db.storeConnection.update({ where: { id: store.id }, data: { syncState: undefined } });
    store = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    await run(A.session, () => startSync(store, { orders: "30", customers: false, products: false }, "initial"));
    shop.mode.downAfterOrderPages = 1; // the first page goes through, then the store is unreachable
    let st = await run(A.session, () => runSyncStep(store.id, Date.now() + 10_000));
    expect(st).toMatchObject({ status: "running", consecutiveErrors: 1 }); expect(st!.nextAt).toBeTruthy();
    expect(st!.resources.orders!.page).toBe(1);
    const pageAtOutage = st!.resources.orders!.page;
    shop.mode = {};
    await db.storeConnection.update({ where: { id: store.id }, data: { syncState: { ...(st as object), nextAt: undefined } as never } });
    st = await syncAll(A.session, store.id);
    expect(st).toMatchObject({ status: "done" }); expect(st!.resources.orders!.page).toBeGreaterThan(pageAtOutage);
    expect(await db.storeOrder.count({ where: { businessId: A.business.id, storeId: store.id, orderNumber: { in: shop.orders.filter((o) => o.id >= 200).map((o) => String(o.id)) } } })).toBe(60);
    // A change the webhook never delivered (store was unreachable for us) → reconcile.
    const missed = shop.orders.find((o) => o.id === 259)!; missed.status = "completed"; missed.date_modified_gmt = gmt(0, 1);
    store = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    await run(A.session, () => startReconcile(store));
    await syncAll(A.session, store.id);
    expect((await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "259" } })).status).toBe("completed");
  });

  it("a rate limit (429 + Retry-After) waits and resumes – nothing is lost", async () => {
    await db.storeConnection.update({ where: { id: store.id }, data: { syncState: undefined } });
    store = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    await run(A.session, () => startSync(store, { orders: "30", customers: false, products: false }, "initial"));
    shop.mode.rate = 1;
    const st = await run(A.session, () => runSyncStep(store.id, Date.now() + 10_000));
    expect(st).toMatchObject({ status: "running" });
    expect(new Date(st!.nextAt!).getTime()).toBeGreaterThan(Date.now()); // honours Retry-After
    expect(st!.errors.at(-1)).toContain("קצב");
    await db.storeConnection.update({ where: { id: store.id }, data: { syncState: { ...(st as object), nextAt: undefined } as never } });
    expect(await syncAll(A.session, store.id)).toMatchObject({ status: "done" });
  });

  it("a receipt from a separate invoicing system attaches to the store order (and a mismatch stays visible)", async () => {
    const { key } = await run(A.session, () => createApiKey(A.session, "invoicing"));
    const res = await receiptPOST(new Request("http://localhost/api/v1/orders/receipts", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ orderNumber: "101", source: "icount", receipt: { number: "R-55", items: [{ name: "פרוביוטיקה", quantity: 2 }] } }) }));
    expect(res.status).toBe(200);
    const o = await db.storeOrder.findFirstOrThrow({ where: { businessId: A.business.id, orderNumber: "101" } });
    expect(o.receipt).toMatchObject({ number: "R-55", source: "icount" });
    const { checkMissingItem } = await import("@/server/ai/missing-items");
    const contact = await db.contact.findUniqueOrThrow({ where: { id: o.contactId! } });
    const r = await run(A.session, () => checkMissingItem({ businessId: A.business.id, contact, product: "פרוביוטיקה", orderNumber: "101" }));
    expect(r.finding).toBe("conflict"); // order has 3 (after the update), receipt 2 → a person decides
  });

  it("two businesses (and two stores of one business) with the same order ids never mix", async () => {
    const same = order({ id: 100, status: "completed", date_modified_gmt: gmt(0, -3) });
    const shopB = newShop("shop-b.example.com"); void shopB;
    let sb = await mkStore(B, "shop B");
    await run(B.session, () => connectWoo(sb, creds("shop-b.example.com")));
    sb = await db.storeConnection.findUniqueOrThrow({ where: { id: sb.id } });
    await deliver(sb.id, "order.created", same);
    const a2 = newShop("shop-a2.example.com"); void a2;
    let s2 = await mkStore(A, "shop A2");
    await run(A.session, () => connectWoo(s2, creds("shop-a2.example.com")));
    s2 = await db.storeConnection.findUniqueOrThrow({ where: { id: s2.id } });
    await deliver(s2.id, "order.created", same);
    const inA = await db.storeOrder.findMany({ where: { businessId: A.business.id, orderNumber: "100" } });
    expect(inA.map((o) => o.storeId).sort()).toEqual([store.id, s2.id].sort());
    expect(inA.find((o) => o.storeId === store.id)!.status).toBe("partially_refunded"); // untouched
    expect(await db.storeOrder.count({ where: { businessId: B.business.id, orderNumber: "100" } })).toBe(1);
    // A delivery signed for B's store cannot write into A.
    expect((await deliver(store.id, "order.updated", same, { secret: storeSecret(sb) })).status).toBe(401);
  });

  it("disconnect keeps customers, orders and history; stale data is not presented as real-time", async () => {
    const before = await db.storeOrder.count({ where: { storeId: store.id } });
    await run(A.session, () => recheckWoo(store));
    store = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(storeFreshness(store).fresh).toBe(true);
    await run(A.session, () => disconnectWoo(store, { removeWebhooks: true }));
    const after = await db.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(after).toMatchObject({ isActive: false, apiStatus: "none" });
    expect(JSON.stringify(after.config)).not.toContain("consumerKey");
    expect(await db.storeOrder.count({ where: { storeId: store.id } })).toBe(before);
    expect(await db.storeCustomer.count({ where: { storeId: store.id } })).toBeGreaterThan(0);
    expect(shops.get("shop-a.example.com")!.webhooks).toHaveLength(0);
    expect(storeFreshness(after).fresh).toBe(false);
    expect((await deliver(store.id, "order.updated", order({ id: 100 }))).status).toBe(404);
    expect((await run(A.session, () => processStoreEvents({ storeId: store.id }))).failed).toBe(0);
  });
});
