/**
 * WhatsApp completion phase – simulated provider (mock WhatsApp), real isolated DB.
 * Send safety: retry/backoff, UNKNOWN never auto-retried, controlled manual retry, rate-limit pause,
 * status ledger + failure reasons, test-send allowlist, template structure checks, contact merge,
 * sequence triggers/conditions/task steps, retention job.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.CRON_SECRET ||= "test-cron-secret";

const { createContact, mergeContacts } = await import("@/lib/crm/contacts");
const { createCampaign, changeCampaignStatus, retryRecipient, sendCampaignTest, campaignPreflight } = await import("@/server/services/campaign-service");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { MockWhatsAppProvider } = await import("@/server/providers/mock-whatsapp-provider");
const { updateProviderMessageStatus } = await import("@/server/services/message-status-service");
const { saveSequence, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { processDomainEvents } = await import("@/lib/events");
const { suppressContact } = await import("@/lib/suppression");
const { GET: retentionJob } = await import("@/app/api/jobs/retention/route");
const { POST: mergeRoute } = await import("@/app/api/contacts/[id]/merge/route");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
async function authed(url: string, user: SessionUser, body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}

describe("WhatsApp completion (simulated Meta)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let waCred: string; let tpl: string; let mediaTpl: string; let listId: string;
  const contacts: string[] = [];

  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-wc-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-wc-" } } });
    a = await createBusiness("wc-a", { modules: { messaging: true } });
    b = await createBusiness("wc-b", { modules: { messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 24 }, retention: { messagesDays: 30, auditDays: 0 } } } });
    waCred = (await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {}, testRecipients: ["+972509998888"] } })).id;
    tpl = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "wc_promo", language: "he", category: "MARKETING", body: "שלום {{1}}, {{2}}", status: "APPROVED" } })).id;
    mediaTpl = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "wc_media", language: "he", category: "MARKETING", body: "היי {{1}}", status: "APPROVED", headerFormat: "IMAGE", buttons: [{ type: "URL", text: "לאתר", url: "https://example.com/{{1}}", dynamic: true }] } })).id;
    for (const [i, name] of ["רון לוי", "מיה כהן", "גל שמש"].entries()) contacts.push((await run(a.session, () => createContact(a.session, { fullName: name, phone: `05010007${String(i).padStart(2, "0")}`, email: `wc${i}@example.test`, consentStatus: "OPTED_IN", consentEvidence: "t", customFields: { plan: "Pro" } }))).id);
    listId = (await db.distributionList.create({ data: { businessId: a.business.id, name: "wc-list", members: { create: contacts.map((contactId) => ({ contactId })) } } })).id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("4.06/5.05: media-header and dynamic-button templates require the media link / button values at draft time", async () => {
    await expect(run(a.session, () => createCampaign({ channel: "whatsapp", name: "m", listId, templateId: mediaTpl, variables: { "1": "{name}" }, providerCredentialId: waCred }, a.user.id))).rejects.toThrow(/תמונה/);
    await expect(run(a.session, () => createCampaign({ channel: "whatsapp", name: "m", listId, templateId: mediaTpl, variables: { "1": "{name}" }, providerCredentialId: waCred, mediaUrl: "https://cdn.example.com/a.jpg" }, a.user.id))).rejects.toThrow(/כפתור/);
    const c = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "m", listId, templateId: mediaTpl, variables: { "1": "{{first_name|לקוח}}" }, providerCredentialId: waCred, mediaUrl: "https://cdn.example.com/a.jpg", buttonParams: { "0": "promo" } }, a.user.id));
    expect(c.mediaUrl).toBe("https://cdn.example.com/a.jpg");
    const pre = await run(a.session, () => campaignPreflight(c.id));
    expect(pre.blockers).toEqual([]);
    expect(pre.samples[0].body).toMatch(/היי (רון|מיה|גל)/);
    await run(a.session, () => changeCampaignStatus(c.id, "cancel", undefined, a.user.id));
  });

  it("4.04: a template paused by Meta blocks start; 4.09: a variable without value or default excludes the recipient with a reason", async () => {
    await db.template.update({ where: { id: tpl }, data: { status: "PAUSED" } });
    const c = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "p", listId, templateId: tpl, variables: { "1": "{name}", "2": "x" }, providerCredentialId: waCred }, a.user.id)).catch((e) => e);
    expect(c).toBeInstanceOf(Error); // not APPROVED
    await db.template.update({ where: { id: tpl }, data: { status: "APPROVED" } });
    const c2 = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "v", listId, templateId: tpl, variables: { "1": "{name}", "2": "{{company}}" }, providerCredentialId: waCred }, a.user.id));
    const pre = await run(a.session, () => campaignPreflight(c2.id));
    expect(pre.eligible).toBe(0);
    expect(pre.exclusions["משתנים חסרים"]).toBe(3);
    await run(a.session, () => changeCampaignStatus(c2.id, "cancel", undefined, a.user.id));
  });

  it("5.07: WhatsApp test send goes only to the connection allowlist (simulated provider)", async () => {
    const c = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "t", listId, templateId: tpl, variables: { "1": "{name}", "2": "{{custom.plan|Free}}" }, providerCredentialId: waCred }, a.user.id));
    await expect(run(a.session, () => sendCampaignTest(a.session, c.id, "0501000700"))).rejects.toMatchObject({ code: "test_recipient_not_allowed" });
    const r = await run(a.session, () => sendCampaignTest(a.session, c.id, "0509998888"));
    expect(r.simulated).toBe(true);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).lastTestAt).not.toBeNull();
    expect(await db.message.count({ where: { businessId: a.business.id, conversation: { contact: { phoneE164: "+972509998888" } } } })).toBe(0);
    await run(a.session, () => changeCampaignStatus(c.id, "cancel", undefined, a.user.id));
  });

  it("6.07/6.09/1.09/7.11: transient failure → backoff retry with a new requestKey; rate limit pauses the run; UNKNOWN is never auto-retried; manual retry is controlled", async () => {
    const c = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "r", listId, templateId: tpl, variables: { "1": "{name}", "2": "{{custom.plan|Free}}" }, providerCredentialId: waCred }, a.user.id));
    await run(a.session, () => changeCampaignStatus(c.id, "start", undefined, a.user.id));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).preflightSnapshot).toMatchObject({ eligible: 3 });
    // First recipient: rate limited (retryable); the run stops for this campaign.
    const spy = vi.spyOn(MockWhatsAppProvider.prototype, "sendTemplate");
    spy.mockResolvedValueOnce({ providerMessageId: "", status: "FAILED", error: "מגבלת קצב", errorCode: "130429", retryable: true });
    await run(a.session, () => processDueCampaigns());
    const recs1 = await db.campaignRecipient.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" } });
    const retried = recs1.find((r) => r.attempts === 1 && r.status === "QUEUED");
    expect(retried).toBeTruthy();
    expect(retried!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(recs1.filter((r) => r.status === "SENT").length).toBe(0); // rate limit → rest of this campaign waited
    // Backoff respected: not due yet → nothing happens.
    await run(a.session, () => processDueCampaigns());
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: retried!.id } })).status).toBe("QUEUED");
    // Due now: second attempt succeeds with its own requestKey; the others send normally.
    await db.campaignRecipient.update({ where: { id: retried!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await run(a.session, () => processDueCampaigns());
    const after = await db.campaignRecipient.findUniqueOrThrow({ where: { id: retried!.id }, include: { message: true } });
    expect(after.status).toBe("SENT"); expect(after.attempts).toBe(2); expect(["ACCEPTED", "SENT"]).toContain(after.message?.status);
    expect(await db.message.count({ where: { requestKey: { in: [`campaign:${retried!.id}`, `campaign:${retried!.id}:a1`] } } })).toBe(2);
    expect(await db.message.count({ where: { requestKey: `campaign:${retried!.id}`, status: "FAILED", retryable: true, errorCode: "130429" } })).toBe(1);
    // Permanent failure → FAILED, no auto retry.
    const oneList = await db.distributionList.create({ data: { businessId: a.business.id, name: "one", members: { create: [{ contactId: contacts[0] }] } } });
    const c2 = await run(a.session, () => createCampaign({ channel: "whatsapp", name: "perm", listId: oneList.id, templateId: tpl, variables: { "1": "{name}", "2": "x" }, providerCredentialId: waCred }, a.user.id));
    await db.contact.update({ where: { id: contacts[0] }, data: { lastMarketingAt: null } });
    await run(a.session, () => changeCampaignStatus(c2.id, "start", undefined, a.user.id));
    spy.mockResolvedValueOnce({ providerMessageId: "", status: "FAILED", error: "לא ניתן למסור", errorCode: "131026", retryable: false });
    await run(a.session, () => processDueCampaigns());
    const perm = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: c2.id } });
    expect(perm.status).toBe("FAILED"); expect(perm.attempts).toBe(1);
    // UNKNOWN (timeout) → never automatic; manual retry requires attestation.
    await db.campaignRecipient.update({ where: { id: perm.id }, data: { status: "UNKNOWN" } });
    await run(a.session, () => processDueCampaigns());
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: perm.id } })).status).toBe("UNKNOWN");
    await expect(run(a.session, () => retryRecipient(c2.id, perm.id, false, a.user.id))).rejects.toThrow(/לוודא/);
    await db.contact.update({ where: { id: contacts[0] }, data: { lastMarketingAt: null } });
    await run(a.session, () => retryRecipient(c2.id, perm.id, true, a.user.id));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe("RUNNING");
    await run(a.session, () => processDueCampaigns());
    const manual = await db.campaignRecipient.findUniqueOrThrow({ where: { id: perm.id }, include: { message: true } });
    expect(manual.status).toBe("SENT"); expect(["ACCEPTED", "SENT"]).toContain(manual.message?.status);
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "campaign.recipient_retry" } })).toBe(1);
    spy.mockRestore();
  }, 400_000);

  it("7.07: provider status with a failure reason updates the message and emits delivery_failed; late/duplicate statuses do not regress", async () => {
    const conv = (await db.conversation.findFirst({ where: { businessId: a.business.id } })) ?? (await db.conversation.create({ data: { businessId: a.business.id, contactId: contacts[0], channel: "whatsapp" } }));
    const mk = (pid: string) => db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, channel: "whatsapp", direction: "OUTBOUND", type: "TEMPLATE", body: "x", status: "ACCEPTED", providerMessageId: pid, providerCredentialId: waCred } });
    const sent = await mk(`wamid.wc-ok-${Date.now()}`);
    await run(a.session, () => updateProviderMessageStatus(sent.providerMessageId!, "DELIVERED", new Date(), waCred));
    await run(a.session, () => updateProviderMessageStatus(sent.providerMessageId!, "SENT", new Date(), waCred)); // late
    expect((await db.message.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("DELIVERED");
    await run(a.session, () => updateProviderMessageStatus(sent.providerMessageId!, "FAILED", new Date(), waCred, { reason: "x", code: "131026" })); // failed after delivered → ignored
    expect((await db.message.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("DELIVERED");
    const other = await mk(`wamid.wc-fail-${Date.now()}`);
    await run(a.session, () => updateProviderMessageStatus(other.providerMessageId!, "FAILED", new Date(), waCred, { reason: "לא ניתן למסור למספר זה", code: "131026" }));
    const failed = await db.message.findUniqueOrThrow({ where: { id: other.id } });
    expect(failed.status).toBe("FAILED"); expect(failed.errorCode).toBe("131026"); expect(failed.errorReason).toMatch(/למסור/);
    expect(await db.domainEvent.count({ where: { businessId: a.business.id, type: "message.delivery_failed", dedupeKey: `message.delivery_failed:${other.id}` } })).toBe(1);
  });

  it("2.04/9.08: merging keeps conversations, campaigns, tasks, identifiers, tags and the more restrictive consent; other tenants cannot merge", async () => {
    const keep = contacts[1]; const dup = contacts[2];
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: dup, source: "manual", reason: "t", actorId: a.user.id }));
    await db.task.create({ data: { businessId: a.business.id, userId: a.user.id, createdById: a.user.id, contactId: dup, type: "follow_up", title: "t", dueAt: new Date() } });
    const tag = await db.tag.create({ data: { businessId: a.business.id, name: `wc-${Date.now()}` } });
    await db.contactTag.create({ data: { contactId: dup, tagId: tag.id } });
    const dupPhone = (await db.contact.findUniqueOrThrow({ where: { id: dup } })).phoneE164;
    const convBefore = await db.conversation.count({ where: { contactId: dup } });
    const cross = await mergeRoute(await authed(`/api/contacts/${keep}/merge`, b.session, { duplicateId: dup }), { params: Promise.resolve({ id: keep }) });
    expect(cross.status).toBe(404);
    const merged = await run(a.session, () => mergeContacts(a.session, keep, dup));
    expect(merged.id).toBe(keep);
    expect(await db.contact.count({ where: { id: dup } })).toBe(0);
    expect(await db.contactPhone.count({ where: { contactId: keep, e164: dupPhone } })).toBe(1);
    expect(await db.conversation.count({ where: { contactId: keep } })).toBeGreaterThanOrEqual(convBefore);
    expect(await db.task.count({ where: { contactId: keep } })).toBeGreaterThanOrEqual(1);
    expect(await db.contactTag.count({ where: { contactId: keep, tagId: tag.id } })).toBe(1);
    expect(merged.consentStatus).toBe("OPTED_OUT"); // opt-out survives the merge
    expect(await db.suppression.count({ where: { contactId: keep, identifier: dupPhone, revokedAt: null } })).toBe(1);
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "contact.merged", entityId: keep } })).toBe(1);
    await expect(run(a.session, () => mergeContacts(a.session, keep, keep))).rejects.toMatchObject({ code: "same_contact" });
  });

  it("10.01/10.05/10.08: CONTACT_CREATED starts a sequence; a task step creates a task; data conditions skip steps", async () => {
    const seq = await run(a.session, () => saveSequence(a.session, { name: "onboard", isActive: true, trigger: "CONTACT_CREATED", triggerConfig: { marketingOnly: true }, stopOn: ["unsubscribe"], steps: [
      { action: "task", channel: "sms", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, taskTitle: "להתקשר לליד", taskDueHours: 4 },
      { action: "task", channel: "sms", waitMinutes: 0, variables: {}, condition: { requireNoReply: false, tagName: "vip" }, taskTitle: "טיפול VIP", taskDueHours: 1 },
    ] }));
    const c = await run(a.session, () => createContact(a.session, { fullName: "לידה חדשה", phone: "0501000799", consentStatus: "UNKNOWN", ownerUserId: a.user.id }));
    await processDomainEvents({ businessId: a.business.id, limit: 50 });
    const runRow = await db.sequenceRun.findFirstOrThrow({ where: { sequenceId: seq.id, contactId: c.id } });
    await run(a.session, () => processDueSequenceRuns(Date.now() + 30_000, a.business.id));
    await db.sequenceRun.updateMany({ where: { id: runRow.id, status: "PENDING" }, data: { nextAt: new Date(Date.now() - 1000) } });
    await run(a.session, () => processDueSequenceRuns(Date.now() + 30_000, a.business.id));
    const done = await db.sequenceRun.findUniqueOrThrow({ where: { id: runRow.id } });
    expect(done.status).toBe("COMPLETED");
    const log = done.log as Array<{ step: number; skipped: string | null }>;
    expect(log[0].skipped).toBeNull();
    expect(log[1].skipped).toMatch(/tag vip/);
    expect(await db.task.count({ where: { contactId: c.id, title: { contains: "להתקשר לליד" } } })).toBe(1);
  });

  it("12.12: retention job purges old message bodies/attachments per business policy and keeps rows and audit", async () => {
    const conv = (await db.conversation.findFirst({ where: { businessId: a.business.id } })) ?? (await db.conversation.create({ data: { businessId: a.business.id, contactId: contacts[0], channel: "whatsapp" } }));
    const old = await db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, channel: "whatsapp", direction: "INBOUND", type: "TEXT", body: "ישן מאוד", status: "SENT", createdAt: new Date(Date.now() - 40 * 86400_000) } });
    const fresh = await db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, channel: "whatsapp", direction: "INBOUND", type: "TEXT", body: "טרי", status: "SENT" } });
    const res = await retentionJob(new NextRequest("http://localhost/api/jobs/retention", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    expect((await db.message.findUniqueOrThrow({ where: { id: old.id } })).body).toBeNull();
    expect((await db.message.findUniqueOrThrow({ where: { id: fresh.id } })).body).toBe("טרי");
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "automation.messages_purged" } })).toBe(1);
    const unauth = await retentionJob(new NextRequest("http://localhost/api/jobs/retention"));
    expect(unauth.status).toBe(401);
  });
});
