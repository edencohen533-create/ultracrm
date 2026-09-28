import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as events from "@/lib/events";
import { ingestProviderEvents } from "@/server/services/delivery-status-service";
import { createBusiness, destroyBusiness } from "./helpers";
import type { ProviderCredential } from "@/generated/prisma/client";

vi.mock("@/lib/events", async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
let tenant: Awaited<ReturnType<typeof createBusiness>>;
let credential: ProviderCredential;
beforeAll(async () => {
  tenant = await createBusiness("webhook-reliability");
  credential = await db.providerCredential.create({ data: { businessId: tenant.business.id, channel: "sms", provider: "mock_sms", config: {} } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });
const inbound = (key: string) => ({ kind: "inbound" as const, eventId: `${tenant.business.id}:${key}`, providerMessageId: `${tenant.business.id}:${key}`, from: "+972509883001", to: "+972509883002", body: "Hello", at: new Date() });
async function outbound(status: "ACCEPTED" | "READ" = "ACCEPTED") {
  const contact = await db.contact.upsert({ where: { businessId_phoneE164: { businessId: tenant.business.id, phoneE164: "+972509883009" } }, update: {}, create: { businessId: tenant.business.id, fullName: "Delivery", phoneRaw: "0509883009", phoneE164: "+972509883009" } });
  const conversation = await db.conversation.create({ data: { businessId: tenant.business.id, contactId: contact.id, channel: "sms", providerCredentialId: credential.id } });
  return db.message.create({ data: { businessId: tenant.business.id, conversationId: conversation.id, channel: "sms", direction: "OUTBOUND", type: "TEXT", status, providerCredentialId: credential.id, providerMessageId: `${conversation.id}:provider` } });
}
it("a failed inbound event remains retryable and commits exactly one message", async () => {
  const ev = inbound("retry-inbound");
  const original = events.emitEvent;
  vi.spyOn(events, "emitEvent").mockImplementation(async (...args) => {
    if (args[1].type === "message.received") throw new Error("temporary event-store failure");
    return original(...args);
  });
  await expect(ingestProviderEvents(credential, [ev])).rejects.toThrow("temporary event-store failure");
  vi.restoreAllMocks();
  expect(await ingestProviderEvents(credential, [ev])).toMatchObject([{ outcome: "inbound" }]);
  expect(await db.message.count({ where: { inboundKey: `${credential.provider}:${ev.providerMessageId}` } })).toBe(1);
  expect(await ingestProviderEvents(credential, [ev])).toMatchObject([{ outcome: "duplicate" }]);
});
it("delivery status and its failure event roll back together and retry successfully", async () => {
  const message = await outbound();
  const ev = { kind: "status" as const, eventId: `${message.id}:failed`, providerMessageId: message.providerMessageId!, status: "FAILED" as const, at: new Date() };
  vi.spyOn(events, "emitEvent").mockRejectedValueOnce(new Error("temporary event-store failure"));
  await expect(ingestProviderEvents(credential, [ev])).rejects.toThrow("temporary event-store failure");
  expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("ACCEPTED");
  vi.restoreAllMocks();
  expect(await ingestProviderEvents(credential, [ev])).toMatchObject([{ outcome: "status:FAILED" }]);
  expect(await db.domainEvent.count({ where: { businessId: tenant.business.id, dedupeKey: `message.delivery_failed:${message.id}` } })).toBe(1);
});
it("a late failure cannot downgrade an already read message", async () => {
  const message = await outbound("READ");
  await ingestProviderEvents(credential, [{ kind: "status", eventId: `${message.id}:late`, providerMessageId: message.providerMessageId!, status: "FAILED", at: new Date() }]);
  expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("READ");
});
it("simultaneous duplicate SMS callbacks create one message and unread increment", async () => {
  const ev = inbound("parallel");
  const result = await Promise.all(Array.from({ length: 6 }, () => ingestProviderEvents(credential, [ev])));
  expect(result.flat().filter(r => r.outcome === "inbound")).toHaveLength(1);
  const message = await db.message.findUniqueOrThrow({ where: { inboundKey: `${credential.provider}:${ev.providerMessageId}` }, include: { conversation: true } });
  expect(await db.message.count({ where: { conversationId: message.conversationId } })).toBe(message.conversation.unreadCount);
});

it("different simultaneous event IDs for one inbound message remain idempotent", async () => {
  const ev = inbound("parallel-events");
  const result = await Promise.all(Array.from({ length: 4 }, (_, i) => ingestProviderEvents(credential, [{ ...ev, eventId: `${ev.eventId}:${i}` }])));
  expect(result.flat().filter(r => r.outcome === "inbound")).toHaveLength(1);
  expect(result.flat().filter(r => r.outcome === "duplicate_inbound")).toHaveLength(3);
});
it("concurrent delivery callbacks cannot move status backwards", async () => {
  const message = await outbound();
  await Promise.all(Array.from({ length: 12 }, (_, i) => ingestProviderEvents(credential, [{ kind: "status", eventId: `${message.id}:${i}`, providerMessageId: message.providerMessageId!, status: i % 3 === 0 ? "DELIVERED" : "SENT", at: new Date() }])));
  expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("DELIVERED");
});
