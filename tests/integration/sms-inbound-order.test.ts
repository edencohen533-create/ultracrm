import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ingestProviderEvents } from "@/server/services/delivery-status-service";
import { createBusiness, destroyBusiness } from "./helpers";

vi.mock("@/lib/events", async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
let tenant: Awaited<ReturnType<typeof createBusiness>>;
beforeAll(async () => { tenant = await createBusiness("sms-order"); });
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });

it("late SMS webhooks preserve newer inbox and inbound timestamps while recording the message", async () => {
  const credential = await db.providerCredential.create({ data: { businessId: tenant.business.id, channel: "sms", provider: "mock_sms", config: {} } });
  const send = (id: string, at: Date) => ingestProviderEvents(credential, [{ kind: "inbound", eventId: `${tenant.business.id}:${id}`, providerMessageId: `${tenant.business.id}:${id}`, from: "+972509882001", to: "+972509882002", body: "Test SMS", at }]);
  const newest = new Date("2026-09-28T10:00:00Z");
  const delayed = new Date("2026-09-28T09:00:00Z");
  const outboundAt = new Date("2026-09-28T11:00:00Z");
  await send("new", newest);
  const conversation = await db.conversation.findFirstOrThrow({ where: { businessId: tenant.business.id, channel: "sms" } });
  await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: outboundAt } });
  await send("old", delayed);
  expect(await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ lastInboundAt: newest, lastMessageAt: outboundAt, unreadCount: 2 });
  expect(await db.message.count({ where: { conversationId: conversation.id, direction: "INBOUND" } })).toBe(2);
  await send("old", delayed);
  expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBe(2);
});
