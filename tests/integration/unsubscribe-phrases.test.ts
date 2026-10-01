import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createContact } from "@/lib/crm/contacts";
import { createInboundMessage } from "@/server/services/message-service";
import { createBusiness, destroyBusiness } from "./helpers";
let tenant: Awaited<ReturnType<typeof createBusiness>>;
let sequence = 0;
beforeAll(async () => {
  tenant = await createBusiness("unsubscribe-phrases", { modules: { whatsapp: true, crm: true } });
  await db.business.update({ where: { id: tenant.business.id }, data: { settings: { automations: { unsubscribe: { removeFromLists: true, tagName: "ביקש הסרה" } } } } });
  await db.providerCredential.create({ data: { businessId: tenant.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
});
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });
it.each(["אל תשלחו לי הודעות יותר", "אל תתקשרו אליי יותר", "הסר בבקשה", "נא להפסיק לשלוח לי הודעות", "הסירו מרשימת התפוצה"])("inbound '%s' removes from static lists, tags, blocks marketing and calls", async body => {
  await withBusiness(tenant.business.id, async () => {
    const contact = await createContact(tenant.session, { fullName: `Phrase ${sequence}`, phone: `050308${String(++sequence).padStart(4, "0")}`, consentStatus: "OPTED_IN", consentEvidence: "QA" });
    await db.distributionList.create({ data: { businessId: tenant.business.id, name: "QA", members: { create: { contactId: contact.id } } } });
    await createInboundMessage({ contactId: contact.id, body, providerMessageId: `phrase-${tenant.business.id}-${sequence}` });
    expect(await db.distributionListMember.count({ where: { contactId: contact.id } })).toBe(0);
    expect(await db.contactTag.count({ where: { contactId: contact.id, tag: { name: "ביקש הסרה" } } })).toBe(1);
    expect(await db.suppression.count({ where: { contactId: contact.id, revokedAt: null, pendingReview: false } })).toBeGreaterThan(0);
    expect(await db.dncEntry.count({ where: { businessId: tenant.business.id, phoneE164: contact.phoneE164 } })).toBe(1);
  }, tenant.session);
});
