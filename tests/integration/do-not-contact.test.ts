/**
 * Central do-not-contact (real DB, simulated telephony): an unsubscribe in any channel also stops calls; WhatsApp
 * requests understood by context; queued work cancelled; duplicate cards, re-imports and number formats do not
 * escape; unclear requests pause only automatic outreach; lifting needs a manager + documented consent; two
 * businesses never share a block.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createInboundMessage } from "@/server/services/message-service";
import { callBlockReason, sendBlockReason, reviewSuppression, revokeSuppressions } from "@/lib/suppression";
import { importContacts } from "@/lib/crm/contacts";
import { claimNextLead } from "@/lib/dialer/queue";
import { startCall } from "@/lib/dialer/calls";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
const accounts: string[] = [];
const run = <T,>(biz: Biz, fn: () => Promise<T>) => withBusiness(biz.business.id, fn, biz.session);
let seq = 0;
const phone = () => { seq++; return `+9725${String(20000000 + (Date.now() % 1000000) * 10 + seq).slice(-8)}`; };
const contact = (biz: Biz, phoneE164 = phone(), extra: Record<string, unknown> = {}) => db.contact.create({ data: { businessId: biz.business.id, fullName: `DNC ${++seq}`, phoneE164, phoneRaw: phoneE164, consentStatus: "OPTED_IN", ownerUserId: biz.user.id, ...extra } });
const inbound = (biz: Biz, contactId: string, body: string) => run(biz, () => createInboundMessage({ contactId, body, providerMessageId: `wamid.${crypto.randomUUID()}` }));
const active = (biz: Biz, contactId: string) => run(biz, () => db.suppression.findMany({ where: { businessId: biz.business.id, contactId, revokedAt: null } }));
const callBlock = (biz: Biz, e164: string, opts: { contactId?: string; automated?: boolean } = {}) => run(biz, () => callBlockReason(biz.business.id, e164, undefined, opts));
const sendBlock = (biz: Biz, contactId: string, category: "service" | "marketing", opts: { automated?: boolean } = {}) => run(biz, () => sendBlockReason(biz.business.id, contactId, category, undefined, opts));
const local = (e164: string) => `0${e164.slice(4, 6)}-${e164.slice(6, 9)}-${e164.slice(9)}`; // +972501234567 → 050-123-4567

describe("central do-not-contact", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("dnc-a", { modules: { crm: true, telephony: true, whatsapp: true, sms: true, email: true } });
    B = await createBusiness("dnc-b", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(A.account.id, B.account.id);
    for (const b of [A, B]) await db.phoneNumber.create({ data: { businessId: b.business.id, e164: `+9727${String(Date.now() + seq++).slice(-8)}`, provider: "mock" } });
  }, 600_000);
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("unsubscribe on WhatsApp while work is queued: queued message, campaign recipient, sequence, automation and dial-queue lead are all stopped; calls are blocked", async () => {
    const c = await contact(A);
    const conv = await db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, channel: "whatsapp" } });
    const queuedMsg = await db.message.create({ data: { businessId: A.business.id, conversationId: conv.id, channel: "whatsapp", category: "marketing", direction: "OUTBOUND", type: "TEXT", body: "promo", status: "QUEUED" } });
    const template = await db.template.create({ data: { businessId: A.business.id, name: `t${Date.now()}`, language: "he", category: "MARKETING", body: "שלום", status: "APPROVED" } });
    const dl = await db.distributionList.create({ data: { businessId: A.business.id, name: "promo list" } });
    const campaign = await db.campaign.create({ data: { businessId: A.business.id, name: "promo", listId: dl.id, templateId: template.id, createdById: A.user.id, status: "RUNNING" } });
    const recipient = await db.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: c.id, status: "QUEUED" } });
    const seqDef = await db.marketingSequence.create({ data: { businessId: A.business.id, name: "nurture", trigger: "SENT_NO_REPLY" } });
    const seqRun = await db.sequenceRun.create({ data: { businessId: A.business.id, sequenceId: seqDef.id, contactId: c.id, sourceKey: "test", nextAt: new Date(Date.now() + 3600_000) } });
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "L" } });
    const ll = await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: c.id } });
    const task = await db.task.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: c.id, type: "callback", title: "call back", dueAt: new Date(Date.now() + 3600_000) } });

    await inbound(A, c.id, "תפסיקו לשלוח לי הודעות");

    expect((await db.message.findUniqueOrThrow({ where: { id: queuedMsg.id } })).status).toBe("CANCELLED");
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).status).toBe("SKIPPED");
    expect((await db.sequenceRun.findUniqueOrThrow({ where: { id: seqRun.id } })).status).toBe("STOPPED");
    expect((await db.listLead.findUniqueOrThrow({ where: { id: ll.id } })).status).toBe("dnc");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("cancelled");
    const rows = await active(A, c.id);
    expect(rows[0]).toMatchObject({ kind: "unsubscribe", source: "whatsapp", pendingReview: false });
    expect(rows[0].evidence).toContain("whatsapp:");
    expect(await db.dncEntry.count({ where: { businessId: A.business.id, phoneE164: c.phoneE164 } })).toBe(1);
    expect(await callBlock(A, c.phoneE164)).not.toBeNull();
    expect(await sendBlock(A, c.id, "marketing")).not.toBeNull();
    // Automatic outreach of any category is blocked; a person replying by hand still may.
    expect(await sendBlock(A, c.id, "service", { automated: true })).not.toBeNull();
    expect(await sendBlock(A, c.id, "service")).toBeNull();
    // A manual dial from the system is refused too.
    await expect(run(A, () => startCall(A.session, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id }))).rejects.toMatchObject({ status: 403 });
  });

  it("'don't call me', 'wrong number' and 'not the person' are understood; wrong number blocks everything", async () => {
    const c1 = await contact(A);
    await inbound(A, c1.id, "אל תתקשרו אליי יותר");
    expect((await active(A, c1.id))[0]).toMatchObject({ kind: "do_not_call", pendingReview: false });
    const c2 = await contact(A);
    await inbound(A, c2.id, "זו טעות, אני לא האדם שאתם מחפשים");
    const r = (await active(A, c2.id))[0];
    expect(r).toMatchObject({ kind: "wrong_person", scope: "all" });
    expect(await sendBlock(A, c2.id, "service")).not.toBeNull(); // not even service
    expect(await callBlock(A, c2.phoneE164)).toContain("מספר שגוי");
  });

  it("'טעות' in another context changes nothing; a bare 'זו טעות' pauses automatic outreach only, until a manager decides", async () => {
    const c = await contact(A);
    await inbound(A, c.id, "יש טעות בחשבונית שקיבלתי");
    expect(await active(A, c.id)).toHaveLength(0);
    await inbound(A, c.id, "זו טעות");
    const [row] = await active(A, c.id);
    expect(row).toMatchObject({ kind: "unclear", pendingReview: true });
    expect(await callBlock(A, c.phoneE164, { contactId: c.id, automated: true })).toContain("ממתינה לבירור");
    expect(await callBlock(A, c.phoneE164, { contactId: c.id })).toBeNull(); // manual still possible
    expect(await sendBlock(A, c.id, "marketing")).not.toBeNull();
    expect(await db.dncEntry.count({ where: { businessId: A.business.id, phoneE164: c.phoneE164 } })).toBe(0);
    // The auto-dialer does not pull the lead while it is under review.
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "review" } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: c.id } });
    await db.dialerSession.create({ data: { businessId: A.business.id, userId: A.user.id, listId: list.id, mode: "preview", browserSessionId: "r1", status: "ended" } });
    expect(await run(A, () => claimNextLead(A.business.id, A.user.id, list.id))).toBeNull();
    // Manager confirms → a full do-not-contact incl. the DNC list.
    await run(A, () => reviewSuppression(A.business.id, row.id, "confirm", A.user.id, "אישרתי מול הלקוח"));
    expect(await db.dncEntry.count({ where: { businessId: A.business.id, phoneE164: c.phoneE164 } })).toBe(1);
  });

  it("duplicate card, re-import and other number formats do not escape the block; an additional phone is covered", async () => {
    const e164 = phone();
    const c = await contact(A, e164);
    await inbound(A, c.id, "הסר");
    // A duplicate card of the same person (a new lead with another primary number, the blocked one kept as an
    // additional phone – the primary number itself is unique per business).
    const dup = await contact(A);
    await db.contactPhone.create({ data: { businessId: A.business.id, contactId: dup.id, e164 } });
    expect(await callBlock(A, dup.phoneE164!, { contactId: dup.id })).not.toBeNull();
    await expect(run(A, () => startCall(A.session, { idempotencyKey: crypto.randomUUID(), mode: "manual", phone: local(e164) }))).rejects.toMatchObject({ status: 403 });
    // Re-import of the same person does not lift anything.
    await run(A, () => importContacts(A.session, [{ fullName: "Reimported", phone: local(e164) } as never]));
    expect(await sendBlock(A, c.id, "marketing")).not.toBeNull();
    expect(await callBlock(A, e164)).not.toBeNull();
    // Queue: neither card is pulled by the auto-dialer.
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "dups" } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: dup.id } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: c.id } });
    expect(await run(A, () => claimNextLead(A.business.id, A.user.id, list.id))).toBeNull();
  });

  it("two businesses: a block in one never applies to, or is visible in, the other", async () => {
    const e164 = phone();
    const a = await contact(A, e164);
    const b = await contact(B, e164);
    await inbound(A, a.id, "הסר אותי");
    expect(await callBlock(A, e164)).not.toBeNull();
    expect(await callBlock(B, e164, { contactId: b.id })).toBeNull();
    expect(await sendBlock(B, b.id, "marketing")).toBeNull();
    expect(await run(B, () => db.suppression.count({ where: { businessId: B.business.id } }))).toBe(0);
    expect(await db.dncEntry.count({ where: { businessId: B.business.id } })).toBe(0);
  });

  it("lifting a block needs documented renewed consent; it is audited and clears the DNC list; no automatic expiry", async () => {
    const c = await contact(A);
    await inbound(A, c.id, "stop");
    await expect(run(A, () => revokeSuppressions(A.business.id, c.id, A.user.id, "ok"))).rejects.toMatchObject({ code: "evidence_required" });
    await run(A, () => revokeSuppressions(A.business.id, c.id, A.user.id, "הלקוח ביקש בטלפון לחזור לקבל עדכונים – 29.09"));
    expect(await active(A, c.id)).toHaveLength(0);
    expect(await db.dncEntry.count({ where: { businessId: A.business.id, phoneE164: c.phoneE164 } })).toBe(0);
    expect(await db.auditLog.count({ where: { businessId: A.business.id, action: "contact.resubscribed", entityId: c.id } })).toBe(1);
    // History is kept (revoked, not deleted).
    expect(await run(A, () => db.suppression.count({ where: { businessId: A.business.id, contactId: c.id, revokedAt: { not: null } } }))).toBeGreaterThan(0);
  });
});
