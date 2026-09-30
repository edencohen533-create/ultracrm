/**
 * Broadcasts, lists and contacts (real DB, MOCK WhatsApp provider – nobody real is messaged):
 *  • selection: explicit ids (another business's / changed → refused) and "all filtered results" re-run on the server
 *    across pages, refused when the count changed;
 *  • remove from a static list before sending: future sends skipped only when the list was the contact's only way in;
 *    sends already made stay; a dynamic list can't be edited this way;
 *  • delete: owner only, typed count, a contact in a live call fails (the rest go on), deleted contacts vanish from
 *    lists / counts while their sends stay, and the number stays blocked for a re-imported contact;
 *  • sending settings: a campaign's own window and a business-local schedule; outside its window a marketing campaign
 *    waits (server queue) and an older campaign without a window follows the business window.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { resolveSelection, removeFromList, deleteContacts, deletionImpact } from "@/server/services/contact-bulk";
import { createCampaign, changeCampaignStatus } from "@/server/services/campaign-service";
import { processDueCampaigns } from "@/jobs/campaign-runner";
import { sendBlockReason } from "@/lib/suppression";
import { zonedParts } from "@/lib/business-day";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let manager: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let seq = 0;
const contact = (biz: Biz, extra: Record<string, unknown> = {}) => { seq++; const p = `+97254${String(5000000 + seq * 11 + (Date.now() % 1000)).slice(-7)}`; return db.contact.create({ data: { businessId: biz.business.id, fullName: `נמען ${seq}`, phoneE164: p, phoneRaw: p, consentStatus: "OPTED_IN", source: "qa-bulk", ...extra } }); };
const TZ = "Asia/Jerusalem";

describe("broadcasts: selection, list removal, contact deletion, sending settings", { timeout: 600_000 }, () => {
  let tpl: string; let cred: string;
  beforeAll(async () => {
    A = await createBusiness("bcast-a", { modules: { crm: true, whatsapp: true, messaging: true } });
    B = await createBusiness("bcast-b", { modules: { crm: true, whatsapp: true, messaging: true } });
    accounts.push(A.account.id, B.account.id);
    await db.business.update({ where: { id: A.business.id }, data: { timezone: TZ, settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 0 } } } });
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "מנהלת", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "מנהלת", role: "manager" } });
    manager = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "מנהלת", role: "manager", teamId: null };
    cred = (await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } })).id;
    tpl = (await db.template.create({ data: { businessId: A.business.id, channel: "whatsapp", name: `bc_${Date.now()}`, language: "he", category: "MARKETING", body: "שלום", status: "APPROVED" } })).id;
  }, 300_000);
  afterAll(async () => { for (const b of [A, B]) if (b) { await db.message.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  const campaignFor = async (listIds: string[], name: string, start = true) => {
    const c = await run(A.session, () => createCampaign({ channel: "whatsapp", name, listId: listIds[0], listIds, templateId: tpl, variables: {}, providerCredentialId: cred } as never, A.user.id));
    if (start) await run(A.session, () => changeCampaignStatus(c.id, "start", undefined, A.user.id));
    return c;
  };

  it("selection: ids (foreign → refused) and all filtered results across pages (count re-checked)", async () => {
    const mine = await Promise.all(Array.from({ length: 35 }, () => contact(A)));
    const foreign = await contact(B);
    await expect(run(A.session, () => resolveSelection(A.session, { ids: [mine[0].id, foreign.id] }))).rejects.toMatchObject({ code: "selection_changed" });
    const all = await run(A.session, () => resolveSelection(A.session, { filter: { source: "qa-bulk" } as never, expectedCount: 35 }));
    expect(all.length).toBe(35); // more than one page of 30
    await expect(run(A.session, () => resolveSelection(A.session, { filter: { source: "qa-bulk" } as never, expectedCount: 30 }))).rejects.toMatchObject({ code: "selection_changed" });
    await db.contact.updateMany({ where: { id: { in: mine.map((m) => m.id) } }, data: { source: "qa-bulk-done" } });
  });

  it("remove from a static list before sending: future sends skipped unless reached through another list; sent stays", async () => {
    const [a, b, c] = [await contact(A), await contact(A), await contact(A)];
    const l1 = await db.distributionList.create({ data: { businessId: A.business.id, name: "רשימה 1", members: { create: [a, b, c].map((x) => ({ contactId: x.id })) } } });
    const l2 = await db.distributionList.create({ data: { businessId: A.business.id, name: "רשימה 2", members: { create: [{ contactId: b.id }] } } });
    const camp = await campaignFor([l1.id, l2.id], "לפני שליחה");
    // c was already sent.
    await db.campaignRecipient.updateMany({ where: { campaignId: camp.id, contactId: c.id }, data: { status: "SENT", completedAt: new Date() } });
    const r = await run(manager, () => removeFromList(manager, l1.id, { ids: [a.id, b.id, c.id] }));
    expect(r.removed).toBe(3);
    const rec = async (id: string) => (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: camp.id, contactId: id } })).status;
    expect(await rec(a.id)).toBe("SKIPPED"); // only via list 1
    expect(await rec(b.id)).toBe("QUEUED"); // still via list 2
    expect(await rec(c.id)).toBe("SENT"); // history kept
    const dyn = await db.distributionList.create({ data: { businessId: A.business.id, name: "דינמית", segment: { type: "group", op: "and", children: [] } as never } });
    await expect(run(manager, () => removeFromList(manager, dyn.id, { ids: [a.id] }))).rejects.toMatchObject({ code: "dynamic_list" });
    await db.campaign.update({ where: { id: camp.id }, data: { status: "CANCELLED" } });
  });

  it("delete: owner only, typed count, live call fails, hidden from lists, sends kept, number stays blocked on re-import", async () => {
    const [x, y] = [await contact(A), await contact(A)];
    const l = await db.distributionList.create({ data: { businessId: A.business.id, name: "למחיקה", members: { create: [x, y].map((c) => ({ contactId: c.id })) } } });
    const camp = await campaignFor([l.id], "מחיקה");
    await db.campaignRecipient.updateMany({ where: { campaignId: camp.id, contactId: x.id }, data: { status: "SENT", completedAt: new Date() } });
    await db.suppression.create({ data: { businessId: A.business.id, contactId: x.id, identifier: x.phoneE164, identifierType: "phone", scope: "marketing", source: "manual" } as never });
    // y is in a live call.
    await db.call.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: y.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: y.phoneE164, fromE164: "x", status: "answered" } as never });
    await expect(run(manager, () => deletionImpact(manager, { ids: [x.id] }))).rejects.toMatchObject({ code: "owner_only" });
    const impact = await run(A.session, () => deletionImpact(A.session, { ids: [x.id, y.id] }));
    expect(impact).toMatchObject({ contacts: 2, keptBlocks: 1 });
    expect(impact.history.sends).toBe(1);
    await expect(run(A.session, () => deleteContacts(A.session, { ids: [x.id, y.id], confirm: "1" }))).rejects.toMatchObject({ code: "confirm_required" });
    const r = await run(A.session, () => deleteContacts(A.session, { ids: [x.id, y.id], confirm: "2" }));
    expect(r.deleted).toBe(1);
    expect(r.failed).toEqual([{ id: y.id, reason: expect.stringContaining("בשיחה") }]);
    // Hidden from lists / counts; the row + its send stay for reports.
    expect(await run(A.session, () => db.contact.count({ where: { businessId: A.business.id, id: x.id, deletedAt: null } }))).toBe(0);
    const { prisma } = await import("@/lib/db");
    expect(await run(A.session, () => prisma.contact.count({ where: { id: x.id } }))).toBe(0);
    expect(await db.campaignRecipient.count({ where: { campaignId: camp.id, contactId: x.id, status: "SENT" } })).toBe(1);
    const row = await db.contact.findUniqueOrThrow({ where: { id: x.id } });
    expect(row.fullName).toBe("איש קשר שנמחק"); expect(row.deletedAt).not.toBeNull();
    // The same number imported again as a new contact is still blocked by the suppression (by identifier).
    const again = await db.contact.create({ data: { businessId: A.business.id, fullName: "חדש", phoneE164: x.phoneE164, phoneRaw: x.phoneE164, consentStatus: "OPTED_IN" } });
    expect(await run(A.session, () => sendBlockReason(A.business.id, again.id, "marketing"))).toBeTruthy();
    await db.call.updateMany({ where: { contactId: y.id }, data: { endedAt: new Date() } });
    await db.campaign.update({ where: { id: camp.id }, data: { status: "CANCELLED" } });
  });

  it("sending settings: business-local schedule, the campaign's own window (server queue waits outside it)", async () => {
    const people = [await contact(A), await contact(A)];
    const l = await db.distributionList.create({ data: { businessId: A.business.id, name: "חלון", members: { create: people.map((p) => ({ contactId: p.id })) } } });
    // Window on a day that is not today (business time) → the marketing campaign waits.
    const today = new Date(`${zonedParts(TZ, new Date()).date}T12:00:00Z`).getUTCDay();
    const closed = await campaignFor([l.id], "חלון סגור", false);
    await run(A.session, () => changeCampaignStatus(closed.id, "start", undefined, A.user.id, undefined, undefined, { start: "09:00", end: "10:00", days: [(today + 3) % 7] }));
    await db.campaign.update({ where: { id: closed.id }, data: { status: "RUNNING" } });
    await run(A.session, () => processDueCampaigns());
    expect(await db.campaignRecipient.count({ where: { campaignId: closed.id, status: "QUEUED" } })).toBe(2);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: closed.id } })).sendWindow).toMatchObject({ days: [(today + 3) % 7] });
    // An older campaign without its own window follows the business window (open all day here) → sends.
    const l2 = await db.distributionList.create({ data: { businessId: A.business.id, name: "ישן", members: { create: [{ contactId: (await contact(A)).id }] } } });
    const old = await campaignFor([l2.id], "ללא חלון");
    await run(A.session, () => processDueCampaigns());
    expect(await db.campaignRecipient.count({ where: { campaignId: old.id, status: "SENT" } })).toBe(1);
    // Schedule entered in business time → stored as that instant with the business time zone.
    const l3 = await db.distributionList.create({ data: { businessId: A.business.id, name: "מתוזמן", members: { create: [{ contactId: (await contact(A)).id }] } } });
    const sch = await campaignFor([l3.id], "מתוזמן", false);
    const { zonedDateTime } = await import("@/lib/business-day");
    const tomorrow = new Date(Date.now() + 86400_000); const d = zonedParts(TZ, tomorrow).date;
    const at = zonedDateTime(TZ, d, "10:30")!;
    await run(A.session, () => changeCampaignStatus(sch.id, "start", at.toISOString(), A.user.id, TZ, { batchSize: 50, intervalMinutes: 60 }, { start: "08:00", end: "20:00", days: [0, 1, 2, 3, 4] }));
    const saved = await db.campaign.findUniqueOrThrow({ where: { id: sch.id } });
    expect(saved).toMatchObject({ status: "SCHEDULED", scheduledTimezone: TZ });
    expect(saved.scheduledAt?.toISOString()).toBe(at.toISOString());
    expect(saved.throttle).toMatchObject({ batchSize: 50, intervalMinutes: 60 });
    await expect(run(A.session, () => changeCampaignStatus(sch.id, "unschedule", undefined, A.user.id))).resolves.toBeUndefined();
  });
});
