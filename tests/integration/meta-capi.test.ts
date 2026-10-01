/**
 * "המרות למטא" (Conversions API) on the real DB. Meta's Graph API is STUBBED (fetch mock) – nothing reaches Meta and no
 * fictitious event is sent to production data. Covers the acceptance list: dynamic purchase values, appointments,
 * a custom event from the business's own status, no duplicates (re-save, duplicate webhook / event, retry, parallel
 * workers, close + payment), the site's Purchase as the one source, missing data is not invented, revoked
 * authorization / temporary failures, and isolation between businesses.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const capi = await import("@/server/marketing/capi");
const { createAppointment, updateAppointment } = await import("@/server/services/appointments");
const { updateDeal } = await import("@/lib/crm/pipeline");
const { processDomainEvents, waitForEvents } = await import("@/lib/events");
const eventsRoute = await import("@/app/api/marketing/capi/events/route");
const overviewRoute = await import("@/app/api/marketing/capi/route");

type SentEvent = { event_name: string; event_id: string; action_source: string; custom_data: Record<string, unknown>; user_data: { em: string[]; ph: string[]; [key: string]: unknown } };
type Sent = { url: string; body: { data: SentEvent[]; test_event_code?: string } };
let sent: Sent[] = [];
let graphMode: "ok" | "auth" | "transient" = "ok";
const realFetch = globalThis.fetch;

describe("Meta Conversions API", { timeout: 300_000 }, () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let contactId: string; let leadId: string; let payConn: string;
  const run = <T,>(fn: () => Promise<T>, s: SessionUser = a.session) => withBusiness(s.businessId, fn, s);
  const flush = async (biz = a.business.id) => { await processDomainEvents({ businessId: biz }); await waitForEvents(biz); };
  const send = () => run(() => capi.sendDue(a.business.id, Date.now() + 10_000));
  const events = (where: Record<string, unknown> = {}) => db.metaCapiEvent.findMany({ where: { businessId: a.business.id, ...where }, orderBy: { createdAt: "asc" } });
  const req = async (u: SessionUser, url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(u)}` } });
  const rule = (x: Partial<import("@/server/marketing/capi").RuleInput> & Pick<import("@/server/marketing/capi").RuleInput, "name" | "trigger" | "eventKind" | "eventName" | "actionSource">) => run(() => capi.saveRule(a.session, capi.ruleSchema.parse({ enabled: true, ...x })));

  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (!u.startsWith("https://graph.facebook.com/")) return realFetch(url as never, init);
      if (u.includes("/events")) {
        if (graphMode === "auth") return new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 400 });
        if (graphMode === "transient") return new Response(JSON.stringify({ error: { message: "Service temporarily unavailable", code: 2 } }), { status: 503 });
        const body = JSON.parse(String(init?.body)); sent.push({ url: u, body });
        return new Response(JSON.stringify({ events_received: body.data.length, fbtrace_id: "trace-test" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "1234567890", name: "QA dataset" }), { status: 200 });
    });
    a = await createBusiness("capi-a", { modules: { crm: true, telephony: true } }); b = await createBusiness("capi-b", { modules: { crm: true } });
    contactId = (await db.contact.create({ data: { businessId: a.business.id, fullName: "Dana Levi", email: "  Dana@Example.COM ", phoneE164: "+972501234567", phoneRaw: "x", city: "Tel Aviv" } })).id;
    leadId = (await db.lead.create({ data: { businessId: a.business.id, contactId, status: "new", source: "facebook" } })).id;
    await db.leadTouchpoint.create({ data: { businessId: a.business.id, contactId, leadId, channel: "meta_lead_form", metaLeadId: "1234567890123456", clickIds: { fbc: "fb.1.1700000000000.AbCdEf" }, dataSource: "api", occurredAt: new Date() } });
    payConn = (await db.paymentProviderConnection.create({ data: { businessId: a.business.id, provider: "sandbox" } })).id;
    // connection in TEST mode (test_event_code on every request), verified, sending on
    await run(() => capi.saveConnection(a.session, { datasetId: "1234567890", token: "EAAB" + "x".repeat(40), testEventCode: "TEST12345" }));
    await run(() => capi.checkConnection(a.session));
    await run(() => capi.setSending(a.session, true));
  });
  afterAll(async () => { vi.restoreAllMocks(); await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("connection: token sealed (never returned), check + test event only with a Test Event Code", async () => {
    const c = await run(() => capi.getConnection(a.business.id));
    expect(c).toMatchObject({ status: "ok", enabled: true, tokenHint: expect.stringMatching(/^…/) });
    expect(JSON.stringify(c)).not.toContain("EAAB");
    const r = await run(() => capi.sendTestEvent(a.session));
    expect(r).toMatchObject({ ok: true, testEventCode: "TEST12345" });
    expect(sent.at(-1)!.body.test_event_code).toBe("TEST12345");
  });

  it("two purchases with different values are sent with their own value + ILS (payment confirmed = default source)", async () => {
    await rule({ name: "רכישה", trigger: "payment_received", eventKind: "standard", eventName: "Purchase", actionSource: "phone_call", valueSource: "deal_amount" });
    for (const amount of [1800, 699]) {
      const deal = await db.deal.create({ data: { businessId: a.business.id, contactId, title: `deal ${amount}`, amount, currency: "ILS", status: "won", stage: "won", closedAt: new Date() } });
      await db.paymentRequest.create({ data: { businessId: a.business.id, connectionId: payConn, provider: "sandbox", contactId, agentId: a.user.id, sourceType: "deal", sourceId: deal.id, description: "x", amountAgorot: amount * 100, currency: "ILS", status: "succeeded", confirmedAt: new Date(), idempotencyKey: crypto.randomUUID() } });
    }
    sent = []; await run(() => capi.scanPayments(a.business.id)); await send();
    const purchases = sent.flatMap((s) => s.body.data).filter((d) => d.event_name === "Purchase");
    expect(purchases.map((p) => [p.custom_data.value, p.custom_data.currency]).sort()).toEqual([[1800, "ILS"], [699, "ILS"]].sort());
    // identifiers: hashed where Meta requires, normalised first; fbc as stored; nothing invented
    const ud = purchases[0].user_data;
    expect(ud.em[0]).toBe(capi.sha256("dana@example.com"));
    expect(ud.ph[0]).toBe(capi.sha256("972501234567"));
    expect(ud.fbc).toBe("fb.1.1700000000000.AbCdEf");
    expect(ud.client_ip_address).toBeUndefined(); expect(ud.client_user_agent).toBeUndefined();
    expect(purchases[0].action_source).toBe("phone_call");
    expect(sent.every((s) => s.body.test_event_code === "TEST12345")).toBe(true); // test mode – nothing to production data
  });

  it("no duplicates: re-scan, deal-closed + payment for the same purchase, retry of a received event, parallel workers", async () => {
    await rule({ name: "סגירה", trigger: "deal_won", eventKind: "standard", eventName: "Purchase", actionSource: "phone_call", valueSource: "deal_amount" });
    const before = (await events({ eventName: "Purchase" })).length;
    sent = [];
    await run(() => capi.scanPayments(a.business.id)); // the same payments again (duplicate webhook / re-save)
    const deals = await db.deal.findMany({ where: { businessId: a.business.id, status: "won" } });
    for (const d of deals) await run(() => capi.enqueueOccurrence(a.business.id, { trigger: "deal_won", contactId, entityType: "deal", entityId: d.id, occurredAt: new Date(), occurrenceKey: `ev-${d.id}`, dealId: d.id }));
    await Promise.all([send(), send(), send()]); // parallel workers
    expect((await events({ eventName: "Purchase" })).length).toBe(before);
    expect(sent.length).toBe(0);
    const received = (await events({ status: "received" }))[0];
    await expect(run(() => capi.retryEvent(a.session, received.id))).rejects.toMatchObject({ code: "not_retryable" });
    // a value change after sending does not create another Purchase
    await db.deal.update({ where: { id: deals[0].id }, data: { amount: 2500 } });
    await run(() => capi.scanPayments(a.business.id));
    expect((await events({ eventName: "Purchase" })).length).toBe(before);
  });

  it("appointments: scheduled → Schedule; a reschedule is not a new meeting; a separate meeting is; attended → custom event", async () => {
    await rule({ name: "פגישה נקבעה", trigger: "appointment_scheduled", eventKind: "standard", eventName: "Schedule", actionSource: "phone_call" });
    await rule({ name: "פגישה התקיימה", trigger: "appointment_attended", eventKind: "custom", eventName: "AppointmentAttended", actionSource: "phone_call" });
    const ap = await run(() => createAppointment(a.session, { contactId, leadId, scheduledAt: new Date(Date.now() + 86400_000).toISOString() }));
    await flush();
    await run(() => updateAppointment(a.session, ap.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000).toISOString() })); await flush();
    expect((await events({ eventName: "Schedule" })).length).toBe(1);
    await run(() => createAppointment(a.session, { contactId, leadId, scheduledAt: new Date(Date.now() + 5 * 86400_000).toISOString() })); await flush();
    expect((await events({ eventName: "Schedule" })).length).toBe(2);
    await run(() => updateAppointment(a.session, ap.id, { status: "attended" })); await flush();
    await run(() => updateAppointment(a.session, ap.id, { status: "attended" })); await flush();
    expect((await events({ eventName: "AppointmentAttended" })).length).toBe(1);
  });

  it("a custom event from the business's own custom status (CRM route with lead_id unhashed)", async () => {
    const qualified = await db.leadStatusDef.create({ data: { businessId: a.business.id, kind: "qualified", label: "כשיר אצלנו", sortOrder: 50 } });
    await rule({ name: "ליד כשיר", trigger: "lead_status", triggerConfig: { statusId: qualified.id }, eventKind: "custom", eventName: "CRMQualifiedLead", actionSource: "system_generated" });
    await run(async () => capi.enqueueOccurrence(a.business.id, (await capi.occurrenceFromEvent({ id: crypto.randomUUID(), type: "lead.status_changed", contactId, occurredAt: new Date(), payload: { leadId, to: "qualified", toStatusId: qualified.id } }))!));
    // another status of the same meaning does not fire this rule
    await run(async () => capi.enqueueOccurrence(a.business.id, (await capi.occurrenceFromEvent({ id: crypto.randomUUID(), type: "lead.status_changed", contactId, occurredAt: new Date(), payload: { leadId, to: "qualified", toStatusId: "lsd_other" } }))!));
    const rows = await events({ eventName: "CRMQualifiedLead" });
    expect(rows.length).toBe(1);
    const p = rows[0].payload as { action_source: string; user_data: { lead_id: unknown }; custom_data: { event_source: string; lead_event_source: string } };
    expect(p).toMatchObject({ action_source: "system_generated", custom_data: { event_source: "crm", lead_event_source: "UltraCRM" } });
    expect(p.user_data.lead_id).toBe(1234567890123456); // as is, not hashed
  });

  it("missing data is not invented: a deal without value waits for data; completed data can be retried with the same event id", async () => {
    const c2 = await db.contact.create({ data: { businessId: a.business.id, fullName: "Yossi", phoneE164: "+972501234568", phoneRaw: "x" } });
    const deal = await db.deal.create({ data: { businessId: a.business.id, contactId: c2.id, title: "no value", amount: 0, currency: "ILS", status: "open", stage: "negotiation" } });
    await run(() => updateDeal(a.session, deal.id, { stage: "won" } as never)); await flush();
    const ev = (await events({ entityId: deal.id }))[0];
    expect(ev).toMatchObject({ status: "pending_data", value: null });
    expect(ev.statusReason).toMatch(/שווי העסקה/);
    sent = []; await send(); expect(sent.flatMap((x) => x.body.data).some((d) => d.event_id === ev.eventId)).toBe(false); // other queued events may go out; this one never
    await db.deal.update({ where: { id: deal.id }, data: { amount: 450 } });
    sent = []; await run(() => capi.retryEvent(a.session, ev.id)); await send();
    const p = sent.flatMap((s) => s.body.data).find((d) => d.event_id === ev.eventId)!;
    expect(p).toMatchObject({ event_id: ev.eventId, custom_data: { value: 450, currency: "ILS" } });
  });

  it("the site already sends Purchase: a matching CRM purchase is skipped (one agreed source)", async () => {
    await run(() => capi.saveConnection(a.session, { datasetId: "1234567890", siteSendsPurchase: true }));
    await run(() => capi.checkConnection(a.session)); await run(() => capi.setSending(a.session, true));
    const c3 = await db.contact.create({ data: { businessId: a.business.id, fullName: "Store Buyer", phoneE164: "+972501234569", phoneRaw: "x" } });
    await db.storeOrder.create({ data: { id: crypto.randomUUID(), businessId: a.business.id, contactId: c3.id, source: "woocommerce", externalId: "9001", orderNumber: "9001", status: "processing", currency: "ILS", total: 320, placedAt: new Date() } });
    const deal = await db.deal.create({ data: { businessId: a.business.id, contactId: c3.id, title: "web order", amount: 320, currency: "ILS", status: "won", stage: "won", closedAt: new Date() } });
    await run(() => capi.enqueueOccurrence(a.business.id, { trigger: "deal_won", contactId: c3.id, entityType: "deal", entityId: deal.id, occurredAt: new Date(), occurrenceKey: "site-1", dealId: deal.id }));
    const ev = (await events({ entityId: deal.id }))[0];
    expect(ev).toMatchObject({ status: "skipped" });
    expect(ev.statusReason).toMatch(/9001/);
  });

  it("revoked authorization stops sending and keeps the events; a temporary failure retries with backoff", async () => {
    const c4 = await db.contact.create({ data: { businessId: a.business.id, fullName: "Retry Person", phoneE164: "+972501234570", phoneRaw: "x" } });
    const ap = await run(() => createAppointment(a.session, { contactId: c4.id, scheduledAt: new Date(Date.now() + 86400_000).toISOString() })); await flush();
    graphMode = "transient"; await send();
    let ev = (await events({ entityId: ap.id }))[0];
    expect(ev).toMatchObject({ status: "queued", attempts: 1 });
    expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(ev.lastError).toMatch(/זמנית/);
    await db.metaCapiEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date() } });
    graphMode = "auth"; await send();
    ev = (await events({ entityId: ap.id }))[0];
    expect(ev.status).toBe("queued"); // not burned
    expect(await run(() => capi.getConnection(a.business.id))).toMatchObject({ status: "revoked", enabled: false, lastError: expect.stringMatching(/טוקן/) });
    graphMode = "ok";
  });

  it("isolation: another business sees none of these rules or events (API too)", async () => {
    const r = await eventsRoute.GET(await req(b.session, "/api/marketing/capi/events"), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect((await r.json()).data.items).toEqual([]);
    const o = await overviewRoute.GET(await req(b.session, "/api/marketing/capi"), { params: Promise.resolve({}) });
    const body = (await o.json()).data;
    expect(body.connection).toBeNull(); expect(body.rules).toEqual([]);
    expect(await withBusiness(b.business.id, () => db.metaCapiEvent.count({ where: { businessId: b.business.id } }))).toBe(0);
    // validation: a custom event name must be valid English and not a standard name
    expect(capi.ruleSchema.safeParse({ name: "x", trigger: "lead_created", eventKind: "custom", eventName: "ליד", actionSource: "other" }).success).toBe(false);
    expect(capi.ruleSchema.safeParse({ name: "x", trigger: "lead_created", eventKind: "custom", eventName: "Purchase", actionSource: "other" }).success).toBe(false);
    expect(capi.ruleSchema.safeParse({ name: "x", trigger: "deal_won", eventKind: "standard", eventName: "Purchase", actionSource: "phone_call", valueSource: "none" }).success).toBe(false);
  });
});
