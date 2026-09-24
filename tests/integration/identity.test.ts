import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact, updateContact, addContactPhone } from "@/lib/crm/contacts";
import { normalizePhone } from "@/lib/phone";
import { handleInboundInitiated } from "@/lib/dialer/inbound";
import { MetaWhatsAppProvider } from "@/server/providers/meta-whatsapp-provider";
import { verifyTelnyxSignature } from "@/lib/telephony/telnyx";

describe("shared identity", () => {
  let t: Awaited<ReturnType<typeof createBusiness>>;
  beforeAll(async () => { t = await createBusiness("ident"); });
  afterAll(async () => { await destroyBusiness(t.business.id, [t.account.id]); });
  const run = <T,>(fn: () => Promise<T>) => withBusiness(t.business.id, fn, t.session);

  it("local and international spellings normalise to one contact; a second contact with the same number is refused", async () => {
    expect(normalizePhone("050-444-0001")).toBe("+972504440001");
    expect(normalizePhone("+972 50 444 0001")).toBe("+972504440001");
    const c = await run(() => createContact(t.session, { fullName: "One", phone: "050-444-0001" }));
    await expect(run(() => createContact(t.session, { fullName: "Two", phone: "+972504440001" }))).rejects.toMatchObject({ code: "duplicate_phone" });
    // An additional phone owned by another contact is refused too (no silent merge).
    const other = await run(() => createContact(t.session, { fullName: "Other", phone: "0504440002" }));
    await expect(run(() => addContactPhone(t.session, other.id, "0504440001"))).rejects.toMatchObject({ code: "duplicate_phone" });
    expect(c.id).toBeTruthy();
  });

  it("renaming / renumbering a contact keeps its calls, messages and tasks (same contactId)", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Before", phone: "0504440003" }));
    const call = await db.call.create({ data: { businessId: t.business.id, userId: t.user.id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: `k-${Date.now()}`, toE164: c.phoneE164, fromE164: "+97230000000", status: "ended", endedAt: new Date() } });
    const conv = await db.conversation.create({ data: { businessId: t.business.id, contactId: c.id, source: "MANUAL" } });
    await run(() => updateContact(t.session, c.id, { fullName: "After", phone: "0504440099" }));
    const fresh = await db.contact.findUniqueOrThrow({ where: { id: c.id }, include: { calls: true, conversations: true } });
    expect(fresh.fullName).toBe("After");
    expect(fresh.phoneE164).toBe("+972504440099");
    expect(fresh.calls.map((x) => x.id)).toEqual([call.id]);
    expect(fresh.conversations.map((x) => x.id)).toEqual([conv.id]);
  });

  it("an inbound WhatsApp message from a known additional phone lands on the existing card; unknown numbers get one new card", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Known", phone: "0504440010" }));
    await run(() => addContactPhone(t.session, c.id, "0504440011"));
    const provider = new MetaWhatsAppProvider({ accessToken: "x", phoneNumberId: "111", webhookVerifyToken: "v", appSecret: "s" }, undefined);
    const payload = (from: string, id: string) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hi" } }] } }] }] });
    await run(() => provider.receiveWebhook(payload("972504440011", `m1-${Date.now()}`)));
    expect(await db.conversation.count({ where: { contactId: c.id } })).toBe(1);
    expect(await db.contact.count({ where: { businessId: t.business.id, phoneE164: "+972504440011" } })).toBe(0); // no duplicate card
    const unknownId = `m2-${Date.now()}`;
    await Promise.all([run(() => provider.receiveWebhook(payload("972504440020", unknownId))), run(() => provider.receiveWebhook(payload("972504440020", `${unknownId}b`)))]);
    expect(await db.contact.count({ where: { businessId: t.business.id, phoneE164: "+972504440020" } })).toBe(1);
  });

  it("an inbound call from a known number resolves the same contact (mock telephony)", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Caller", phone: "0504440030" }));
    await db.phoneNumber.create({ data: { businessId: t.business.id, e164: `+97230${String(Date.now()).slice(-6)}`, provider: "mock" } });
    const number = await db.phoneNumber.findFirstOrThrow({ where: { businessId: t.business.id } });
    const call = await handleInboundInitiated({ provider: "mock", eventId: `in-${Date.now()}`, type: "leg.initiated", legId: `mock-lead-in-${Date.now()}`, direction: "incoming", from: "+972504440030", to: number.e164, raw: {} });
    expect(call?.contactId).toBe(c.id);
    expect(call?.businessId).toBe(t.business.id);
    expect(await db.contact.count({ where: { businessId: t.business.id, phoneE164: "+972504440030" } })).toBe(1);
  });

  it("webhook signature verification rejects tampered payloads", () => {
    expect(verifyTelnyxSignature("{}", "bad", String(Math.floor(Date.now() / 1000)))).toBe(false);
    const provider = new MetaWhatsAppProvider({ accessToken: "x", phoneNumberId: "1", webhookVerifyToken: "v", appSecret: "secret" });
    expect(provider.verifyWebhook(new Headers({ "x-hub-signature-256": "sha256=deadbeef" }), "{}")).toBe(false);
  });
});
