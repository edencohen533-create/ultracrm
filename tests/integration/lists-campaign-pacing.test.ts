/**
 * Lists administration + broadcast pacing (real DB, mock WhatsApp):
 *  • deactivating a list while a dialer session runs: no new leads, the live call is untouched, reservations released;
 *  • moving selected / all leads keeps status, attempts, owner, DNC and call history; duplicates merge; a lead in a
 *    live call stays; another business's list is out of reach;
 *  • deleting a list: needs the name, refused during a live call, ends sessions, keeps contacts / calls / tasks;
 *    system lists are kept;
 *  • "צא בלי לשמור": an edited draft goes back to how it was opened; a campaign built meanwhile is removed;
 *  • runner: Meta 24h unique-recipient limit (already-messaged contacts do not count), invalid number skipped,
 *    pause / resume, recovery after a crash without double sends.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { setListActive, moveListLeads, deleteList, listDeletionInfo, isListOpen } = await import("@/lib/dialer/list-admin");
const { claimNextLead } = await import("@/lib/dialer/queue");
const { createCampaign, changeCampaignStatus } = await import("@/server/services/campaign-service");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { createDraft, updateDraft, revertDraft, getDraft } = await import("@/server/services/campaign-draft-service");
const { whatsappCapacity, tierLimit } = await import("@/lib/meta/messaging-limit");

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
const accounts: string[] = [];
const run = <T,>(biz: Biz, fn: () => Promise<T>) => withBusiness(biz.business.id, fn, biz.session);
let seq = 0;
const phone = () => { seq++; return `+9725${String(40000000 + (Date.now() % 1000000) * 10 + seq).slice(-8)}`; };
const contact = (biz: Biz, extra: Record<string, unknown> = {}) => { const p = phone(); return db.contact.create({ data: { businessId: biz.business.id, fullName: `L ${seq}`, phoneE164: p, phoneRaw: p, consentStatus: "OPTED_IN", ownerUserId: biz.user.id, ...extra } }); };
const list = (biz: Biz, name: string, extra: Record<string, unknown> = {}) => db.dialList.create({ data: { businessId: biz.business.id, name, ...extra } });

describe("lists administration + broadcast pacing", { timeout: 900_000 }, () => {
  let agent: SessionUser;
  beforeAll(async () => {
    A = await createBusiness("lists-a", { modules: { crm: true, telephony: true, whatsapp: true, messaging: true } });
    B = await createBusiness("lists-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "סוכן", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "סוכן", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "סוכן", role: "agent", teamId: null };
    await db.business.update({ where: { id: A.business.id }, data: { settings: { dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 0 } } } });
  }, 600_000);
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("deactivating a list while agents dial: no new leads, the live call is untouched, reservations released; reactivation restores the queue", async () => {
    const l = await list(A, "פעילה");
    const [c1, c2, c3] = [await contact(A), await contact(A), await contact(A)];
    const live = await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c1.id, status: "in_call", lockedByUserId: agent.id } });
    const reserved = await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c2.id, status: "locked", lockedByUserId: agent.id, lockToken: "x", lockExpiresAt: new Date(Date.now() + 60_000) } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c3.id } });
    await db.dialerSession.create({ data: { businessId: A.business.id, userId: A.user.id, listId: l.id, mode: "preview", browserSessionId: "s1", status: "active" } });
    const r = await run(A, () => setListActive(A.session, l.id, false));
    expect(r).toMatchObject({ isActive: false, releasedReservations: 1, callsInProgress: 1 });
    expect(await isListOpen(db, l.id)).toBe(false);
    await expect(run(A, () => claimNextLead(A.business.id, A.user.id, l.id))).rejects.toMatchObject({ code: "list_inactive" });
    expect((await db.listLead.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("in_call");
    expect(await db.listLead.findUniqueOrThrow({ where: { id: reserved.id } })).toMatchObject({ status: "pending", lockedByUserId: null });
    await run(A, () => setListActive(A.session, l.id, true));
    expect(await run(A, () => claimNextLead(A.business.id, A.user.id, l.id))).not.toBeNull();
  });

  it("move leads: status, attempts, owner, DNC and history kept; duplicates merged; a live call stays; other business out of reach", async () => {
    const src = await list(A, "מקור"), dst = await list(A, "יעד");
    const [a, b, c, d] = [await contact(A), await contact(A), await contact(A), await contact(A)];
    const ra = await db.listLead.create({ data: { businessId: A.business.id, listId: src.id, contactId: a.id, status: "callback", attempts: 3, preferredUserId: agent.id, nextAttemptAt: new Date(Date.now() + 3600_000) } });
    const rb = await db.listLead.create({ data: { businessId: A.business.id, listId: src.id, contactId: b.id, status: "dnc", attempts: 1 } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: src.id, contactId: c.id, status: "in_call" } });
    const rd = await db.listLead.create({ data: { businessId: A.business.id, listId: src.id, contactId: d.id, status: "pending", attempts: 5 } });
    // d is already in the target list (pending, 1 attempt) → merged, not duplicated.
    const existing = await db.listLead.create({ data: { businessId: A.business.id, listId: dst.id, contactId: d.id, status: "pending", attempts: 1 } });
    const call = await db.call.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: d.id, listId: src.id, leadId: rd.id, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: d.phoneE164, fromE164: "+97230000000", status: "ended", endedAt: new Date() } });
    // Selected only (a) first.
    expect(await run(A, () => moveListLeads(A.session, src.id, { toListId: dst.id, leadIds: [ra.id] }))).toEqual({ moved: 1, merged: 0, skippedInCall: 0 });
    expect(await db.listLead.findUniqueOrThrow({ where: { id: ra.id } })).toMatchObject({ listId: dst.id, status: "callback", attempts: 3, preferredUserId: agent.id });
    // All the rest.
    expect(await run(A, () => moveListLeads(A.session, src.id, { toListId: dst.id, all: true }))).toEqual({ moved: 1, merged: 1, skippedInCall: 1 });
    expect(await db.listLead.findUniqueOrThrow({ where: { id: rb.id } })).toMatchObject({ listId: dst.id, status: "dnc" });
    expect(await db.listLead.count({ where: { listId: dst.id, contactId: d.id } })).toBe(1);
    expect(await db.listLead.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ attempts: 5 });
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).leadId).toBe(existing.id); // history re-pointed
    expect(await db.listLead.count({ where: { listId: src.id } })).toBe(1); // only the live call stayed
    // Another business's list: not found.
    const other = await list(B, "של עסק אחר");
    await expect(run(A, () => moveListLeads(A.session, src.id, { toListId: other.id, all: true }))).rejects.toMatchObject({ status: 404 });
  });

  it("delete list: name required, refused during a live call, ends sessions, keeps contacts / calls / tasks; system lists kept", async () => {
    const l = await list(A, "למחיקה");
    const [c1, c2] = [await contact(A), await contact(A)];
    const row = await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c1.id, status: "in_call" } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c2.id } });
    const call = await db.call.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: c1.id, listId: l.id, leadId: row.id, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c1.phoneE164, fromE164: "+97230000000", status: "ended", endedAt: new Date() } });
    const task = await db.task.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: c1.id, listLeadId: row.id, type: "callback", title: "x", dueAt: new Date() } });
    const session = await db.dialerSession.create({ data: { businessId: A.business.id, userId: A.user.id, listId: l.id, mode: "preview", browserSessionId: "s2", status: "active" } });
    expect(await run(A, () => listDeletionInfo(A.session, l.id))).toMatchObject({ leads: 2, callsInProgress: 1, openSessions: 1, system: null });
    await expect(run(A, () => deleteList(A.session, l.id, "שם אחר"))).rejects.toMatchObject({ code: "confirm_required" });
    await expect(run(A, () => deleteList(A.session, l.id, "למחיקה"))).rejects.toMatchObject({ code: "list_busy" });
    await db.listLead.update({ where: { id: row.id }, data: { status: "completed" } }); // the call ended
    expect(await run(A, () => deleteList(A.session, l.id, "למחיקה"))).toMatchObject({ deleted: true, leads: 2, endedSessions: 1 });
    expect(await db.dialList.count({ where: { id: l.id } })).toBe(0);
    expect(await db.contact.count({ where: { id: { in: [c1.id, c2.id] } } })).toBe(2);
    expect(await db.call.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ listId: null, leadId: null });
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ listLeadId: null });
    expect((await db.dialerSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("ended");
    const sys = await list(A, "לקוחות קיימים", { filterJson: { system: "customers" } });
    await expect(run(A, () => deleteList(A.session, sys.id, "לקוחות קיימים"))).rejects.toMatchObject({ code: "system_list" });
  });

  it("'צא בלי לשמור': an edited draft goes back to how it was opened; keys added meanwhile disappear", async () => {
    const d = await run(A, () => createDraft("sms", A.user.id, "מקורי"));
    const snap = { name: d.name, step: d.step, data: d.data as Record<string, unknown>, templateId: d.templateId, campaignId: d.campaignId };
    await run(A, () => updateDraft(d.id, { name: "נערך", data: { body: "טקסט חדש", variables: { a: "1" } } as never, step: "content" }));
    expect((await run(A, () => getDraft(d.id))).name).toBe("נערך");
    const back = await run(A, () => revertDraft(d.id, snap as never, A.user.id));
    expect(back).toMatchObject({ name: "מקורי", step: snap.step });
    expect(back.data).toEqual(snap.data);
    expect(await db.auditLog.count({ where: { businessId: A.business.id, action: "campaign.draft_reverted", entityId: d.id } })).toBe(1);
  });

  describe("campaign runner", () => {
    let tpl: string; let mockCred: string;
    beforeAll(async () => {
      mockCred = (await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } })).id;
      tpl = (await db.template.create({ data: { businessId: A.business.id, channel: "whatsapp", name: `pace_${Date.now()}`, language: "he", category: "MARKETING", body: "שלום", status: "APPROVED" } })).id;
    });
    const campaignFor = async (contactIds: string[], name: string) => {
      const dl = await db.distributionList.create({ data: { businessId: A.business.id, name, members: { create: contactIds.map((contactId) => ({ contactId })) } } });
      const c = await run(A, () => createCampaign({ channel: "whatsapp", name, listId: dl.id, templateId: tpl, variables: {}, providerCredentialId: mockCred } as never, A.user.id));
      await run(A, () => changeCampaignStatus(c.id, "start", undefined, A.user.id));
      return c;
    };

    it("Meta limit: only free capacity is used (already-messaged contacts do not count); the campaign waits with a reason", async () => {
      expect(tierLimit("TIER_2K")).toBe(2000); expect(tierLimit("TIER_UNLIMITED")).toBeNull(); expect(tierLimit("weird")).toBeUndefined();
      // A real Meta connection reporting the smallest tier (50) – not the sender of this campaign, the limit is per portfolio.
      await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, isDefault: false, status: "connected", phoneNumberId: `7${String(Date.now()).slice(-12)}`, wabaId: `8${String(Date.now()).slice(-12)}`, messagingLimitTier: "TIER_50", config: {} } });
      // 48 contacts already got a template in the last 24h.
      const conv = await db.conversation.create({ data: { businessId: A.business.id, contactId: (await contact(A)).id, channel: "whatsapp" } });
      const earlier: string[] = [];
      for (let i = 0; i < 47; i++) { const c = await contact(A); earlier.push(c.id); const cv = await db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, channel: "whatsapp" } }); await db.message.create({ data: { businessId: A.business.id, conversationId: cv.id, direction: "OUTBOUND", type: "TEMPLATE", body: "", templateId: tpl, status: "DELIVERED" } }); }
      await db.message.create({ data: { businessId: A.business.id, conversationId: conv.id, direction: "OUTBOUND", type: "TEMPLATE", body: "", templateId: tpl, status: "DELIVERED" } });
      expect(await run(A, () => whatsappCapacity(A.business.id))).toMatchObject({ limit: 50, used: 48, remaining: 2 });
      const fresh = [await contact(A), await contact(A), await contact(A), await contact(A)];
      const c = await campaignFor([...fresh.map((x) => x.id), earlier[0]], "limit");
      await run(A, () => processDueCampaigns()); await run(A, () => processDueCampaigns());
      // 2 new recipients (capacity) + the already-messaged one; 2 new ones wait.
      expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "SENT" } })).toBe(3);
      expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "QUEUED" } })).toBe(2);
      const after = await db.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.status).toBe("RUNNING");
      expect(after.statusReason).toMatch(/מגבלת Meta/);
      await db.providerCredential.updateMany({ where: { businessId: A.business.id, provider: "meta_whatsapp_cloud_api" }, data: { isActive: false } });
      await run(A, () => processDueCampaigns());
      expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "SENT" } })).toBe(5);
      expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).statusReason).toBeNull();
    });

    it("invalid number skipped; pause stops, resume continues; after a crash nothing is sent twice", async () => {
      const ok1 = await contact(A), ok2 = await contact(A), bad = await contact(A), crashed = await contact(A);
      const c = await campaignFor([ok1.id, ok2.id, bad.id, crashed.id], "resilience");
      await db.contact.update({ where: { id: bad.id }, data: { phoneE164: "+97212" } });
      // A worker crashed while handling `crashed` 11 minutes ago.
      await db.campaignRecipient.updateMany({ where: { campaignId: c.id, contactId: crashed.id }, data: { status: "PROCESSING", claimedAt: new Date(Date.now() - 11 * 60_000) } });
      await run(A, () => changeCampaignStatus(c.id, "pause", undefined, A.user.id));
      await run(A, () => processDueCampaigns());
      expect(await db.campaignRecipient.count({ where: { campaignId: c.id, status: "SENT" } })).toBe(0);
      await run(A, () => changeCampaignStatus(c.id, "resume", undefined, A.user.id));
      await run(A, () => processDueCampaigns()); await run(A, () => processDueCampaigns());
      const rs = await db.campaignRecipient.findMany({ where: { campaignId: c.id } });
      const by = (id: string) => rs.find((r) => r.contactId === id)!;
      expect(by(ok1.id).status).toBe("SENT"); expect(by(ok2.id).status).toBe("SENT");
      expect(by(bad.id)).toMatchObject({ status: "SKIPPED", error: "מספר הטלפון של הנמען אינו תקין" });
      expect(by(crashed.id).status).toBe("UNKNOWN"); // never re-sent automatically
      expect(await db.message.count({ where: { campaignRecipient: { campaignId: c.id } } })).toBe(2);
      expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("COMPLETED");
    });
  });
});
