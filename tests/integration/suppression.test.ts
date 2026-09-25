import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact, importContacts, addContactPhone } from "@/lib/crm/contacts";
import { revokeSuppressions, sendBlockReason, suppressContact, callBlockReason } from "@/lib/suppression";
import { createInboundMessage, createOutboundMessage, MessagePolicyError } from "@/server/services/message-service";
import { startConversationForAutomation } from "@/server/services/conversation-service";
import { processDueCampaigns } from "@/jobs/campaign-runner";

describe("global suppression", () => {
  let t: Awaited<ReturnType<typeof createBusiness>>;
  beforeAll(async () => { t = await createBusiness("supp"); });
  afterAll(async () => { await destroyBusiness(t.business.id, [t.account.id]); });
  const run = <T,>(fn: () => Promise<T>) => withBusiness(t.business.id, fn, t.session);

  it("an inbound 'הסר' blocks marketing on every identifier of the contact (phone + extra phone + email), keeps the contact", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Opt out", phone: "0502220001", email: "opt@test.local", consentStatus: "OPTED_IN", consentEvidence: "test" }));
    await run(() => addContactPhone(t.session, c.id, "0502220002"));
    await run(() => createInboundMessage({ contactId: c.id, body: "הסר", providerMessageId: `wamid-${Date.now()}` }));
    const active = await db.suppression.findMany({ where: { businessId: t.business.id, contactId: c.id, revokedAt: null } });
    expect(active.map((s) => s.identifier).sort()).toEqual(["+972502220001", "+972502220002", "opt@test.local"]);
    expect(await run(() => sendBlockReason(t.business.id, c.id, "marketing"))).toMatch(/הוסר/);
    expect(await run(() => sendBlockReason(t.business.id, c.id, "service"))).toBeNull(); // service still allowed
    expect(await db.contact.findUnique({ where: { id: c.id } })).not.toBeNull();
  });

  it("re-import with OPTED_IN and a provider switch do not resubscribe; revoking requires evidence", async () => {
    const c = await db.contact.findFirstOrThrow({ where: { businessId: t.business.id, phoneE164: "+972502220001" } });
    await run(() => importContacts(t.session, [{ fullName: "Opt out", phone: "0502220001", consentStatus: "OPTED_IN" }]));
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).consentStatus).toBe("OPTED_OUT");
    await db.providerCredential.create({ data: { businessId: t.business.id, provider: "mock", isActive: true, config: {} } });
    expect(await run(() => sendBlockReason(t.business.id, c.id, "marketing"))).not.toBeNull();
    await expect(run(() => revokeSuppressions(t.business.id, c.id, t.user.id, ""))).rejects.toThrow(/תיעוד הסכמה/);
    await run(() => revokeSuppressions(t.business.id, c.id, t.user.id, "הלקוח אישר בטלפון"));
    expect(await run(() => sendBlockReason(t.business.id, c.id, "marketing"))).toBeNull();
    expect((await db.suppression.count({ where: { contactId: c.id, revokedAt: null } }))).toBe(0);
    expect((await db.suppression.count({ where: { contactId: c.id } }))).toBeGreaterThan(0); // history retained
  });

  it("the worker re-checks suppression right before the provider: a queued campaign recipient is skipped, an already-sent message is untouched", async () => {
    const c = await run(() => createContact(t.session, { fullName: "Campaign target", phone: "0502220003", consentStatus: "OPTED_IN", consentEvidence: "test" }));
    const template = await db.template.create({ data: { businessId: t.business.id, name: `t${Date.now()}`, language: "he", category: "MARKETING", body: "שלום {{1}}", variables: ["1"], status: "APPROVED" } });
    const list = await db.distributionList.create({ data: { businessId: t.business.id, name: "l", members: { create: [{ contactId: c.id }] } } });
    const conversation = await run(() => startConversationForAutomation(c.id, null, t.user.id));
    // Message already handed to the (mock) provider before the unsubscribe.
    const sent = await run(() => createOutboundMessage({ conversationId: conversation.id, body: "", templateId: template.id, templateVariables: { "1": "x" }, sentByUserId: t.user.id, requireOptIn: true, requestKey: `k-${Date.now()}` }));
    expect(["SENT", "ACCEPTED", "DELIVERED", "READ"]).toContain(sent.message.status);
    const { activeSenderSnapshot, templateFingerprint } = await import("@/server/services/campaign-snapshot");
    const campaign = await run(async () => db.campaign.create({ data: { businessId: t.business.id, name: "c", listId: list.id, templateId: template.id, variables: { "1": "x" }, createdById: t.user.id, status: "RUNNING", senderSnapshot: await activeSenderSnapshot(null), templateSnapshot: templateFingerprint(template), recipients: { create: [{ contactId: c.id }] } } }));
    await run(() => suppressContact({ businessId: t.business.id, contactId: c.id, scope: "marketing", source: "sms", reason: "STOP" }));
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(recipient.status).toBe("SKIPPED"); // stopped before the provider
    await run(() => processDueCampaigns());
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).status).toBe("SKIPPED");
    expect((await db.message.findUniqueOrThrow({ where: { id: sent.message.id } })).status).not.toBe("FAILED"); // never re-labelled
    // Direct marketing send is refused by the send path too.
    await expect(run(() => createOutboundMessage({ conversationId: conversation.id, body: "", templateId: template.id, templateVariables: { "1": "x" }, sentByUserId: t.user.id, requireOptIn: true, requestKey: `k2-${Date.now()}` }))).rejects.toThrow(MessagePolicyError);
  });

  it("scope 'all' (do-not-contact) also blocks calls via the dialer DNC list and cancels open callbacks", async () => {
    const c = await run(() => createContact(t.session, { fullName: "DNC", phone: "0502220004" }));
    await db.task.create({ data: { businessId: t.business.id, userId: t.user.id, contactId: c.id, type: "callback", dueAt: new Date() } });
    await run(() => suppressContact({ businessId: t.business.id, contactId: c.id, scope: "all", source: "phone", reason: "outcome:dnc" }));
    expect(await run(() => callBlockReason(t.business.id, c.phoneE164))).not.toBeNull();
    expect(await db.dncEntry.count({ where: { businessId: t.business.id, phoneE164: c.phoneE164 } })).toBe(1);
    expect(await db.task.count({ where: { contactId: c.id, status: "open" } })).toBe(0);
    expect(await run(() => sendBlockReason(t.business.id, c.id, "service"))).not.toBeNull();
  });

  it("scoped prisma inside the suppression path never touches another business", async () => {
    const other = await createBusiness("supp-other");
    try {
      const oc = await withBusiness(other.business.id, () => createContact(other.session, { fullName: "Other", phone: "0502220001" }), other.session);
      // Business A suppressed +972502220001 earlier (then revoked) – business B's contact must be unaffected.
      expect(await withBusiness(other.business.id, () => sendBlockReason(other.business.id, oc.id, "service"))).toBeNull();
      expect(await db.suppression.count({ where: { businessId: other.business.id } })).toBe(0);
    } finally {
      await destroyBusiness(other.business.id, [other.account.id]);
    }
  });
});
