/**
 * Round 8: "הסר" reply removes the contact from every distribution list (+ tag) when the business enables it;
 * campaign sending pace (X recipients per interval) is honoured by the worker; lead status change → WhatsApp.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { createContact } = await import("@/lib/crm/contacts");
const { createInboundMessage } = await import("@/server/services/message-service");
const { createCampaign, changeCampaignStatus } = await import("@/server/services/campaign-service");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { saveSequence, sequenceSchema, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { createLead, updateLead } = await import("@/lib/crm/pipeline");
const { processDomainEvents, waitForEvents } = await import("@/lib/events");

describe("automations round 8", () => {
  let t: Awaited<ReturnType<typeof createBusiness>>;
  const run = <T,>(fn: () => Promise<T>) => withBusiness(t.business.id, fn, t.session);
  let waTpl: string; let listId: string; const contacts: string[] = [];
  beforeAll(async () => {
    t = await createBusiness("r8", { modules: { messaging: true, crm: true } });
    await db.business.update({ where: { id: t.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 0 } } } });
    await db.providerCredential.create({ data: { businessId: t.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    waTpl = (await db.template.create({ data: { businessId: t.business.id, channel: "whatsapp", name: "wa_r8", language: "he", category: "MARKETING", body: "שלום {{1}}", status: "APPROVED" } })).id;
    for (let i = 0; i < 5; i++) contacts.push((await run(() => createContact(t.session, { fullName: `R8 ${i}`, phone: `050300${String(i).padStart(4, "0")}`, consentStatus: "OPTED_IN", consentEvidence: "t" }))).id);
    listId = (await db.distributionList.create({ data: { businessId: t.business.id, name: "r8", members: { create: contacts.map((contactId) => ({ contactId })) } } })).id;
  });
  afterAll(async () => { await destroyBusiness(t.business.id, [t.account.id]); });

  it("'הסר' removes from lists and tags only when enabled; the marketing block is always applied", async () => {
    await run(() => createInboundMessage({ contactId: contacts[4], body: "הסר", providerMessageId: `r8-a-${Date.now()}` }));
    expect(await db.distributionListMember.count({ where: { contactId: contacts[4] } })).toBe(1); // default: lists untouched
    expect(await db.suppression.count({ where: { contactId: contacts[4], revokedAt: null } })).toBeGreaterThan(0);
    const s = await db.business.findUniqueOrThrow({ where: { id: t.business.id }, select: { settings: true } });
    await db.business.update({ where: { id: t.business.id }, data: { settings: { ...(s.settings as object), automations: { unsubscribe: { removeFromLists: true, tagName: "הוסר מדיוור" } } } } });
    await run(() => createInboundMessage({ contactId: contacts[4], body: "הסר", providerMessageId: `r8-b-${Date.now()}` }));
    expect(await db.distributionListMember.count({ where: { contactId: contacts[4] } })).toBe(0);
    expect(await db.contactTag.count({ where: { contactId: contacts[4], tag: { name: "הוסר מדיוור" } } })).toBe(1);
    expect(await db.distributionListMember.count({ where: { listId } })).toBe(4); // others stay
  });

  it("sending pace: 2 recipients per 30 minutes → first worker runs send exactly 2", async () => {
    const c = await run(() => createCampaign({ channel: "whatsapp", name: "pace", listId, templateId: waTpl, variables: { "1": "{name}" } }, t.user.id));
    await run(() => changeCampaignStatus(c.id, "start", undefined, t.user.id, undefined, { batchSize: 2, intervalMinutes: 30 }));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).throttle).toEqual({ batchSize: 2, intervalMinutes: 30 });
    await run(() => processDueCampaigns()); await run(() => processDueCampaigns());
    expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "SENT" } })).toBe(2);
    expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "QUEUED" } })).toBe(2);
    // next interval: move the earlier claims back in time → the next batch goes out
    await db.campaignRecipient.updateMany({ where: { campaignId: c.id, status: "SENT" }, data: { claimedAt: new Date(Date.now() - 31 * 60_000) } });
    await run(() => processDueCampaigns());
    expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "SENT" } })).toBe(4);
  });

  it("lead status changed to 'qualified' → WhatsApp template sent to the contact", async () => {
    await run(() => saveSequence(t.session, sequenceSchema.parse({ name: "status→wa", trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: "qualified" }, stopOn: [], steps: [{ action: "send", channel: "whatsapp", templateId: waTpl, waitMinutes: 0, variables: { "1": "{name}" }, condition: { requireNoReply: false } }] })));
    const fresh = (await run(() => createContact(t.session, { fullName: "R8 status", phone: "0503009999", consentStatus: "OPTED_IN", consentEvidence: "t" }))).id;
    const lead = await run(() => createLead(t.session, { contactId: fresh, title: "L" }));
    await processDomainEvents({ businessId: t.business.id }); await waitForEvents(t.business.id);
    const before = await db.message.count({ where: { conversation: { contactId: fresh }, templateId: waTpl, direction: "OUTBOUND" } });
    await run(() => updateLead(t.session, lead.id, { status: "qualified" }));
    await processDomainEvents({ businessId: t.business.id }); await waitForEvents(t.business.id);
    let after = before;
    for (let i = 0; i < 30 && after === before; i++) { await run(() => processDueSequenceRuns()); after = await db.message.count({ where: { conversation: { contactId: fresh }, templateId: waTpl, direction: "OUTBOUND" } }); if (after === before) await new Promise((r) => setTimeout(r, 5000)); }
    expect(after).toBe(before + 1);
  });
});
