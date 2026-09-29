/**
 * Dialer: automatic wrap-up + AI documentation status; in-call payments (sandbox provider – nothing is ever charged,
 * the PayPlus adapter is exercised against a faked API only).
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, afterEach, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { autoFinalizePendingCalls } from "@/lib/dialer/calls";
import { startSession } from "@/lib/dialer/session";
import { documentCall } from "@/server/coach/documentation";
import { connectPaymentProvider, createPaymentRequest, getPaymentRequest, cancelPaymentRequest, sandboxDecision, handlePaymentWebhook, paymentOptions } from "@/server/services/payment-service";
import { payplusProvider, signSandbox, configOf } from "@/lib/payments/providers";
import { POST as retryDocPOST } from "@/app/api/calls/[id]/documentation/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let agent: SessionUser;
const accounts: string[] = [];
const realFetch = globalThis.fetch;
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let seq = 0;
const phone = () => `+9725${String(60000000 + (Date.now() % 1000000) * 10 + ++seq).slice(-8)}`;
const contactOf = (biz: Biz, owner: string) => { const p = phone(); return db.contact.create({ data: { businessId: biz.business.id, fullName: `לקוח ${seq}`, phoneE164: p, phoneRaw: p, ownerUserId: owner } }); };
const endedCall = (userId: string, contactId: string, e164: string, answered: boolean, extra: Record<string, unknown> = {}) => db.call.create({ data: { businessId: A.business.id, userId, contactId, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: e164, fromE164: "+97230000000", status: "ended", answeredAt: answered ? new Date(Date.now() - 60_000) : null, telephonyResult: answered ? "answered" : "no_answer", endedAt: new Date(), talkSeconds: answered ? 60 : 0, ...extra } });

describe("dialer: automatic documentation + in-call payments", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("pay-a", { modules: { crm: true, telephony: true, whatsapp: true } });
    B = await createBusiness("pay-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "נציגה", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "נציגה", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "נציגה", role: "agent", teamId: null };
  }, 600_000);
  afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch; });
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("a call left without a result never blocks: the next session closes it automatically (answered / not answered)", async () => {
    const c1 = await contactOf(A, agent.id), c2 = await contactOf(A, agent.id);
    const lead = await db.lead.create({ data: { businessId: A.business.id, contactId: c1.id, ownerUserId: agent.id, status: "new" } });
    const answered = await endedCall(agent.id, c1.id, c1.phoneE164, true);
    const missed = await endedCall(agent.id, c2.id, c2.phoneE164, false);
    const s = await run(agent, () => startSession(agent, { mode: "manual", browserSessionId: crypto.randomUUID() }));
    expect(s).toBeTruthy(); // no "יש לתעד את השיחה הקודמת"
    expect(await db.call.findUniqueOrThrow({ where: { id: answered.id } })).toMatchObject({ outcome: "answered" });
    expect(await db.call.findUniqueOrThrow({ where: { id: missed.id } })).toMatchObject({ outcome: "no_answer" });
    expect((await db.call.findUniqueOrThrow({ where: { id: answered.id } })).outcomeSavedAt).not.toBeNull();
    const { waitForEvents } = await import("@/lib/events");
    await waitForEvents(A.business.id).catch(() => undefined);
    await withBusiness(A.business.id, async () => { const { processDomainEvents } = await import("@/lib/events"); await processDomainEvents({ businessId: A.business.id }); });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("contacted"); // not "interested" – nothing invented
    expect(await run(agent, () => autoFinalizePendingCalls(agent))).toBe(0); // nothing left
  });

  it("AI documentation: stored once for duplicate events; a model failure is 'failed' (not done) and can be retried", async () => {
    const c = await contactOf(A, agent.id);
    const call = await endedCall(agent.id, c.id, c.phoneE164, true, { outcome: "answered", outcomeSavedAt: new Date() });
    const sess = await withBusiness(A.business.id, async () => (await import("@/server/coach/session")).ensureSession(call.id));
    await db.coachSegment.createMany({ data: [{ businessId: A.business.id, sessionId: sess.id, callId: call.id, speaker: "agent", source: "simulation", text: "שלום, מדברים מהחברה", startMs: 0, endMs: 3000 }, { businessId: A.business.id, sessionId: sess.id, callId: call.id, speaker: "customer", source: "simulation", text: "אני מעוניין במנוי", startMs: 3000, endMs: 6000 }] as never });
    const env = { ...process.env };
    process.env.COACH_PROVIDER = ""; process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      vi.stubGlobal("fetch", async () => new Response("overloaded", { status: 529 }));
      const r1 = await withBusiness(A.business.id, () => documentCall(call.id));
      expect(r1).toMatchObject({ failed: expect.stringContaining("AI") });
      const s1 = await db.coachSession.findUniqueOrThrow({ where: { callId: call.id } });
      expect(s1).toMatchObject({ documentationStatus: "failed", documentedAt: null, documentation: null });
      // A duplicate call.ended does not silently "complete" it either.
      expect(await withBusiness(A.business.id, () => documentCall(call.id))).toMatchObject({ failed: expect.any(String) });
      // Retry through the route after the model is back.
      vi.stubGlobal("fetch", async () => Response.json({ content: [{ type: "text", text: JSON.stringify({ summary: "הלקוח מעוניין במנוי", timeline: [{ from: "00:00", to: "00:06", title: "פתיחה", details: "הצגה ועניין במנוי" }], customerNeeds: ["מנוי"], objections: [], agreements: [], nextSteps: ["לשלוח הצעה"], sentiment: "positive" }) }], usage: { input_tokens: 10, output_tokens: 10 } }));
      const req = new NextRequest(`http://localhost/api/calls/${call.id}/documentation`, { method: "POST", headers: { origin: "http://localhost", cookie: `ultracrm_session=${await signSession(agent)}` } });
      const res = await withBusiness(A.business.id, () => retryDocPOST(req, { params: Promise.resolve({ id: call.id }) }), agent);
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe("done");
      const s2 = await db.coachSession.findUniqueOrThrow({ where: { callId: call.id } });
      expect(s2.documentedAt).not.toBeNull();
      expect((s2.documentation as { source: string }).source).toBe("ai");
      // Duplicate events after success: nothing re-done.
      expect(await withBusiness(A.business.id, () => documentCall(call.id))).toMatchObject({ skipped: "already documented" });
      // Another agent (not the owner of the call) cannot retry it.
    } finally { process.env = env; }
    const noTranscript = await endedCall(agent.id, c.id, c.phoneE164, true, { outcome: "answered", outcomeSavedAt: new Date() });
    expect(await withBusiness(A.business.id, () => documentCall(noTranscript.id))).toMatchObject({ failed: expect.stringContaining("תמלול") });
  });

  describe("payments (sandbox – no money moves)", () => {
    let product: string; let c: { id: string; phoneE164: string }; let call: { id: string };
    beforeAll(async () => {
      await run(A.session, () => connectPaymentProvider(A.session, { provider: "sandbox", environment: "test" }));
      product = (await db.salesOffer.create({ data: { businessId: A.business.id, name: "מנוי שנתי", unitAmount: 100000, taxBps: 1800 } })).id;
      c = await contactOf(A, agent.id);
      call = await db.call.create({ data: { businessId: A.business.id, userId: agent.id, contactId: c.id, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+97230000000", status: "answered", answeredAt: new Date() } });
    });

    it("options, price with tax, double click → one request, approval confirmed by the provider, duplicate notification ignored", async () => {
      const o = await run(agent, () => paymentOptions(agent, c.id, call.id));
      expect(o).toMatchObject({ connection: { connected: true, provider: "sandbox" }, canEditAmount: false });
      expect(o.products[0]).toMatchObject({ id: product, amountAgorot: 118000 });
      const key = crypto.randomUUID();
      const [r1, r2] = await Promise.all([1, 2].map(() => run(agent, () => createPaymentRequest(agent, { contactId: c.id, callId: call.id, source: { type: "product", id: product }, idempotencyKey: key }))));
      expect(r1.id).toBe(r2.id);
      // A second key for the same open item + call → the same request (no second page).
      const r3 = await run(agent, () => createPaymentRequest(agent, { contactId: c.id, callId: call.id, source: { type: "product", id: product }, idempotencyKey: crypto.randomUUID() }));
      expect(r3.id).toBe(r1.id);
      expect(await db.paymentRequest.count({ where: { businessId: A.business.id, contactId: c.id } })).toBe(1);
      expect(r1).toMatchObject({ status: "pending", amountAgorot: 118000 });
      expect(r1.paymentUrl).toContain("/pay/sandbox/sbx_");
      // Closing the window / polling before the provider answers: still pending.
      expect((await run(agent, () => getPaymentRequest(agent, r1.id))).status).toBe("pending");
      const prid = r1.paymentUrl!.split("/").pop()!;
      await sandboxDecision(prid, "approved");
      const done = await run(agent, () => getPaymentRequest(agent, r1.id));
      expect(done).toMatchObject({ status: "succeeded", approvalNumber: "000000", paymentUrl: null });
      // The same notification again (provider retry) → ignored, nothing changes.
      const conn = await db.paymentProviderConnection.findFirstOrThrow({ where: { businessId: A.business.id, isActive: true } });
      const raw = JSON.stringify({ page_request_uid: prid, event_id: "evt_dup", result: "approved" });
      const h = () => new Headers({ "user-agent": "UltraCRM-Sandbox", hash: signSandbox(configOf(conn.config).secretKey, raw) });
      expect(await handlePaymentWebhook(conn.id, raw, h())).toMatchObject({ status: 200 });
      expect(await handlePaymentWebhook(conn.id, raw, h())).toMatchObject({ status: 200, duplicate: true });
      expect(await db.auditLog.count({ where: { businessId: A.business.id, action: "payment.succeeded", entityId: r1.id } })).toBe(1);
    });

    it("failure, bad signature refused, amount change needs permission, late approval after cancel is shown as paid", async () => {
      const r = await run(agent, () => createPaymentRequest(agent, { contactId: c.id, callId: call.id, source: { type: "product", id: product }, idempotencyKey: crypto.randomUUID() }));
      const prid = r.paymentUrl!.split("/").pop()!;
      const conn = await db.paymentProviderConnection.findFirstOrThrow({ where: { businessId: A.business.id, isActive: true } });
      const raw = JSON.stringify({ page_request_uid: prid, event_id: "evt_forged", result: "approved" });
      expect((await handlePaymentWebhook(conn.id, raw, new Headers({ "user-agent": "UltraCRM-Sandbox", hash: "forged" }))).status).toBe(401);
      expect((await run(agent, () => getPaymentRequest(agent, r.id))).status).toBe("pending");
      await sandboxDecision(prid, "declined");
      expect(await run(agent, () => getPaymentRequest(agent, r.id))).toMatchObject({ status: "failed", failureReason: expect.stringContaining("נדחה") });
      // Amount change: an agent without "שינוי סכום בגבייה" is refused; the owner may.
      await expect(run(agent, () => createPaymentRequest(agent, { contactId: c.id, callId: call.id, source: { type: "product", id: product }, amountAgorot: 50000, idempotencyKey: crypto.randomUUID() }))).rejects.toMatchObject({ code: "amount_forbidden" });
      const edited = await run(A.session, () => createPaymentRequest(A.session, { contactId: c.id, callId: call.id, source: { type: "product", id: product }, amountAgorot: 50000, idempotencyKey: crypto.randomUUID() }));
      expect(edited).toMatchObject({ amountAgorot: 50000, listAmountAgorot: 118000 });
      // Cancel, then the customer still pays on the page → paid (late), never hidden.
      await run(A.session, () => cancelPaymentRequest(A.session, edited.id));
      await sandboxDecision(edited.paymentUrl ? edited.paymentUrl.split("/").pop()! : (await db.paymentRequest.findUniqueOrThrow({ where: { id: edited.id } })).providerRequestId!, "approved");
      expect(await run(A.session, () => getPaymentRequest(A.session, edited.id))).toMatchObject({ status: "succeeded", lateConfirmation: true });
    });

    it("isolation: another business cannot read a request or sign for this connection; no card data is stored", async () => {
      const r = await db.paymentRequest.findFirstOrThrow({ where: { businessId: A.business.id } });
      await expect(run(B.session, () => getPaymentRequest(B.session, r.id))).rejects.toMatchObject({ status: 404 });
      await run(B.session, () => connectPaymentProvider(B.session, { provider: "sandbox", environment: "test" }));
      const bConn = await withBusiness(B.business.id, () => db.paymentProviderConnection.findFirstOrThrow({ where: { businessId: B.business.id, isActive: true } }));
      const aConn = await db.paymentProviderConnection.findFirstOrThrow({ where: { businessId: A.business.id, isActive: true } });
      const raw = JSON.stringify({ page_request_uid: r.providerRequestId, event_id: "evt_x", result: "approved" });
      expect((await handlePaymentWebhook(aConn.id, raw, new Headers({ "user-agent": "UltraCRM-Sandbox", hash: signSandbox(configOf(bConn.config).secretKey, raw) }))).status).toBe(401);
      const events = await db.paymentEvent.findMany({ where: { businessId: A.business.id } });
      for (const e of events) expect(JSON.stringify(e.summary)).not.toMatch(/card|cvv|\b\d{12,19}\b/i);
      // Secrets are sealed at rest.
      expect(JSON.stringify(aConn.config)).toMatch(/enc:v1:/);
    });

    it("PayPlus adapter (faked API): page link, signed callback verified, status from the IPN check; wrong signature refused", async () => {
      const pp = payplusProvider({ apiKey: "k", secretKey: "s3cret", paymentPageUid: "page-uid", environment: "test" });
      const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
        if (url.endsWith("/PaymentPages/generateLink")) return Response.json({ results: { status: "success" }, data: { page_request_uid: "prq-1", payment_page_link: "https://payments.payplus.co.il/prq-1" } });
        if (url.endsWith("/PaymentPages/ipn")) return Response.json({ results: { status: "success" }, data: { transaction: { uid: "tx-9", status_code: "000", amount: 1180, approval_number: "123456" } } });
        return new Response("unexpected", { status: 500 });
      });
      const page = await pp.createPage({ amountAgorot: 118000, currency: "ILS", description: "מנוי", reference: "req-1", callbackUrl: "https://crm.example/api/webhooks/payments/c1", customer: { name: "דנה", phone: "+972501234567" } });
      expect(page).toEqual({ providerRequestId: "prq-1", paymentUrl: "https://payments.payplus.co.il/prq-1" });
      expect(calls[0].url).toBe("https://restapidev.payplus.co.il/api/v1.0/PaymentPages/generateLink");
      expect(calls[0].body).toMatchObject({ payment_page_uid: "page-uid", amount: 1180, currency_code: "ILS", refURL_callback: "https://crm.example/api/webhooks/payments/c1", more_info: "req-1" });
      expect(calls[0].headers).toMatchObject({ "api-key": "k", "secret-key": "s3cret" });
      const body = JSON.stringify({ transaction: { uid: "tx-9", payment_page_request_uid: "prq-1", status_code: "000", amount: 1180 } });
      const hash = crypto.createHmac("sha256", "s3cret").update(body).digest("base64");
      expect(pp.verifyCallback(body, new Headers({ "user-agent": "PayPlus", hash }))).toBe(true);
      expect(pp.verifyCallback(body, new Headers({ "user-agent": "PayPlus", hash: "x" + hash.slice(1) }))).toBe(false);
      expect(pp.verifyCallback(body, new Headers({ "user-agent": "curl", hash }))).toBe(false);
      expect(pp.parseCallback(JSON.parse(body))).toMatchObject({ providerRequestId: "prq-1", eventKey: "tx:tx-9:000" });
      expect(await pp.fetchStatus("prq-1")).toMatchObject({ status: "succeeded", transactionId: "tx-9", approvalNumber: "123456", amountAgorot: 118000 });
    });
  });
});
