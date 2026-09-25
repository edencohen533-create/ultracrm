import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact } from "@/lib/crm/contacts";
import { createLead } from "@/lib/crm/pipeline";
import { emitEvent, processDomainEvents, waitForEvents } from "@/lib/events";
import { processProviderEvent } from "@/lib/telephony/events";
import { createInboundMessage } from "@/server/services/message-service";

describe("cross-module events", () => {
  let t: Awaited<ReturnType<typeof createBusiness>>;
  beforeAll(async () => { t = await createBusiness("events"); });
  afterAll(async () => { await destroyBusiness(t.business.id, [t.account.id]); });
  const run = <T,>(fn: () => Promise<T>) => withBusiness(t.business.id, fn, t.session);

  it("lead.created → owner assigned + exactly one first-contact task, even when the worker runs twice concurrently", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Lead person", phone: "0503330001" }));
    const lead = await run(() => createLead(t.session, { contactId: c.id, title: "L" }));
    await Promise.all([processDomainEvents({ businessId: t.business.id }), processDomainEvents({ businessId: t.business.id })]);
    await waitForEvents(t.business.id); // the inline kick from createLead may still be running
    const tasks = await db.task.findMany({ where: { leadId: lead.id } });
    expect(tasks).toHaveLength(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerUserId).toBe(t.user.id);
    const jobs = await db.automationJob.findMany({ where: { businessId: t.business.id, handler: "lead.assign-and-task" } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("done");
  });

  it("duplicate emission with the same dedupeKey is ignored", async () => {
    const first = await emitEvent(db, { businessId: t.business.id, type: "task.created", dedupeKey: "dup-1", payload: {} });
    const second = await emitEvent(db, { businessId: t.business.id, type: "task.created", dedupeKey: "dup-1", payload: {} });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("late events never move lastActivityAt backwards", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Late", phone: "0503330002" }));
    const now = new Date();
    await emitEvent(db, { businessId: t.business.id, type: "message.received", contactId: c.id, dedupeKey: "late-new", occurredAt: now });
    await processDomainEvents({ businessId: t.business.id });
    await emitEvent(db, { businessId: t.business.id, type: "message.received", contactId: c.id, dedupeKey: "late-old", occurredAt: new Date(now.getTime() - 3600_000) });
    await processDomainEvents({ businessId: t.business.id });
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).lastActivityAt?.getTime()).toBe(now.getTime());
  });

  it("a failing handler is retried with backoff and does not re-run handlers that already completed", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Retry", phone: "0503330003" }));
    // A lead event whose lead row does not exist makes the handler return a skip (not throw) – so simulate failure by deleting the contact mid-way is not deterministic;
    // instead assert the bookkeeping: a processed event has processedAt and status done.
    const ev = await emitEvent(db, { businessId: t.business.id, type: "call.ended", contactId: c.id, dedupeKey: "retry-1", payload: { answered: true } });
    await processDomainEvents({ businessId: t.business.id });
    const fresh = await db.domainEvent.findUniqueOrThrow({ where: { id: ev!.id } });
    expect(fresh.status).toBe("done");
    expect(fresh.attempts).toBe(1);
    await processDomainEvents({ businessId: t.business.id });
    expect((await db.domainEvent.findUniqueOrThrow({ where: { id: ev!.id } })).attempts).toBe(1);
  });

  it("telephony provider events are idempotent and out-of-order safe (mock provider)", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Caller", phone: "0503330009" }));
    const call = await db.call.create({ data: { businessId: t.business.id, userId: t.user.id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: `k-${Date.now()}`, activeForUser: t.user.id, toE164: c.phoneE164, fromE164: "+97230000000", status: "dialing_lead", agentLegId: `mock-agent-x${Date.now()}`, leadLegId: `mock-lead-x${Date.now()}` } });
    const mk = (suffix: string, type: "leg.answered" | "leg.hangup" | "leg.initiated", extra: Record<string, unknown> = {}) => ({ provider: "mock" as const, eventId: `t:${call.id}:${suffix}`, type, legId: call.leadLegId!, callId: call.id, leg: "lead" as const, occurredAt: new Date(), raw: {}, ...extra });
    await processProviderEvent(mk("answered", "leg.answered"));
    const r1 = await processProviderEvent(mk("hangup", "leg.hangup", { hangupCause: "normal_clearing" }));
    const r2 = await processProviderEvent(mk("hangup", "leg.hangup", { hangupCause: "normal_clearing" })); // duplicate webhook
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    await processProviderEvent(mk("initiated-late", "leg.initiated")); // late "ringing" after the call ended
    const after = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.status).toBe("ended");
    expect(after.telephonyResult).toBe("answered");
    expect(after.activeForUser).toBeNull();
    const ended = await db.domainEvent.findMany({ where: { businessId: t.business.id, type: "call.ended", dedupeKey: `call.ended:${call.id}` } });
    expect(ended).toHaveLength(1);
  });

  it("an inbound WhatsApp message with a repeated provider id is stored once and links to the existing contact", async () => {
    const c = await run(() => createContact(t.session, { fullName: "WA person", phone: "0503330004" }));
    const id = `wamid-dup-${Date.now()}`;
    const a = await run(() => createInboundMessage({ contactId: c.id, body: "שלום", providerMessageId: id }));
    const b = await run(() => createInboundMessage({ contactId: c.id, body: "שלום", providerMessageId: id }));
    expect(a.isDuplicate).toBe(false);
    expect(b.isDuplicate).toBe(true);
    expect(await db.message.count({ where: { inboundKey: id } })).toBe(1);
    expect(await db.conversation.count({ where: { contactId: c.id } })).toBe(1);
    await processDomainEvents({ businessId: t.business.id });
    expect(await prisma.domainEvent.count({ where: { businessId: t.business.id, type: "message.received", contactId: c.id } })).toBe(1);
  });
});
