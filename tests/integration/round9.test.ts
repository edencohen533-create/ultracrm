/**
 * Round 9 on the real DB (external HTTP stubbed): store API connect (Shopify / WooCommerce) + SSRF guard,
 * public API keys + /api/v1/leads, outgoing signed webhooks with retry, Excel lead import with agent assignment,
 * WhatsApp notification to the agent, lead-quality report metrics, "deal closed" with products + renewal dialer.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

// Service integration tests stub transport; DNS resolution, IP pinning and TLS identity are verified separately.
vi.mock("@/lib/safe-url", async (original) => {
  const actual = await original<typeof import("@/lib/safe-url")>();
  return { ...actual, safeFetch: (url: string, init?: RequestInit) => { actual.assertPublicHttpsUrl(url); return fetch(url, { ...init, redirect: "manual" }); } };
});

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { connectShopify, connectWooCommerce } = await import("@/server/services/store-api");
const { newPublicKey, sealStoreConfig } = await import("@/server/services/cart-service");
const { createApiKey, createEndpoint, deliverDueWebhooks, sign } = await import("@/server/services/integrations");
const { POST: v1LeadsPOST, GET: v1LeadsGET } = await import("@/app/api/v1/leads/route");
const { GET: v1Me } = await import("@/app/api/v1/me/route");
const { processDomainEvents, waitForEvents } = await import("@/lib/events");
const { importLeads } = await import("@/lib/crm/lead-import");
const { leadQualityByAgent } = await import("@/lib/lead-quality");
const { closeDeal, customersListId } = await import("@/lib/crm/deal-close");
const { claimNextLead } = await import("@/lib/dialer/queue");
const { transferLeads } = await import("@/lib/crm/lead-ops");

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser, agent2: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const events = async () => { await processDomainEvents({ businessId: a.business.id }); expect(await waitForEvents(a.business.id, 240_000)).toBe(true); };
type Call = { url: string; init?: RequestInit };
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); const r = handler(String(url), init); return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } }); }));
  return calls;
}

describe("round 9", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("r9-a", { modules: { crm: true, telephony: true, messaging: true } }); b = await createBusiness("r9-b", { modules: { crm: true } });
    accounts.push(a.account.id, b.account.id);
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent", personalPhone: name === "סוכן" ? "+972541234567" : null } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent" as const, teamId: null }; };
    agent = await mk("סוכן"); agent2 = await mk("סוכנת");
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
  }, 900_000);
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("store API: Shopify verifies the token and registers 3 webhooks; WooCommerce registers 2; bad credentials / internal hosts are rejected", async () => {
    const shop = await db.storeConnection.create({ data: { businessId: a.business.id, platform: "shopify", name: "S", publicKey: newPublicKey(), config: sealStoreConfig({}) } });
    let calls = stubFetch((url, init) => url.endsWith("/shop.json") ? { status: 200, body: { shop: { name: "My Shop" } } } : url.includes("/webhooks.json") && (!init?.method || init.method === "GET") ? { status: 200, body: { webhooks: [] } } : { status: 201, body: {} });
    const r = await run(a.session, () => connectShopify(shop, { shop: "my-shop.myshopify.com", accessToken: "shpat_1234567890", apiSecret: "shpss_secret_123" }));
    expect(r.registered).toEqual(["checkouts/create", "checkouts/update", "orders/create"]);
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(3);
    expect(JSON.parse(String(posts[0].init!.body)).webhook.address).toContain(`/api/webhooks/stores/shopify/${shop.id}`);
    expect((posts[0].init!.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_1234567890");
    const saved = await db.storeConnection.findUniqueOrThrow({ where: { id: shop.id } });
    expect(JSON.stringify(saved.config)).not.toContain("shpat_1234567890"); // sealed at rest
    stubFetch(() => ({ status: 401 }));
    await expect(run(a.session, () => connectShopify(shop, { shop: "my-shop.myshopify.com", accessToken: "bad_token_123", apiSecret: "x".repeat(10) }))).rejects.toMatchObject({ code: "store_auth_failed" });
    await expect(run(a.session, () => connectShopify(shop, { shop: "evil.example.com", accessToken: "t".repeat(12), apiSecret: "x".repeat(10) }))).rejects.toMatchObject({ code: "invalid_shop" });

    const woo = await db.storeConnection.create({ data: { businessId: a.business.id, platform: "woocommerce", name: "W", publicKey: newPublicKey(), config: sealStoreConfig({}) } });
    calls = stubFetch((url, init) => !init?.method || init.method === "GET" ? { status: 200, body: [] } : { status: 201, body: {} });
    const w = await run(a.session, () => connectWooCommerce(woo, { siteUrl: "https://shop.example.com", consumerKey: "ck_12345678", consumerSecret: "cs_12345678" }));
    expect(w.registered).toEqual(["order.created", "order.updated"]);
    const body = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(body.delivery_url).toContain(`/api/webhooks/stores/woocommerce/${woo.id}`); expect(body.secret.length).toBeGreaterThan(20);
    for (const bad of ["http://shop.example.com", "https://localhost", "https://10.0.0.5", "https://printer.local"]) {
      await expect(run(a.session, () => connectWooCommerce(woo, { siteUrl: bad, consumerKey: "ck_12345678", consumerSecret: "cs_12345678" }))).rejects.toMatchObject({ code: "invalid_url" });
    }
  });

  let apiKey = "";
  it("public API: key creates a lead (contact matched by phone, no duplicate open lead), lists leads, revoked key is refused, other business isolated", async () => {
    apiKey = (await run(a.session, () => createApiKey(a.session, "Make"))).key;
    const req = (body: unknown) => new Request("http://x/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await v1Me(new Request("http://x/api/v1/me", { headers: { authorization: `Bearer ${apiKey}` } }))).status).toBe(200);
    const r1 = await v1LeadsPOST(req({ fullName: "ליד API", phone: "0521112233", email: "api@lead.test", source: "zapier", ownerEmail: agent.email, customFields: { campaign: "summer" } }));
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()).data;
    const lead = await db.lead.findUniqueOrThrow({ where: { id: j1.leadId }, include: { contact: true } });
    expect(lead).toMatchObject({ ownerUserId: agent.id, source: "zapier" }); expect(lead.contact).toMatchObject({ email: "api@lead.test", phoneE164: "+972521112233" });
    expect((lead.contact.customFields as Record<string, string>).campaign).toBe("summer");
    const r2 = await v1LeadsPOST(req({ fullName: "ליד API", phone: "052-111-2233" }));
    expect(r2.status).toBe(200); expect((await r2.json()).data).toMatchObject({ leadId: j1.leadId, created: false });
    expect((await v1LeadsPOST(req({ fullName: "x", phone: "12" }))).status).toBe(400);
    const list = await (await v1LeadsGET(new Request("http://x/api/v1/leads?limit=10", { headers: { authorization: `Bearer ${apiKey}` } }))).json();
    expect(list.data.items.some((x: { id: string }) => x.id === j1.leadId)).toBe(true);
    const keyB = (await run(b.session, () => createApiKey(b.session, "B"))).key;
    const listB = await (await v1LeadsGET(new Request("http://x/api/v1/leads", { headers: { authorization: `Bearer ${keyB}` } }))).json();
    expect(listB.data.items).toHaveLength(0);
    await db.apiKey.updateMany({ where: { businessId: b.business.id }, data: { revokedAt: new Date() } });
    expect((await v1LeadsGET(new Request("http://x/api/v1/leads", { headers: { authorization: `Bearer ${keyB}` } }))).status).toBe(401);
    expect((await v1Me(new Request("http://x/api/v1/me", { headers: { authorization: "Bearer uk_live_nope" } }))).status).toBe(401);
  });

  it("webhooks: a lead.created event is delivered once, signed; a failing endpoint is retried with backoff; internal URLs are refused", async () => {
    await expect(run(a.session, () => createEndpoint(a.session, { url: "http://localhost:3000/x", events: ["lead.created"] }))).rejects.toMatchObject({ code: "invalid_url" });
    const ok = await run(a.session, () => createEndpoint(a.session, { url: "https://hooks.example.com/ok", events: ["lead.created"] }));
    const bad = await run(a.session, () => createEndpoint(a.session, { url: "https://hooks.example.com/bad", events: ["lead.created", "deal.won"] }));
    const r = await v1LeadsPOST(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ fullName: "ליד וובהוק", phone: "0521114455" }) }));
    const leadId = (await r.json()).data.leadId;
    await events(); await events(); // processing twice must not duplicate deliveries
    const deliveries = await db.webhookDelivery.findMany({ where: { businessId: a.business.id, event: "lead.created", payload: { path: ["data", "leadId"], equals: leadId } } });
    expect(deliveries).toHaveLength(2);
    const calls = stubFetch((url) => ({ status: url.endsWith("/ok") ? 200 : 500 }));
    await run(a.session, () => deliverDueWebhooks(a.business.id));
    const okCall = calls.find((c) => c.url.endsWith("/ok") && String(c.init?.body).includes(leadId))!;
    const secret = (await db.webhookEndpoint.findUniqueOrThrow({ where: { id: ok.id } })).config;
    const { openConfig } = await import("@/server/channels/registry");
    expect((okCall.init!.headers as Record<string, string>)["X-UltraCRM-Signature"]).toBe(sign(String(openConfig(secret).secret), String(okCall.init!.body)));
    expect(JSON.parse(String(okCall.init!.body))).toMatchObject({ event: "lead.created", data: { leadId, contact: { fullName: "ליד וובהוק", phone: "+972521114455" } } });
    const after = await db.webhookDelivery.findMany({ where: { id: { in: deliveries.map((d) => d.id) } } });
    expect(after.find((d) => d.endpointId === ok.id)).toMatchObject({ status: "delivered", attempts: 1 });
    const failed = after.find((d) => d.endpointId === bad.id)!;
    expect(failed).toMatchObject({ status: "pending", attempts: 1, responseCode: 500 }); expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await run(a.session, () => deliverDueWebhooks(a.business.id)); // not due yet → not re-sent
    expect(calls.filter((c) => c.url.endsWith("/bad") && String(c.init?.body).includes(leadId))).toHaveLength(1);
  });

  it("Excel import: rows become leads for the chosen agent; an existing open lead is not duplicated and NOT moved (conflict); bad phones reported", async () => {
    const apiLead = await db.lead.findFirstOrThrow({ where: { businessId: a.business.id, contact: { phoneE164: "+972521112233" }, status: { in: ["new", "contacted", "follow_up", "qualified"] } } });
    const r = await run(a.session, () => importLeads(a.session, { owner: agent2.id, source: "excel", offset: 0, rows: [
      { fullName: "יבוא אחד", phone: "0523330001", product: "מנוי", campaign: "אביב" },
      { fullName: "יבוא שניים", phone: "052-333-0002", email: "two@import.test" },
      { fullName: "ליד API", phone: "0521112233" },
      { fullName: "שבור", phone: "12" },
    ] }));
    expect(r).toMatchObject({ created: 2, exists: 1, invalid: 1, conflicts: apiLead.ownerUserId && apiLead.ownerUserId !== agent2.id ? 1 : 0 }); expect(r.errors.find((e) => e.row === 5)).toBeTruthy();
    const leads = await db.lead.findMany({ where: { businessId: a.business.id, contact: { phoneE164: { in: ["+972523330001", "+972523330002"] } } }, include: { contact: true } });
    expect(leads.every((l) => l.ownerUserId === agent2.id)).toBe(true);
    expect((await db.lead.findUniqueOrThrow({ where: { id: apiLead.id } })).ownerUserId).toBe(apiLead.ownerUserId); // an import never moves an owned lead
    expect((leads.find((l) => l.contact.phoneE164 === "+972523330001")!.contact.customFields as Record<string, string>).product).toBe("מנוי");
    const auto = await run(a.session, () => importLeads(a.session, { owner: "auto", offset: 0, rows: [{ fullName: "חלוקה", phone: "0523330009" }] }));
    expect(auto.created).toBe(1); await events();
    expect((await db.lead.findFirstOrThrow({ where: { contact: { phoneE164: "+972523330009" } } })).ownerUserId).not.toBeNull();
    await expect(run(agent, () => importLeads(agent, { owner: b.user.id, offset: 0, rows: [{ phone: "0523330010" }] }))).rejects.toMatchObject({ code: "invalid_agent" });
  });

  it("new lead → WhatsApp to the agent's personal phone (approved template, once); no phone → skipped", async () => {
    const tpl = await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "new_lead_agent", language: "he", category: "UTILITY", body: "ליד חדש: {{1}} {{2}} ({{3}})", status: "APPROVED" } });
    const biz = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(biz.settings as object), leadAssignment: { mode: "least_loaded", maxOpenLeadsPerAgent: 0, agentIds: [], perAgentMax: {}, lastAssignedUserId: null, notifyWhatsApp: { enabled: true, templateId: tpl.id } } } } });
    const post = (phone: string, ownerEmail: string) => v1LeadsPOST(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ fullName: "ליד להתראה", phone, source: "fb", ownerEmail }) }));
    const l1 = (await (await post("0524440001", agent.email)).json()).data.leadId;
    const l2 = (await (await post("0524440002", agent2.email)).json()).data.leadId;
    await events(); await events();
    const d1 = await db.assistantDelivery.findMany({ where: { businessId: a.business.id, key: `agent-lead:${l1}:${agent.id}` } });
    expect(d1).toHaveLength(1); expect(d1[0]).toMatchObject({ kind: "agent_new_lead", status: "sent" });
    expect(await db.assistantDelivery.findFirst({ where: { key: `agent-lead:${l2}:${agent2.id}` } })).toMatchObject({ status: "skipped", detail: "לנציג לא הוגדר טלפון אישי" });
    // a transfer notifies the new owner too
    await run(a.session, () => transferLeads(a.session, { leadIds: [l2], toUserId: agent.id }));
    expect(await db.assistantDelivery.findFirst({ where: { key: `agent-lead:${l2}:${agent.id}` } })).toMatchObject({ status: "sent" });
  });

  it("agent report: response time, conversion from new / transferred / all leads, average deal value", async () => {
    const from = new Date(Date.now() - 3600_000);
    const c = await db.contact.create({ data: { businessId: a.business.id, fullName: "מדד", phoneE164: "+972525550001", phoneRaw: "x" } });
    const newLead = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: agent.id, createdAt: new Date(Date.now() - 30 * 60_000) } });
    await db.call.create({ data: { businessId: a.business.id, userId: agent.id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "x", leadDialedAt: new Date(), createdAt: new Date(Date.now() - 20 * 60_000), status: "ended", endedAt: new Date(), outcomeSavedAt: new Date() } });
    await run(a.session, () => closeDeal(a.session, { contactId: c.id, leadId: newLead.id, amount: 1000, currency: "ILS", items: [] }));
    const q = (await run(a.session, () => leadQualityByAgent(a.business.id, [agent.id, agent2.id], from, new Date())));
    expect(q[agent.id].responseMinutes).toBeCloseTo(10, 0);
    expect(q[agent.id].newWon).toBeGreaterThanOrEqual(1);
    expect(q[agent.id].transferred).toBe(1); // l2 from the previous test
    expect(q[agent.id].avgDealValue).toBe(1000);
    expect(q[agent.id].allLeads).toBeGreaterThanOrEqual(q[agent.id].newLeads);
  });

  it("deal closed: won deal + products + note, customer leaves other lists and is dialed when the product ends; a renewal moves the date", async () => {
    const c = await db.contact.create({ data: { businessId: a.business.id, fullName: "לקוח חידוש", phoneE164: "+972526660001", phoneRaw: "x" } });
    const lead = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: agent.id, status: "qualified" } });
    const other = await db.dialList.create({ data: { businessId: a.business.id, name: "קמפיין אחר" } });
    await db.listLead.create({ data: { businessId: a.business.id, listId: other.id, contactId: c.id } });
    const r = await run(agent, () => closeDeal(agent, { contactId: c.id, leadId: lead.id, currency: "ILS", note: "שילם באשראי", items: [{ name: "מנוי שנתי", quantity: 1, unitPrice: 1200, startsAt: "2025-01-01", endsAt: "2025-12-31" }, { name: "התקנה", quantity: 2, unitPrice: 150, startsAt: "2025-01-01", endsAt: null }] }));
    const deal = await db.deal.findUniqueOrThrow({ where: { id: r.dealId }, include: { items: true } });
    expect(deal).toMatchObject({ status: "won", stage: "won", ownerUserId: agent.id }); expect(Number(deal.amount)).toBe(1500); expect(deal.items).toHaveLength(2);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("converted");
    const note = await db.note.findUniqueOrThrow({ where: { id: r.noteId } });
    expect(note.body).toContain("מנוי שנתי"); expect(note.body).toContain("₪1,500"); expect(note.body).toContain("שילם באשראי");
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).customerSince).not.toBeNull();
    expect((await db.listLead.findFirstOrThrow({ where: { listId: other.id, contactId: c.id } })).status).toBe("completed");
    const listId = await run(a.session, () => db.$transaction((tx) => customersListId(tx, a.business.id)));
    const row = await db.listLead.findFirstOrThrow({ where: { listId, contactId: c.id } });
    expect(row.status).toBe("pending"); expect(row.nextAttemptAt!.toISOString().slice(0, 10)).toBe("2025-12-31");
    // the product has ended → the existing-customers dialer calls this customer
    await db.listLead.updateMany({ where: { listId, NOT: { contactId: c.id } }, data: { status: "completed" } });
    const claimed = await run(agent, () => claimNextLead(a.business.id, agent.id, listId));
    expect(claimed?.contactId).toBe(c.id);
    await db.listLead.update({ where: { id: claimed!.id }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
    // renewal sold → the ended item is settled and the next call is at the new end date
    const renewal = await run(agent, () => closeDeal(agent, { contactId: c.id, currency: "ILS", items: [{ name: "מנוי שנתי", quantity: 1, unitPrice: 1300, startsAt: "2026-01-01", endsAt: "2026-12-31" }] }));
    expect(renewal.renewalAt?.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect((await db.dealItem.findFirstOrThrow({ where: { dealId: r.dealId, name: "מנוי שנתי" } })).renewalHandledAt).not.toBeNull();
    expect((await db.listLead.findFirstOrThrow({ where: { listId, contactId: c.id } })).nextAttemptAt!.toISOString().slice(0, 10)).toBe("2026-12-31");
    // another business cannot close a deal on this contact
    await expect(run(b.session, () => closeDeal(b.session, { contactId: c.id, currency: "ILS", items: [] }))).rejects.toMatchObject({ status: 404 });
  });
});
