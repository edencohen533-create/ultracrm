/**
 * Missing-item complaints against real order data (real DB; the model is stubbed – no real AI call).
 * Covered: not ordered, ordered and not received, partial quantity, bundle, gift, split shipment, several orders,
 * documented promise / claimed promise without a record, receipt vs order conflict, one case per complaint,
 * isolation (another customer's order, another business), Shopify / WooCommerce translation, and the agent itself in
 * automatic and suggestion modes (fixed wording, handoff, nothing sent without approval).
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, afterEach, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { checkMissingItem, productMatches } from "@/server/ai/missing-items";
import { upsertStoreOrder, shopifyOrderSnapshot, wooOrderSnapshot, type OrderSnapshot } from "@/server/services/store-order-service";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { handleServiceInbound } = await import("@/server/ai/service-agent");
const { createInboundMessage } = await import("@/server/services/message-service");
const { GET: sugGET, POST: sugPOST } = await import("@/app/api/conversations/[id]/ai/suggestion/route");

let A: Awaited<ReturnType<typeof createBusiness>>, B: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let n = 0;
const person = async (biz = A, phone?: string) => { n++; const e164 = phone ?? `+97253${String(1000000 + n).slice(-7)}`; return db.contact.create({ data: { businessId: biz.business.id, fullName: `לקוחה ${n}`, phoneE164: e164, phoneRaw: e164 } }); };
const order = (c: { phoneE164: string }, o: Partial<OrderSnapshot> & { items: OrderSnapshot["items"] }, biz = A, u = owner) =>
  run(u, () => upsertStoreOrder(biz.business.id, "api", { externalId: crypto.randomUUID(), orderNumber: `#${1000 + ++n}`, status: "completed", phone: c.phoneE164, placedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), ...o }));
const check = (c: { id: string; phoneE164: string }, product: string, extra: { quantity?: number; orderNumber?: string; promised?: boolean } = {}, biz = A, u = owner) =>
  run(u, () => checkMissingItem({ businessId: biz.business.id, contact: c, product, ...extra }));
const NO_BLAME = /טועה|טעית|לא נכון/;
const NO_PROMISE = /נשלח לך מחדש|נחזיר|החזר כספי|זיכוי|נשלים/;

describe("missing-item complaints", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("missing-a", { modules: { crm: true, messaging: true } });
    B = await createBusiness("missing-b", { modules: { crm: true, messaging: true } });
    accounts.push(A.account.id, B.account.id); owner = A.session;
  }, 900_000);
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });
  afterAll(async () => { if (A) await destroyBusiness(A.business.id); if (B) await destroyBusiness(B.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("matches a product as the customer writes it (Hebrew prefixes), not by a loose word", () => {
    expect(productMatches("המגנזיום", "מגנזיום ביסגליצינט 60 כמוסות")).toBe(true);
    expect(productMatches("מגנזיום", "פרוביוטיקה 30")).toBe(false);
    expect(productMatches("ויטמין D", "ויטמין D3 2000")).toBe(true);
  });

  it("not ordered: explains gently what the order contains; no blame, no promise; kept as an informed inquiry", async () => {
    const c = await person();
    const o = await order(c, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 3, kind: "product" }] });
    const r = await check(c, "מגנזיום");
    expect(r).toMatchObject({ finding: "not_ordered", action: "reply", orderedQuantity: 0 });
    expect(r.customerMessage).toContain(o.orderNumber); expect(r.customerMessage).toContain("3 × פרוביוטיקה");
    expect(r.customerMessage).toContain("אם המוצר הובטח לך");
    expect(r.customerMessage).not.toMatch(NO_BLAME); expect(r.customerMessage).not.toMatch(NO_PROMISE);
    expect(await db.serviceCase.findUniqueOrThrow({ where: { id: r.caseId! } })).toMatchObject({ status: "informed", finding: "not_ordered", orderId: o.id });
  });

  it("ordered and not received: opens a delivery inquiry with product, quantity and order – no replacement / refund promise", async () => {
    const c = await person();
    const o = await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 2, kind: "product" }], shipments: [{ key: "s1", status: "delivered", items: [] }] });
    const r = await check(c, "מגנזיום", { quantity: 1 });
    expect(r).toMatchObject({ finding: "ordered_not_received", action: "handoff", orderedQuantity: 2 });
    expect(r.customerMessage).toContain("פתחתי בירור"); expect(r.customerMessage).not.toMatch(NO_PROMISE);
    expect(r.agentSummary).toContain(o.orderNumber); expect(r.agentSummary).toContain("נמסר\" אינם מוכיחים");
    // Same complaint again → the same inquiry, no duplicate.
    const again = await check(c, "המגנזיום", { quantity: 1 });
    expect(again.caseId).toBe(r.caseId); expect(again.duplicateCase).toBe(true);
    expect(await db.serviceCase.count({ where: { contactId: c.id } })).toBe(1);
  });

  it("partial quantity: states what was ordered and opens an inquiry for it", async () => {
    const c = await person();
    await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 2, kind: "product" }] });
    const r = await check(c, "מגנזיום", { quantity: 3 });
    expect(r).toMatchObject({ finding: "partial", orderedQuantity: 2 });
    expect(r.customerMessage).toContain("2 יחידות של מגנזיום");
  });

  it("bundle and gift: a product inside a bundle (as sold) or given as a gift IS ordered", async () => {
    const c = await person();
    await order(c, { items: [{ key: "b", name: "מארז שינה טובה", quantity: 1, kind: "bundle", components: [{ name: "מגנזיום", quantity: 1 }, { name: "מלטונין", quantity: 1 }] }] });
    expect(await check(c, "מגנזיום")).toMatchObject({ finding: "ordered_not_received", orderedQuantity: 1 });
    const g = await person();
    await order(g, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 1, kind: "product" }, { key: "2", name: "ויטמין C", quantity: 1, price: 0, kind: "gift" }] });
    const r = await check(g, "ויטמין C");
    expect(r).toMatchObject({ finding: "ordered_not_received", orderedQuantity: 1 });
    expect(r.order!.lines.join(" ")).toContain("(מתנה)");
  });

  it("split shipment: the item travels in a separate parcel – verified status and tracking only", async () => {
    const c = await person();
    await order(c, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 1, kind: "product" }, { key: "2", name: "מגנזיום", quantity: 1, kind: "product" }], shipments: [
      { key: "p1", status: "delivered", items: [{ key: "1", name: "פרוביוטיקה", quantity: 1 }] },
      { key: "p2", status: "shipped", carrier: "שליחויות", tracking: "TRK123", items: [{ key: "2", name: "מגנזיום", quantity: 1 }] },
    ] });
    const r = await check(c, "מגנזיום");
    expect(r).toMatchObject({ finding: "shipped_separately", action: "handoff" });
    expect(r.customerMessage).toContain("TRK123"); expect(r.customerMessage).toContain("בדרך");
  });

  it("several possible orders: one focused question before any conclusion", async () => {
    const c = await person();
    const o1 = await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 1, kind: "product" }] });
    const o2 = await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 2, kind: "product" }] });
    const r = await check(c, "מגנזיום");
    expect(r).toMatchObject({ finding: "needs_info", action: "ask", caseId: null });
    expect(r.customerMessage).toContain(o1.orderNumber); expect(r.customerMessage).toContain(o2.orderNumber);
    // With the order number the conclusion is about that order.
    expect(await check(c, "מגנזיום", { orderNumber: o2.orderNumber })).toMatchObject({ finding: "ordered_not_received", orderedQuantity: 2 });
  });

  it("promise: a documented one goes to a person with the exact reference; a claimed one without a record too", async () => {
    const c = await person();
    await order(c, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 1, kind: "product" }] });
    const conv = await db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, channel: "whatsapp" } });
    const msg = await db.message.create({ data: { businessId: A.business.id, conversationId: conv.id, channel: "whatsapp", direction: "OUTBOUND", type: "TEXT", body: "נצרף לך מגנזיום במתנה להזמנה 🎁", status: "DELIVERED" } });
    const r = await check(c, "מגנזיום");
    expect(r).toMatchObject({ finding: "promised", action: "handoff" });
    expect(r.sources.find((s) => s.type === "message")?.id).toBe(msg.id);
    const d = await person();
    await order(d, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 1, kind: "product" }] });
    const r2 = await check(d, "מגנזיום", { promised: true });
    expect(r2).toMatchObject({ finding: "promised", action: "handoff" });
    expect(r2.agentSummary).toContain("היעדר תיעוד אינו מוכיח");
  });

  it("receipt vs order disagree: no source is picked – a person decides, both sides shown", async () => {
    const c = await person();
    await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 1, kind: "product" }], receipt: { number: "R-77", items: [{ name: "מגנזיום", quantity: 2 }] } });
    const r = await check(c, "מגנזיום");
    expect(r).toMatchObject({ finding: "conflict", action: "handoff" });
    expect(r.agentSummary).toContain("בקבלה 2 יחידות של מגנזיום, ובהזמנה 1");
  });

  it("isolation: another customer's order number and another business are never revealed", async () => {
    const mine = await person(); const other = await person();
    await order(mine, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 1, kind: "product" }] });
    const theirs = await order(other, { items: [{ key: "1", name: "מגנזיום", quantity: 5, kind: "product" }] });
    const r = await check(mine, "מגנזיום", { orderNumber: theirs.orderNumber });
    expect(r).toMatchObject({ finding: "needs_info", order: null });
    expect(JSON.stringify(r)).not.toContain("5 ×");
    // Same phone in business B: B's orders only.
    const inB = await person(B, mine.phoneE164);
    await order(inB, { items: [{ key: "1", name: "מגנזיום", quantity: 9, kind: "product" }] }, B, B.session);
    const rA = await check(mine, "מגנזיום");
    expect(rA.orderedQuantity ?? 0).toBe(0);
    const rB = await check(inB, "מגנזיום", {}, B, B.session);
    expect(rB.orderedQuantity).toBe(9);
    expect(await run(owner, () => db.storeOrder.count({ where: { businessId: A.business.id, contactId: inB.id } }))).toBe(0);
  });

  it("order changes are kept with their time (an item removed after purchase)", async () => {
    const c = await person();
    const o = await order(c, { externalId: "edit-1", items: [{ key: "1", name: "מגנזיום", quantity: 1, kind: "product" }, { key: "2", name: "פרוביוטיקה", quantity: 1, kind: "product" }] });
    await run(owner, () => upsertStoreOrder(A.business.id, "api", { externalId: "edit-1", orderNumber: o.orderNumber, status: "completed", phone: c.phoneE164, items: [{ key: "2", name: "פרוביוטיקה", quantity: 1, kind: "product" }] }));
    const r = await check(c, "מגנזיום");
    expect(r.finding).toBe("not_ordered");
    expect(r.sources.some((s) => s.type === "change" && s.label.includes("item_removed"))).toBe(true);
  });

  it("platform payloads: WooCommerce bundle components and Shopify bundles / refunds / split fulfillments", () => {
    const woo = wooOrderSnapshot({ id: 55, number: "55", status: "completed", total: "300", currency: "ILS", billing: { phone: "0501234567" }, line_items: [
      { id: 1, name: "מארז שינה", quantity: 1, price: 300, total: "300", meta_data: [{ key: "_bundle_cart_key", value: "abc" }, { key: "_bundled_items", value: ["x"] }] },
      { id: 2, name: "מגנזיום", quantity: 1, price: 0, total: "0", meta_data: [{ key: "_bundled_by", value: "abc" }] },
      { id: 3, name: "ויטמין C", quantity: 1, price: 0, total: "0", meta_data: [] },
    ] });
    expect(woo.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: "1", kind: "bundle" }), expect.objectContaining({ key: "2", kind: "component", parentKey: "1" }), expect.objectContaining({ key: "3", kind: "gift" })]));
    const shop = shopifyOrderSnapshot({ id: 9, name: "#1009", financial_status: "partially_refunded", created_at: new Date().toISOString(),
      sales_line_item_groups: [{ id: 7, title: "מארז בוקר", quantity: 1 }],
      line_items: [{ id: 11, title: "מגנזיום", quantity: 2, current_quantity: 2, price: "50", sales_line_item_group_id: 7 }, { id: 12, title: "פרוביוטיקה", quantity: 3, current_quantity: 3, price: "40" }],
      refunds: [{ refund_line_items: [{ line_item_id: 12, quantity: 1 }] }],
      fulfillments: [{ id: 100, status: "success", shipment_status: "delivered", tracking_number: "A1", line_items: [{ id: 12, title: "פרוביוטיקה", quantity: 2 }] }, { id: 101, status: "success", shipment_status: "in_transit", tracking_number: "B2", line_items: [{ id: 11, title: "מגנזיום", quantity: 2 }] }] });
    expect(shop.status).toBe("partially_refunded");
    expect(shop.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: "group:7", kind: "bundle" }), expect.objectContaining({ key: "11", kind: "component", parentKey: "group:7" }), expect.objectContaining({ key: "12", refundedQuantity: 1 })]));
    expect(shop.shipments!.map((s) => s.status)).toEqual(["delivered", "shipped"]);
  });

  describe("the service agent (model stubbed)", () => {
    const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `tu_${crypto.randomUUID()}`, name, input });
    const stub = (steps: Array<Array<Record<string, unknown>>>) => {
      const script = [...steps]; process.env.ANTHROPIC_API_KEY = "test-key-not-real";
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (!String(url).includes("/v1/messages")) throw new Error(`unexpected fetch ${url}`);
        const content = script.shift() ?? [{ type: "text", text: "..." }];
        return new Response(JSON.stringify({ content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" }), { status: 200 });
      }));
    };
    const setMode = async (replyMode: "auto" | "suggest") => {
      const biz = await db.business.findUniqueOrThrow({ where: { id: A.business.id } });
      await db.business.update({ where: { id: A.business.id }, data: { settings: { ...((biz.settings ?? {}) as object), ai: { service: { enabled: true, credentialIds: ["demo"], hours: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, handoffTopics: [], replyMode } } } } });
    };

    it("automatic mode: the checked wording is sent as is (the model does not rephrase it)", async () => {
      await setMode("auto");
      const c = await person();
      await order(c, { items: [{ key: "1", name: "פרוביוטיקה", quantity: 3, kind: "product" }] });
      const m = await run(owner, () => createInboundMessage({ contactId: c.id, providerCredentialId: null, body: "לא קיבלתי את המגנזיום", source: "MOCK" as never }));
      stub([[tool("check_missing_item", { product: "מגנזיום" })], [{ type: "text", text: "את טועה, הזמנת רק פרוביוטיקה. אולי תרצי להזמין מגנזיום?" }]]);
      // The inbound message also triggers the regular event handler – whichever runs first answers, exactly once.
      const r = await run(owner, () => handleServiceInbound(A.business.id, { messageId: m.message.id, channel: "whatsapp" }));
      expect(["executed", "skipped"]).toContain(r.status);
      let sent = null as Awaited<ReturnType<typeof db.message.findFirst>>;
      for (let i = 0; i < 30 && !sent; i++) { sent = await db.message.findFirst({ where: { requestKey: `ai:svc:${m.message.id}` } }); if (!sent) await new Promise((x) => setTimeout(x, 300)); }
      if (!sent) throw new Error(`no reply sent (${JSON.stringify(r)})`);
      expect(await db.message.count({ where: { requestKey: `ai:svc:${m.message.id}` } })).toBe(1);
      expect(sent.body).toContain("3 × פרוביוטיקה"); expect(sent.body).not.toMatch(NO_BLAME); expect(sent.body).not.toContain("להזמין");
      expect(await db.serviceCase.count({ where: { contactId: c.id } })).toBe(1);
    });

    it("suggestion mode: nothing is sent – the reply waits for an agent, who approves (edited) or dismisses", async () => {
      await setMode("suggest");
      const c = await person();
      await order(c, { items: [{ key: "1", name: "מגנזיום", quantity: 1, kind: "product" }] });
      const m = await run(owner, () => createInboundMessage({ contactId: c.id, providerCredentialId: null, body: "המגנזיום לא הגיע", source: "MOCK" as never }));
      stub([[tool("check_missing_item", { product: "מגנזיום" })]]);
      const r = await run(owner, () => handleServiceInbound(A.business.id, { messageId: m.message.id, channel: "whatsapp" }));
      expect(["proposed", "skipped"]).toContain(r.status);
      for (let i = 0; i < 30 && !(await db.aiAction.count({ where: { kind: "service_reply", status: "proposed", params: { path: ["inboundMessageId"], equals: m.message.id } } })); i++) await new Promise((x) => setTimeout(x, 300));
      expect(await db.message.count({ where: { requestKey: `ai:svc:${m.message.id}` } })).toBe(0);
      const conv = await db.conversation.findFirstOrThrow({ where: { contactId: c.id } });
      expect(conv.aiMode).toBe("handoff"); expect(conv.aiHandoffSummary).toContain("מגנזיום");
      const req = async (method: string, body?: unknown) => new NextRequest(`http://localhost/api/conversations/${conv.id}/ai/suggestion`, { method, headers: { cookie: `ultracrm_session=${await signSession(owner)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const got = await (await sugGET(await req("GET"), { params: Promise.resolve({ id: conv.id }) })).json();
      expect(got.data.text).toContain("פתחתי בירור");
      const sent = await sugPOST(await req("POST", { actionId: got.data.id, decision: "send", text: `${got.data.text} (נבדק על ידי נציג)` }), { params: Promise.resolve({ id: conv.id }) });
      expect(sent.status).toBe(200);
      const out = await db.message.findFirstOrThrow({ where: { requestKey: `ai:svc-approved:${got.data.id}` } });
      expect(out.body).toContain("(נבדק על ידי נציג)"); expect(out.sentByUserId).toBe(owner.id);
      const twice = await sugPOST(await req("POST", { actionId: got.data.id, decision: "send" }), { params: Promise.resolve({ id: conv.id }) });
      expect(twice.status).toBe(409);
    });
  });
});
