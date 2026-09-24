/**
 * SMS + email marketing on top of the shared CRM – SIMULATED providers (mock_sms / mock_email
 * with signed simulation webhooks, plus a Telnyx credential whose HTTP calls are stubbed).
 * Real isolated database; nothing leaves the process.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

const { createContact, importContacts } = await import("@/lib/crm/contacts");
const { saveChannelCredential } = await import("@/server/services/channel-credential-service");
const { saveChannelTemplate } = await import("@/server/services/channel-template-service");
const { sendChannelMessage, sendChannelTest } = await import("@/server/services/channel-send-service");
const { createCampaign, changeCampaignStatus, campaignReport, campaignPreflight } = await import("@/server/services/campaign-service");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { sendBlockReason, suppressContact, reviewSuppression, revokeSuppressions } = await import("@/lib/suppression");
const { signUnsubscribeToken } = await import("@/lib/unsubscribe-token");
const { processDomainEvents } = await import("@/lib/events");
const { saveSequence, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { MessagePolicyError } = await import("@/server/services/message-service");
const { POST: smsWebhook } = await import("@/app/api/webhooks/sms/[provider]/[credentialId]/route");
const { POST: emailWebhook } = await import("@/app/api/webhooks/email/[provider]/[credentialId]/route");
const { POST: unsubscribeApi } = await import("@/app/api/unsubscribe/route");
const { GET: channelsGet } = await import("@/app/api/channels/[channel]/route");
const { GET: reportGet } = await import("@/app/api/campaigns/[id]/report/route");
const { openConfig } = await import("@/server/channels/registry");
const { MockSmsProvider } = await import("@/server/channels/mock");
const { createOutboundMessage } = await import("@/server/services/message-service");
const { updateContact } = await import("@/lib/crm/contacts");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
const mockSig = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");
async function authed(url: string, user: SessionUser, body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describe("multi-channel marketing (simulated providers)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let sms: { id: string; secret: string };
  let email: { id: string; secret: string };
  let smsTpl: string; let emailTpl: string; let waTpl: string;
  let listId: string;
  const waCredentials: string[] = [];

  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-mc-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-mc-" } } });
    a = await createBusiness("mc-a", { modules: { messaging: true } });
    b = await createBusiness("mc-b", { modules: { messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 24 } } } });
    for (const biz of [a, b]) {
      const s = await run(biz.session, () => saveChannelCredential(biz.session, "sms", { provider: "mock_sms", label: "sim", senders: [{ value: "+972501110000", type: "number", inbound: true }], testRecipients: ["+972509998888"], unitPrice: 0.02, unitPriceCurrency: "USD" }));
      const e = await run(biz.session, () => saveChannelCredential(biz.session, "email", { provider: "mock_email", label: "sim", senderName: "UltraCRM", senderEmail: "news@example.test", testRecipients: ["qa@example.test"] }));
      const sRow = await db.providerCredential.findUniqueOrThrow({ where: { id: s.credential.id } });
      const eRow = await db.providerCredential.findUniqueOrThrow({ where: { id: e.credential.id } });
      if (biz === a) { sms = { id: s.credential.id, secret: openConfig(sRow.config).webhookSecret! }; email = { id: e.credential.id, secret: openConfig(eRow.config).webhookSecret! }; }
    }
    smsTpl = (await run(a.session, () => saveChannelTemplate(a.session, { channel: "sms", name: "מבצע SMS", category: "MARKETING", body: "שלום {{first_name|לקוח}}, מבצע מיוחד ב-{{company|החנות}}!" }))).id;
    emailTpl = (await run(a.session, () => saveChannelTemplate(a.session, { channel: "email", name: "ניוזלטר", category: "MARKETING", subject: "חדש אצלנו, {{first_name|לקוח}}", design: { version: 1, settings: { direction: "rtl", backgroundColor: "#f4f4f7", contentColor: "#ffffff", textColor: "#1f2937", fontFamily: "Arial" }, blocks: [{ type: "heading", text: "שלום {{name}}", level: 1, align: "start" }, { type: "text", text: "תוכן", align: "start" }, { type: "footer", text: "UltraCRM", unsubscribeText: "להסרה" }] } }))).id;
    waTpl = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "wa_promo", language: "he", category: "MARKETING", body: "שלום {{1}}", status: "APPROVED" } })).id;
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } }).then((r) => waCredentials.push(r.id));
    const contacts = await Promise.all([
      run(a.session, () => createContact(a.session, { fullName: "דנה כהן", phone: "0501000001", email: "dana@example.test", consentStatus: "OPTED_IN", consentEvidence: "test" })),
      run(a.session, () => createContact(a.session, { fullName: "יוסי לוי", phone: "0501000002", email: "yossi@example.test", consentStatus: "OPTED_IN", consentEvidence: "test" })),
      run(a.session, () => createContact(a.session, { fullName: "ללא אימייל", phone: "0501000003", consentStatus: "OPTED_IN", consentEvidence: "test" })),
      run(a.session, () => createContact(a.session, { fullName: "ללא הסכמה", phone: "0501000004", email: "noconsent@example.test" })),
    ]);
    listId = (await db.distributionList.create({ data: { businessId: a.business.id, name: "כולם", members: { create: contacts.map((c) => ({ contactId: c.id })) } } })).id;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await destroyBusiness(a.business.id, [a.account.id]);
    await destroyBusiness(b.business.id, [b.account.id]);
  });

  const contact = (phone: string) => db.contact.findFirstOrThrow({ where: { businessId: a.business.id, phoneE164: phone } });
  const unsub = (biz: typeof a, contactId: string, identifier: string, ch: "email" | "sms", m?: string) => unsubscribeApi(new Request("http://localhost/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: signUnsubscribeToken({ b: biz.business.id, c: contactId, i: identifier, ch, m }) }) }));
  const postSms = (body: unknown, secret = sms.secret, id = sms.id) => smsWebhook(new Request(`http://localhost/api/webhooks/sms/mock/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-mock-signature": mockSig(secret, JSON.stringify(body)) }, body: JSON.stringify(body) }), params({ provider: "mock", credentialId: id }));
  const postEmail = (body: unknown, secret = email.secret) => emailWebhook(new Request(`http://localhost/api/webhooks/email/mock/${email.id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-mock-signature": mockSig(secret, JSON.stringify(body)) }, body: JSON.stringify(body) }), params({ provider: "mock", credentialId: email.id }));

  it("connections: saving a key is not 'connected' – the check decides; secrets are masked in the API", async () => {
    const res = await channelsGet(await authed("/api/channels/sms", a.session), params({ channel: "sms" }));
    const items = (await res.json()).data.items;
    expect(items[0].status).toBe("connected");
    expect(JSON.stringify(items)).not.toContain(sms.secret);
    expect(items[0].config.webhookSecretMasked).toMatch(/[•*]/);
    // Business B cannot see A's connection.
    const resB = await channelsGet(await authed("/api/channels/sms", b.session), params({ channel: "sms" }));
    expect((await resB.json()).data.items.map((c: { id: string }) => c.id)).not.toContain(sms.id);
  });

  it("SMS send: Hebrew → UCS-2 segments, unsubscribe footer, marketing gated by consent; email: no address → refused", async () => {
    const dana = await contact("+972501000001");
    const { message } = await run(a.session, () => sendChannelMessage({ channel: "sms", contactId: dana.id, templateId: smsTpl, category: "marketing", requestKey: `t1:${dana.id}`, sentByUserId: a.user.id }));
    expect(message.status).toBe("ACCEPTED");
    expect(message.encoding).toBe("UCS-2");
    expect(message.body).toContain("שלום דנה");
    expect(message.body).toContain("להסרה השיבו הסר");
    expect(message.toIdentifier).toBe("+972501000001");
    // Same requestKey → same message, no second send.
    const again = await run(a.session, () => sendChannelMessage({ channel: "sms", contactId: dana.id, templateId: smsTpl, category: "marketing", requestKey: `t1:${dana.id}`, sentByUserId: a.user.id }));
    expect(again.message.id).toBe(message.id);
    // Frequency cap shared across channels: an email right after the SMS is refused.
    await expect(run(a.session, () => sendChannelMessage({ channel: "email", contactId: dana.id, templateId: emailTpl, category: "marketing", requestKey: `t1e:${dana.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/תדירות/);
    const noEmail = await contact("+972501000003");
    await expect(run(a.session, () => sendChannelMessage({ channel: "email", contactId: noEmail.id, templateId: emailTpl, category: "marketing", requestKey: `t2:${noEmail.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/אימייל/);
    const noConsent = await contact("+972501000004");
    await expect(run(a.session, () => sendChannelMessage({ channel: "sms", contactId: noConsent.id, templateId: smsTpl, category: "marketing", requestKey: `t3:${noConsent.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/מאשר|הסכמה/);
  });

  it("test sends go only to explicitly configured test recipients", async () => {
    await expect(run(a.session, () => sendChannelTest(a.session, { channel: "sms", templateId: smsTpl, to: "+972501000001" }))).rejects.toMatchObject({ code: "test_recipient_not_allowed" });
    const r = await run(a.session, () => sendChannelTest(a.session, { channel: "sms", templateId: smsTpl, to: "+972509998888" }));
    expect(r.simulated).toBe(true);
    expect(await db.message.count({ where: { businessId: a.business.id, toIdentifier: "+972509998888" } })).toBe(0);
  });

  it("email unsubscribe link blocks SMS and WhatsApp too; token of business A cannot touch business B; tampering rejected", async () => {
    const yossi = await contact("+972501000002");
    const res = await unsub(a, yossi.id, "yossi@example.test", "email");
    expect(res.status).toBe(200);
    expect(await run(a.session, () => sendBlockReason(a.business.id, yossi.id, "marketing"))).toMatch(/הוסר/);
    await expect(run(a.session, () => sendChannelMessage({ channel: "sms", contactId: yossi.id, templateId: smsTpl, category: "marketing", requestKey: `u1:${yossi.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/הוסר/);
    const active = await db.suppression.findMany({ where: { businessId: a.business.id, contactId: yossi.id, revokedAt: null } });
    expect(active.map((s) => s.identifier).sort()).toEqual(["+972501000002", "yossi@example.test"]);
    expect(active[0].source).toBe("email");
    // Idempotent
    expect((await unsub(a, yossi.id, "yossi@example.test", "email")).status).toBe(200);
    // A token minted for business A with business B's contact id is refused (contact must belong to the business).
    const bContact = await run(b.session, () => createContact(b.session, { fullName: "B", phone: "0501000002", email: "yossi@example.test", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    expect((await unsub(a, bContact.id, "yossi@example.test", "email")).status).toBe(400);
    expect(await run(b.session, () => sendBlockReason(b.business.id, bContact.id, "marketing"))).toBeNull(); // B untouched
    expect((await unsubscribeApi(new Request("http://localhost/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "not.valid" }) }))).status).toBe(400);
  });

  it("SMS 'הסר' via signed webhook blocks email + WhatsApp; bad signature → 401 and nothing stored; duplicate event applied once", async () => {
    const dana = await contact("+972501000001");
    const body = { eventId: "in-1", providerMessageId: "mock-in-1", inbound: { from: "+972501000001", to: "+972501110000", body: "הסר" } };
    expect((await postSms(body, "wrong-secret")).status).toBe(401);
    expect(await db.suppression.count({ where: { contactId: dana.id, revokedAt: null } })).toBe(0);
    expect((await postSms(body)).status).toBe(200);
    expect((await postSms(body)).status).toBe(200); // retry
    expect(await db.message.count({ where: { inboundKey: "mock_sms:mock-in-1" } })).toBe(1);
    expect(await db.providerWebhookEvent.count({ where: { provider: "mock_sms", eventId: "in-1" } })).toBe(1);
    expect(await run(a.session, () => sendBlockReason(a.business.id, dana.id, "marketing"))).toMatch(/הוסר/);
    await expect(run(a.session, () => sendChannelMessage({ channel: "email", contactId: dana.id, templateId: emailTpl, category: "marketing", requestKey: `u2:${dana.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/הוסר/);
    // WhatsApp path uses the same source of truth.
    const { createOutboundMessage } = await import("@/server/services/message-service");
    const conv = await db.conversation.create({ data: { businessId: a.business.id, contactId: dana.id, providerCredentialId: waCredentials[0], source: "MANUAL" } });
    await expect(run(a.session, () => createOutboundMessage({ conversationId: conv.id, body: "", templateId: waTpl, templateVariables: { "1": "דנה" }, sentByUserId: a.user.id, requireOptIn: true, requestKey: `wa:${dana.id}` }))).rejects.toThrow(/הוסר|אינו מאשר/);
    const sup = await db.suppression.findFirst({ where: { contactId: dana.id, revokedAt: null, source: "sms" } });
    expect(sup?.messageId).not.toBeNull();
  });

  it("unclear SMS reply holds marketing for review; dismissing (documented) releases it, confirming keeps it", async () => {
    const noEmail = await contact("+972501000003");
    expect((await postSms({ eventId: "in-2", providerMessageId: "mock-in-2", inbound: { from: "+972501000003", to: "+972501110000", body: "תפסיקו לשלוח לי" } })).status).toBe(200);
    expect(await run(a.session, () => sendBlockReason(a.business.id, noEmail.id, "marketing"))).toMatch(/ממתינה לבדיקת מנהל/);
    const pending = await db.suppression.findFirstOrThrow({ where: { contactId: noEmail.id, pendingReview: true } });
    expect((await db.contact.findUniqueOrThrow({ where: { id: noEmail.id } })).consentStatus).toBe("OPTED_IN"); // held, not yet opted out
    await expect(run(a.session, () => reviewSuppression(a.business.id, pending.id, "dismiss", a.user.id, ""))).rejects.toThrow(/נימוק/);
    await run(a.session, () => reviewSuppression(a.business.id, pending.id, "dismiss", a.user.id, "הלקוח התלונן על תדירות, לא ביקש הסרה"));
    expect(await run(a.session, () => sendBlockReason(a.business.id, noEmail.id, "marketing"))).toBeNull();
    expect((await postSms({ eventId: "in-3", providerMessageId: "mock-in-3", inbound: { from: "+972501000003", to: "+972501110000", body: "not interested" } })).status).toBe(200);
    const pending2 = await db.suppression.findFirstOrThrow({ where: { contactId: noEmail.id, pendingReview: true, revokedAt: null } });
    await run(a.session, () => reviewSuppression(a.business.id, pending2.id, "confirm", a.user.id, "אושר"));
    expect((await db.contact.findUniqueOrThrow({ where: { id: noEmail.id } })).consentStatus).toBe("OPTED_OUT");
  });

  it("campaign: queued recipient suppressed after queuing is skipped before the provider; worker retry never double-sends; report labels data", async () => {
    // Fresh consenting contacts
    const c1 = await run(a.session, () => createContact(a.session, { fullName: "רון", phone: "0501000011", email: "ron@example.test", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    const c2 = await run(a.session, () => createContact(a.session, { fullName: "מיה", phone: "0501000012", email: "mia@example.test", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    const list = await db.distributionList.create({ data: { businessId: a.business.id, name: "campaign-list", members: { create: [{ contactId: c1.id }, { contactId: c2.id }] } } });
    const campaign = await run(a.session, () => createCampaign({ channel: "sms", name: "SMS מבצע", listId: list.id, templateId: smsTpl, variables: {}, providerCredentialId: sms.id, senderId: "+972501110000" }, a.user.id));
    expect(campaign.channel).toBe("sms");
    expect((campaign.estimate as { known: boolean; total: number | null }).known).toBe(true);
    const pre = await run(a.session, () => campaignPreflight(campaign.id));
    expect(pre.eligible).toBe(2);
    expect(pre.cost?.known).toBe(true);
    expect(pre.cost?.total).toBeCloseTo(0.02 * (pre.cost!.segments ?? 1) * 2, 5);
    await run(a.session, () => changeCampaignStatus(campaign.id, "start", undefined, a.user.id));
    // Unsubscribe c2 while the campaign is scheduled/running (before dispatch).
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c2.id, source: "manual", reason: "test", actorId: a.user.id }));
    await run(a.session, () => processDueCampaigns());
    await run(a.session, () => processDueCampaigns()); // second worker pass = retry safety
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId: campaign.id }, include: { message: true } });
    const r1 = recipients.find((r) => r.contactId === c1.id)!; const r2 = recipients.find((r) => r.contactId === c2.id)!;
    expect(r1.status).toBe("SENT"); expect(r1.message?.status).toBe("ACCEPTED"); expect(r1.identifier).toBe("+972501000011");
    expect(r2.status).toBe("SKIPPED"); expect(r2.messageId).toBeNull();
    expect(await db.message.count({ where: { requestKey: `campaign:${r1.id}` } })).toBe(1);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("COMPLETED");
    // Delivery report via signed simulated webhook, duplicate ignored, out-of-order SENT after DELIVERED ignored.
    const pmid = r1.message!.providerMessageId!;
    expect((await postSms({ eventId: "st-1", providerMessageId: pmid, status: "DELIVERED" })).status).toBe(200);
    expect((await postSms({ eventId: "st-1", providerMessageId: pmid, status: "DELIVERED" })).status).toBe(200);
    expect((await postSms({ eventId: "st-2", providerMessageId: pmid, status: "SENT" })).status).toBe(200);
    expect((await db.message.findUniqueOrThrow({ where: { id: r1.messageId! } })).status).toBe("DELIVERED");
    const report = await run(a.session, () => campaignReport(campaign.id));
    expect(report.delivery.DELIVERED).toBe(1);
    expect(report.availability.delivery).toBe("simulated");
    expect(report.availability.cost).toBe("estimated");
    // Tenant isolation on the report API
    const res = await reportGet(await authed(`/api/campaigns/${campaign.id}/report`, b.session), params({ id: campaign.id }));
    expect(res.status).toBe(404);
  });

  it("re-import never resubscribes; a hard bounce marks the address and the next email send is refused; complaint suppresses", async () => {
    const yossi = await contact("+972501000002");
    await run(a.session, () => importContacts(a.session, [{ fullName: "יוסי לוי", phone: "0501000002", email: "yossi@example.test", consentStatus: "OPTED_IN" }]));
    expect((await db.contact.findUniqueOrThrow({ where: { id: yossi.id } })).consentStatus).toBe("OPTED_OUT");
    expect(await run(a.session, () => sendBlockReason(a.business.id, yossi.id, "marketing"))).toMatch(/הוסר/);
    const ron = await contact("+972501000011");
    await db.contact.update({ where: { id: ron.id }, data: { lastMarketingAt: null } });
    const { message } = await run(a.session, () => sendChannelMessage({ channel: "email", contactId: ron.id, templateId: emailTpl, category: "marketing", requestKey: `e1:${ron.id}`, sentByUserId: a.user.id }));
    expect(message.subject).toBe("חדש אצלנו, רון");
    expect((await postEmail({ eventId: "b-1", providerMessageId: message.providerMessageId, status: "BOUNCED", bounceType: "hard" })).status).toBe(200);
    const after = await db.contact.findUniqueOrThrow({ where: { id: ron.id } });
    expect(after.emailStatus).toBe("hard_bounce");
    expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("BOUNCED");
    await db.contact.update({ where: { id: ron.id }, data: { lastMarketingAt: null } });
    await expect(run(a.session, () => sendChannelMessage({ channel: "email", contactId: ron.id, templateId: emailTpl, category: "marketing", requestKey: `e2:${ron.id}`, sentByUserId: a.user.id }))).rejects.toThrow(/אימייל/);
    // Complaint on another contact → global suppression
    const mia = await contact("+972501000012");
    await run(a.session, () => revokeSuppressions(a.business.id, mia.id, a.user.id, "הלקוחה אישרה מחדש בטלפון"));
    await db.contact.update({ where: { id: mia.id }, data: { lastMarketingAt: null } });
    const m2 = await run(a.session, () => sendChannelMessage({ channel: "email", contactId: mia.id, templateId: emailTpl, category: "marketing", requestKey: `e3:${mia.id}`, sentByUserId: a.user.id }));
    expect((await postEmail({ eventId: "c-1", providerMessageId: m2.message.providerMessageId, status: "COMPLAINED" })).status).toBe(200);
    expect((await postEmail({ eventId: "o-1", providerMessageId: m2.message.providerMessageId, status: "OPENED" })).status).toBe(200);
    expect(await run(a.session, () => sendBlockReason(a.business.id, mia.id, "marketing"))).toMatch(/הוסר/);
    const m2after = await db.message.findUniqueOrThrow({ where: { id: m2.message.id } });
    expect(m2after.openedAt).not.toBeNull();
    expect(m2after.status).not.toBe("READ"); // an open is never "read"
  });

  it("provider unreachable pauses the campaign and requeues instead of failing recipients; suppression still works while the provider is down", async () => {
    const tel = await run(a.session, () => saveChannelCredential(a.session, "sms", { provider: "telnyx_sms", label: "telnyx", apiKey: "KEY", messagingProfileId: "mp-1", publicKey: "x", senders: [{ value: "MyBrand", type: "alphanumeric", inbound: false }] }));
    expect(tel.report.ok).toBe(false); // no network → check fails honestly
    await db.providerCredential.update({ where: { id: tel.credential.id }, data: { sendingBlocked: false, status: "connected", senders: [{ id: "MyBrand", type: "alphanumeric", value: "MyBrand", inbound: false }] } });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input instanceof Request ? input.url : input); if (u.includes("telnyx.com")) return Promise.reject(new TypeError("fetch failed")); return fetch(input, init); });
    const c = await run(a.session, () => createContact(a.session, { fullName: "גל", phone: "0501000021", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    const list = await db.distributionList.create({ data: { businessId: a.business.id, name: "down", members: { create: [{ contactId: c.id }] } } });
    const campaign = await run(a.session, () => createCampaign({ channel: "sms", name: "down", listId: list.id, templateId: smsTpl, variables: {}, providerCredentialId: tel.credential.id, senderId: "MyBrand" }, a.user.id));
    await run(a.session, () => changeCampaignStatus(campaign.id, "start", undefined, a.user.id));
    await run(a.session, () => processDueCampaigns());
    const camp = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(camp.status).toBe("PAUSED");
    expect(camp.statusReason).toMatch(/אינו זמין/);
    const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(rec.status).toBe("QUEUED");
    expect(await db.message.count({ where: { requestKey: `campaign:${rec.id}`, status: "ACCEPTED" } })).toBe(0);
    // Unsubscribe while the provider is down: local block applies immediately.
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c.id, source: "manual", reason: "t", actorId: a.user.id }));
    expect(await run(a.session, () => sendBlockReason(a.business.id, c.id, "marketing"))).toMatch(/הוסר/);
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("SKIPPED");
    vi.unstubAllGlobals();
    // Restore the simulation credential as the active SMS provider.
    await db.providerCredential.update({ where: { id: tel.credential.id }, data: { isActive: false, isDefault: false } });
    await db.providerCredential.update({ where: { id: sms.id }, data: { isActive: true, isDefault: true } });
  });

  it("sequence: WhatsApp delivery failure → wait → SMS, re-checked for suppression; duplicate events start one run", async () => {
    const c = await run(a.session, () => createContact(a.session, { fullName: "נועה", phone: "0501000031", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    const seq = await run(a.session, () => saveSequence(a.session, { name: "fallback", isActive: true, trigger: "DELIVERY_FAILED", triggerConfig: { channel: "whatsapp", marketingOnly: true }, stopOn: ["reply", "conversion", "unsubscribe"], steps: [{ channel: "sms", templateId: smsTpl, waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }] }));
    const conv = await db.conversation.create({ data: { businessId: a.business.id, contactId: c.id, providerCredentialId: waCredentials[0], source: "MANUAL" } });
    const failed = await db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, channel: "whatsapp", category: "marketing", direction: "OUTBOUND", type: "TEMPLATE", status: "FAILED", body: "x" } });
    const { emitEvent } = await import("@/lib/events");
    for (let i = 0; i < 2; i++) await emitEvent(db, { businessId: a.business.id, type: "message.delivery_failed", contactId: c.id, source: "webhook", dedupeKey: `message.delivery_failed:${failed.id}:${i}`, payload: { messageId: failed.id, channel: "whatsapp", category: "marketing" } });
    await processDomainEvents({ businessId: a.business.id, limit: 50 });
    expect(await db.sequenceRun.count({ where: { sequenceId: seq.id, contactId: c.id } })).toBe(1);
    await db.contact.update({ where: { id: c.id }, data: { lastMarketingAt: null } });
    await run(a.session, () => processDueSequenceRuns(Date.now() + 30_000, a.business.id));
    const run1 = await db.sequenceRun.findFirstOrThrow({ where: { sequenceId: seq.id, contactId: c.id } });
    expect(run1.status).toBe("COMPLETED");
    expect(await db.message.count({ where: { requestKey: `seq:${run1.id}:0`, channel: "sms", status: "ACCEPTED" } })).toBe(1);
    // A second contact unsubscribes before the step fires → run stopped, nothing sent.
    const c2 = await run(a.session, () => createContact(a.session, { fullName: "עומר", phone: "0501000032", consentStatus: "OPTED_IN", consentEvidence: "t" }));
    const failed2 = await db.message.create({ data: { businessId: a.business.id, conversationId: (await db.conversation.create({ data: { businessId: a.business.id, contactId: c2.id, providerCredentialId: waCredentials[0], source: "MANUAL" } })).id, channel: "whatsapp", category: "marketing", direction: "OUTBOUND", type: "TEMPLATE", status: "FAILED", body: "x" } });
    await emitEvent(db, { businessId: a.business.id, type: "message.delivery_failed", contactId: c2.id, source: "webhook", dedupeKey: `message.delivery_failed:${failed2.id}`, payload: { messageId: failed2.id, channel: "whatsapp", category: "marketing" } });
    await processDomainEvents({ businessId: a.business.id, limit: 50 });
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c2.id, source: "manual", reason: "t", actorId: a.user.id }));
    await run(a.session, () => processDueSequenceRuns(Date.now() + 30_000, a.business.id));
    const run2 = await db.sequenceRun.findFirstOrThrow({ where: { sequenceId: seq.id, contactId: c2.id } });
    expect(run2.status).toBe("STOPPED");
    expect(await db.message.count({ where: { requestKey: `seq:${run2.id}:0` } })).toBe(0);
  });

  it("templates: missing merge value without default is refused (no send); invalid email rows are rejected on import", async () => {
    await expect(run(a.session, () => saveChannelTemplate(a.session, { channel: "sms", name: "bad", category: "MARKETING", body: "היי {{company}}" }))).rejects.toMatchObject({ code: "template_invalid" });
    await expect(run(a.session, () => saveChannelTemplate(a.session, { channel: "sms", name: "long", category: "MARKETING", body: "ש".repeat(500) }))).rejects.toMatchObject({ code: "template_invalid" });
    const imp = await run(a.session, () => importContacts(a.session, [{ fullName: "רע", phone: "12", email: "x" }, { fullName: "רע2", phone: "0501000099" }]));
    expect(imp.invalid).toBeGreaterThanOrEqual(1);
    expect(imp.errors[0].reason).toMatch(/טלפון/);
    expect(() => MessagePolicyError).toBeDefined();
  });

  describe("regressions found in review", () => {
    it("provider outage → retry sends exactly once and never marks a recipient SENT on a cancelled message", async () => {
      const c = await run(a.session, () => createContact(a.session, { fullName: "רטרי", phone: "0501000041", consentStatus: "OPTED_IN", consentEvidence: "t" }));
      const list = await db.distributionList.create({ data: { businessId: a.business.id, name: "retry", members: { create: [{ contactId: c.id }] } } });
      const campaign = await run(a.session, () => createCampaign({ channel: "sms", name: "retry", listId: list.id, templateId: smsTpl, variables: {}, providerCredentialId: sms.id, senderId: "+972501110000" }, a.user.id));
      await run(a.session, () => changeCampaignStatus(campaign.id, "start", undefined, a.user.id));
      const spy = vi.spyOn(MockSmsProvider.prototype, "send").mockRejectedValueOnce(new TypeError("fetch failed"));
      await run(a.session, () => processDueCampaigns());
      const rec = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(rec.status).toBe("QUEUED");
      expect(rec.messageId).toBeNull();
      expect(await db.message.count({ where: { requestKey: `campaign:${rec.id}` } })).toBe(0); // nothing left behind
      expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).lastMarketingAt).toBeNull(); // cap slot released
      // Provider back: resume → sends once, recipient SENT on an ACCEPTED message.
      await run(a.session, () => changeCampaignStatus(campaign.id, "resume", undefined, a.user.id));
      await run(a.session, () => processDueCampaigns());
      await run(a.session, () => processDueCampaigns());
      const after = await db.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id }, include: { message: true } });
      expect(after.status).toBe("SENT");
      expect(after.message?.status).toBe("ACCEPTED");
      expect(await db.message.count({ where: { requestKey: `campaign:${rec.id}` } })).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it("a 'sent, no reply' sequence never re-triggers itself from its own step", async () => {
      const c = await run(a.session, () => createContact(a.session, { fullName: "לולאה", phone: "0501000042", consentStatus: "OPTED_IN", consentEvidence: "t" }));
      const seq = await run(a.session, () => saveSequence(a.session, { name: "follow-up", isActive: true, trigger: "SENT_NO_REPLY", triggerConfig: { channel: "sms", marketingOnly: true }, stopOn: ["unsubscribe"], steps: [{ channel: "sms", templateId: smsTpl, waitMinutes: 30, variables: {}, condition: { requireNoReply: true } }] }));
      const first = await run(a.session, () => sendChannelMessage({ channel: "sms", contactId: c.id, templateId: smsTpl, category: "marketing", requestKey: `loop:${c.id}`, sentByUserId: a.user.id }));
      // The send kicks event processing in the background; poll until the handler has run.
      const runs = async () => db.sequenceRun.count({ where: { sequenceId: seq.id, contactId: c.id } });
      for (let i = 0; i < 40 && (await runs()) === 0; i++) { await processDomainEvents({ businessId: a.business.id, limit: 50 }); await new Promise((r) => setTimeout(r, 250)); }
      expect(await runs()).toBe(1);
      // Fast-forward the run and lift the frequency cap so the step actually sends.
      await db.sequenceRun.updateMany({ where: { sequenceId: seq.id, contactId: c.id }, data: { nextAt: new Date(Date.now() - 1000) } });
      await db.contact.update({ where: { id: c.id }, data: { lastMarketingAt: null } });
      await run(a.session, () => processDueSequenceRuns(Date.now() + 30_000, a.business.id));
      const stepMsg = await db.message.findFirst({ where: { conversation: { contactId: c.id }, requestKey: { startsWith: "seq:" } } });
      expect(stepMsg?.status).toBe("ACCEPTED");
      await processDomainEvents({ businessId: a.business.id, limit: 50 });
      await new Promise((r) => setTimeout(r, 1500));
      await processDomainEvents({ businessId: a.business.id, limit: 50 });
      expect(await runs()).toBe(1); // no second run from the step's own message.sent
      expect(first.message.id).not.toBe(stepMsg?.id);
    });

    it("free-text reply on an SMS conversation from the inbox goes out as a service SMS (no template, no marketing gate)", async () => {
      // Inbound SMS from a brand-new number creates the contact + SMS conversation.
      expect((await postSms({ eventId: "in-reply-1", providerMessageId: "mock-in-reply-1", inbound: { from: "+972501000043", to: "+972501110000", body: "יש לכם מלאי?" } })).status).toBe(200);
      const conv = await db.conversation.findFirstOrThrow({ where: { businessId: a.business.id, channel: "sms", contact: { phoneE164: "+972501000043" } } });
      const { message } = await run(a.session, () => createOutboundMessage({ conversationId: conv.id, body: "כן, מוזמנים להגיע היום", sentByUserId: a.user.id, requestKey: `reply:${conv.id}:1` }));
      expect(message.channel).toBe("sms");
      expect(message.category).toBe("service");
      expect(message.status).toBe("ACCEPTED");
      expect(message.body).not.toContain("להסרה");
      // Idempotent
      const again = await run(a.session, () => createOutboundMessage({ conversationId: conv.id, body: "כן, מוזמנים להגיע היום", sentByUserId: a.user.id, requestKey: `reply:${conv.id}:1` }));
      expect(again.message.id).toBe(message.id);
      // A "do not contact" suppression blocks even service replies.
      const contactRow = await db.contact.findFirstOrThrow({ where: { businessId: a.business.id, phoneE164: "+972501000043" } });
      await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: contactRow.id, scope: "all", source: "manual", reason: "t", actorId: a.user.id }));
      await expect(run(a.session, () => createOutboundMessage({ conversationId: conv.id, body: "עוד", sentByUserId: a.user.id, requestKey: `reply:${conv.id}:2` }))).rejects.toThrow(MessagePolicyError);
    });

    it("changing a contact's email clears a previous hard-bounce mark", async () => {
      const c = await run(a.session, () => createContact(a.session, { fullName: "בואנס", phone: "0501000044", email: "old@example.test", consentStatus: "OPTED_IN", consentEvidence: "t" }));
      await db.contact.update({ where: { id: c.id }, data: { emailStatus: "hard_bounce", emailBouncedAt: new Date() } });
      await run(a.session, () => updateContact(a.session, c.id, { email: "new@example.test" }));
      const after = await db.contact.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.email).toBe("new@example.test");
      expect(after.emailStatus).toBeNull();
      await run(a.session, () => updateContact(a.session, c.id, { company: "x" }));
      expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).emailStatus).toBeNull();
    });

    it("audience filters by CRM owner and lead status resolve to the right contacts", async () => {
      const { previewAudience } = await import("@/server/services/audience-service");
      const owned = await run(a.session, () => createContact(a.session, { fullName: "בעלים", phone: "0501000045", consentStatus: "OPTED_IN", consentEvidence: "t", ownerUserId: a.user.id }));
      await db.lead.create({ data: { businessId: a.business.id, contactId: owned.id, status: "qualified" } });
      const byOwner = await run(a.session, () => previewAudience({ segment: { field: "owner", operator: "is", value: a.user.id } }));
      expect(byOwner.matched).toBeGreaterThanOrEqual(1);
      const byStage = await run(a.session, () => previewAudience({ segment: { operator: "AND", conditions: [{ field: "leadStatus", operator: "is", value: "qualified" }, { field: "owner", operator: "is", value: a.user.id }] } }));
      expect(byStage.matched).toBe(1);
      // Contacts created by the owner are auto-owned; exactly one of them has a lead.
      const noLead = await run(a.session, () => previewAudience({ segment: { operator: "AND", conditions: [{ field: "leadStatus", operator: "is", value: "none" }, { field: "owner", operator: "is", value: a.user.id }] } }));
      expect(noLead.matched).toBe(byOwner.matched - 1);
      const notOwned = await run(a.session, () => previewAudience({ segment: { field: "owner", operator: "is_not", value: a.user.id } }));
      expect(notOwned.matched + byOwner.matched).toBe(await db.contact.count({ where: { businessId: a.business.id } }));
    });
  });
});
