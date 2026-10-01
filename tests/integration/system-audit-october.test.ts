import crypto from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { cancelPaymentRequest, connectPaymentProvider, createPaymentRequest, handlePaymentWebhook } from "@/server/services/payment-service";
import { createAppointment, updateAppointment } from "@/server/services/appointments";
import { waitForEvents } from "@/lib/events";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/auth";
import { GET as listsGET } from "@/app/api/lists/route";
import { listQueueStats } from "@/lib/dialer/queue";

describe("system audit: payment safety, appointment retries and dialer counts", () => {
  let biz: Awaited<ReturnType<typeof createBusiness>>;
  let productId: string;
  const run = <T,>(fn: () => Promise<T>) => withBusiness(biz.business.id, fn, biz.session);
  const contact = () => { const phone = `+9725${crypto.randomInt(10000000, 99999999)}`; return db.contact.create({ data: { businessId: biz.business.id, fullName: "Audit", phoneE164: phone, phoneRaw: phone, ownerUserId: biz.user.id } }); };
  beforeAll(async () => {
    biz = await createBusiness("oct-audit", { modules: { crm: true, telephony: true } });
    await run(() => connectPaymentProvider(biz.session, { provider: "sandbox", environment: "test" }));
    productId = (await db.salesOffer.create({ data: { businessId: biz.business.id, name: "Audit product", unitAmount: 10000 } })).id;
  });
  afterAll(async () => {
    if (biz) { await waitForEvents(biz.business.id); await destroyBusiness(biz.business.id, [biz.account.id]); }
  });

  it("simultaneous clicks with different request keys create one payment page", async () => {
    const c = await contact();
    const results = await Promise.all(Array.from({ length: 5 }, () => run(() => createPaymentRequest(biz.session, {
      contactId: c.id, source: { type: "product", id: productId }, idempotencyKey: crypto.randomUUID(),
    }))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.paymentRequest.count({ where: { businessId: biz.business.id, contactId: c.id } })).toBe(1);
  });

  it("a request key cannot silently replay another customer's payment or a changed amount", async () => {
    const c = await contact(), other = await contact();
    const input = { contactId: c.id, source: { type: "product" as const, id: productId }, idempotencyKey: crypto.randomUUID() };
    await run(() => createPaymentRequest(biz.session, input));
    await expect(run(() => createPaymentRequest(biz.session, { ...input, contactId: other.id }))).rejects.toMatchObject({ code: "bad_idempotency_key" });
    await expect(run(() => createPaymentRequest(biz.session, { ...input, amountAgorot: 5000 }))).rejects.toMatchObject({ code: "bad_idempotency_key" });
  });

  it("an attended retry preserves the original attendance time and correcting status clears it", async () => {
    const c = await contact();
    const a = await run(() => createAppointment(biz.session, { contactId: c.id, scheduledAt: new Date().toISOString() }));
    await run(() => updateAppointment(biz.session, a.id, { status: "attended" }));
    const original = new Date("2026-01-01T12:00:00Z");
    await db.appointment.update({ where: { id: a.id }, data: { attendedAt: original } });
    expect((await run(() => updateAppointment(biz.session, a.id, { status: "attended" }))).attendedAt).toEqual(original);
    expect((await run(() => updateAppointment(biz.session, a.id, { status: "no_show" }))).attendedAt).toBeNull();
  });

  it("concurrent retries of the same reschedule count only one change", async () => {
    const c = await contact();
    const a = await run(() => createAppointment(biz.session, { contactId: c.id, scheduledAt: "2026-11-01T12:00:00Z" }));
    await Promise.all(Array.from({ length: 4 }, () => run(() => updateAppointment(biz.session, a.id, { scheduledAt: "2026-11-02T12:00:00Z" }))));
    expect((await db.appointment.findUniqueOrThrow({ where: { id: a.id } })).rescheduledCount).toBe(1);
    expect(await db.domainEvent.count({ where: { businessId: biz.business.id, type: "appointment.rescheduled", contactId: c.id } })).toBe(1);
  });

  it("the dialer launcher counts only leads this agent can actually claim", async () => {
    const mine = await contact(), unassigned = await contact(), blocked = await contact();
    for (const [c, ownerUserId] of [[mine, biz.user.id], [unassigned, null], [blocked, biz.user.id]] as const) {
      await db.lead.create({ data: { businessId: biz.business.id, contactId: c.id, ownerUserId, status: "new" } });
    }
    await db.dncEntry.create({ data: { businessId: biz.business.id, phoneE164: blocked.phoneE164 } });
    const list = await db.dialList.create({ data: { businessId: biz.business.id, name: "Audit queue" } });
    await db.listLead.createMany({ data: [mine, unassigned, blocked].map((c) => ({ businessId: biz.business.id, listId: list.id, contactId: c.id })) });
    const req = new NextRequest("http://localhost/api/lists?dialer=1", { headers: { cookie: `ultracrm_session=${await signSession(biz.session)}` } });
    const response = await listsGET(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.find((l: { id: string }) => l.id === list.id).stats).toMatchObject({ dueNow: 1, total: 3 });
    // Management still sees the whole list's queue counts.
    expect((await run(() => listQueueStats(list.id))).total).toBe(3);
  });

  it("a signed payment notification can be retried after a provider status outage", async () => {
    const secret = "audit-only-secret", providerId = crypto.randomUUID();
    const fakeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: { page_request_uid: providerId, payment_page_link: "https://example.test/pay" } }));
    try {
      await run(() => connectPaymentProvider(biz.session, { provider: "payplus", environment: "test", apiKey: "audit-only", secretKey: secret, paymentPageUid: "audit-only" }));
      const c = await contact();
      const r = await run(() => createPaymentRequest(biz.session, { contactId: c.id, source: { type: "product", id: productId }, idempotencyKey: crypto.randomUUID() }));
      const conn = await db.paymentProviderConnection.findFirstOrThrow({ where: { businessId: biz.business.id, isActive: true } });
      const raw = JSON.stringify({ page_request_uid: providerId });
      const headers = new Headers({ "user-agent": "PayPlus", hash: crypto.createHmac("sha256", secret).update(raw).digest("base64") });
      fakeFetch.mockRejectedValueOnce(new Error("temporary provider outage"));
      await expect(handlePaymentWebhook(conn.id, raw, headers)).rejects.toThrow("temporary provider outage");
      fakeFetch.mockResolvedValue(Response.json({ data: { status_code: "000", amount: 100, uid: providerId } }));
      expect(await handlePaymentWebhook(conn.id, raw, headers)).toMatchObject({ status: 200, applied: "succeeded" });
      expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("succeeded");
      expect(await handlePaymentWebhook(conn.id, raw, headers)).toMatchObject({ status: 200, duplicate: true });
      expect(await db.auditLog.count({ where: { entityId: r.id, action: "payment.succeeded" } })).toBe(1);
    } finally { fakeFetch.mockRestore(); }
  });

  it("cancelling while the provider creates a page cannot resurrect the cancelled request", async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const pageStarted = new Promise<void>((resolve) => { started = resolve; });
    const fakeFetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    try {
      await run(() => connectPaymentProvider(biz.session, { provider: "payplus", environment: "test", apiKey: "audit-only", secretKey: "audit-only-secret", paymentPageUid: "audit-only" }));
      const c = await contact(), key = crypto.randomUUID();
      const creating = run(() => createPaymentRequest(biz.session, { contactId: c.id, source: { type: "product", id: productId }, idempotencyKey: key }));
      await pageStarted;
      const reserved = await db.paymentRequest.findUniqueOrThrow({ where: { businessId_idempotencyKey: { businessId: biz.business.id, idempotencyKey: key } } });
      await run(() => cancelPaymentRequest(biz.session, reserved.id));
      release(Response.json({ data: { page_request_uid: key, payment_page_link: "https://example.test/pay" } }));
      expect(await creating).toMatchObject({ status: "cancelled", paymentUrl: null });
      const saved = await db.paymentRequest.findUniqueOrThrow({ where: { id: reserved.id } });
      expect(saved.providerRequestId).toBe(key); // retain reconciliation for any late provider confirmation
      expect(saved.cancelledAt).not.toBeNull();
    } finally { fakeFetch.mockRestore(); }
  });
});
