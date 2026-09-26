/**
 * Campaign builder end to end on the real DB with SIMULATED providers (mock_email / mock_sms):
 * draft → autosave per step → multi-audience union without duplicates → per-channel eligibility preview →
 * build (frozen audience, working-template copy, source template untouched) → test send to an allow-listed
 * recipient → start → report; unschedule / delete-draft / legacy draft opening; tenant isolation.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

const { createContact } = await import("@/lib/crm/contacts");
const { saveChannelCredential } = await import("@/server/services/channel-credential-service");
const { saveChannelTemplate, listChannelTemplates } = await import("@/server/services/channel-template-service");
const { createDraft, updateDraft, getDraft, buildDraft, testDraft, deleteDraft, draftChecks, draftFromCampaign, listDrafts } = await import("@/server/services/campaign-draft-service");
const { campaignPreflight, changeCampaignStatus, campaignReport, createCampaign, deleteDraftCampaign } = await import("@/server/services/campaign-service");
const { previewAudience, listAudienceCounts } = await import("@/server/services/audience-service");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { defaultEmailDesign } = await import("@/lib/email/blocks");
const { EMAIL_STARTERS } = await import("@/lib/email/starters");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);

describe("campaign builder (simulated providers, real DB)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let emailCred: string; let smsCred: string; let listA: string; let listB: string; let listNoise: string; let sourceTpl: string;
  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-wz-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    a = await createBusiness("wz-a", { modules: { messaging: true } });
    b = await createBusiness("wz-b", { modules: { messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 24 } } } });
    emailCred = (await run(a.session, () => saveChannelCredential(a.session, "email", { provider: "mock_email", label: "sim", senderName: "סולינה", senderEmail: "news@example.test", testRecipients: ["qa@example.test"] }))).credential.id;
    smsCred = (await run(a.session, () => saveChannelCredential(a.session, "sms", { provider: "mock_sms", label: "sim", senders: [{ value: "+972501110000", type: "number", inbound: true }], testRecipients: ["+972509998888"] }))).credential.id;
    const mk = (n: string, phone: string, email: string | undefined, opted = true) => run(a.session, () => createContact(a.session, { fullName: n, phone, email, ...(opted ? { consentStatus: "OPTED_IN", consentEvidence: "t" } : {}) }));
    const [c1, c2, c3, c4, c5] = [await mk("דנה", "0502000001", "dana@example.test"), await mk("יוסי", "0502000002", "yossi@example.test"), await mk("בלי מייל", "0502000003", undefined), await mk("בלי הסכמה", "0502000004", "no@example.test", false), await mk("רעש", "0502000005", "noise@example.test")];
    listA = (await db.distributionList.create({ data: { businessId: a.business.id, name: "לקוחות", members: { create: [c1, c2, c3].map((c) => ({ contactId: c.id })) } } })).id;
    listB = (await db.distributionList.create({ data: { businessId: a.business.id, name: "מתעניינים", members: { create: [c2, c4].map((c) => ({ contactId: c.id })) } } })).id; // c2 in both lists
    listNoise = (await db.distributionList.create({ data: { businessId: a.business.id, name: "להחריג", members: { create: [c5, c1].map((c) => ({ contactId: c.id })) } } })).id;
    sourceTpl = (await run(a.session, () => saveChannelTemplate(a.session, { channel: "email", name: "תבנית מקור", category: "MARKETING", subject: "מקור", design: defaultEmailDesign() }))).id;
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("audience picker: counts per list; union counts a shared contact once; exclusion removes; email eligibility needs consent + address", async () => {
    const counts = await run(a.session, () => listAudienceCounts());
    expect(counts.find((l) => l.id === listA)?.count).toBe(3);
    const p = await run(a.session, () => previewAudience({ listIds: [listA, listB], channel: "email" }));
    expect(p.remaining).toBe(4); // dana, yossi, no-email, no-consent (yossi once)
    expect(p.eligible).toBe(2); // dana + yossi (no-email fails the channel, no-consent fails marketing)
    const ex = await run(a.session, () => previewAudience({ listIds: [listA, listB], excludedListIds: [listNoise], channel: "email" }));
    expect(ex.eligible).toBe(1); // dana excluded
    const sms = await run(a.session, () => previewAudience({ listIds: [listA, listB], channel: "sms" }));
    expect(sms.eligible).toBe(3); // dana, yossi, no-email (phone ok)
  });

  it("email draft: autosave, lazy validation per step, template copy leaves the source untouched, build + preflight + test + send + report", async () => {
    const d0 = await run(a.session, () => createDraft("email", a.user.id));
    expect(d0.steps).toEqual(["info", "audience", "template", "content", "review"]);
    expect(draftChecks(d0).map((p) => p.step)).toEqual(expect.arrayContaining(["info", "audience"]));
    await run(a.session, () => updateDraft(d0.id, { name: "מבצע סתיו", step: "audience", data: { subject: "שלום {{first_name|לקוח}}", preheader: "רק השבוע", senderCredentialId: emailCred } }));
    await run(a.session, () => updateDraft(d0.id, { data: { listIds: [listA, listB], excludedListIds: [] } }));
    const starter = EMAIL_STARTERS.find((s) => s.key === "promo")!;
    await run(a.session, () => updateDraft(d0.id, { step: "content", data: { design: starter.design, designSource: "starter:promo" } }));
    const reopened = await run(a.session, () => getDraft(d0.id));
    expect(reopened).toMatchObject({ name: "מבצע סתיו", step: "content" });
    expect(reopened.data.listIds).toEqual([listA, listB]);
    expect(draftChecks(reopened)).toEqual([]);
    // copy semantics: pick "my template", edit in the campaign, source stays the same
    const src = await db.template.findUniqueOrThrow({ where: { id: sourceTpl } });
    await run(a.session, () => updateDraft(d0.id, { data: { design: { ...(src.design as object), blocks: [{ type: "heading", text: "נערך בקמפיין", level: 1, align: "start" }, { type: "footer", text: "", unsubscribeText: "הסרה" }] }, designSource: sourceTpl } }));
    expect((await db.template.findUniqueOrThrow({ where: { id: sourceTpl } })).html).toBe(src.html);
    // test send only to the allow-listed recipient
    await expect(run(a.session, () => testDraft(d0.id, a.session, "stranger@example.test"))).rejects.toThrow(/נמעני בדיקה/);
    const t = await run(a.session, () => testDraft(d0.id, a.session, "qa@example.test"));
    expect(t.simulated).toBe(true);
    // working template is internal (hidden from the gallery)
    const gallery = await run(a.session, () => listChannelTemplates("email"));
    expect(gallery.map((g) => g.id)).toContain(sourceTpl);
    expect(gallery.some((g) => g.name.startsWith("[קמפיין]"))).toBe(false);
    // build: frozen audience = union without duplicates (4 recipients), preflight eligible = 2
    const { campaignId } = await run(a.session, () => buildDraft(d0.id, a.user.id));
    const recips = await db.campaignRecipient.findMany({ where: { campaignId } });
    expect(recips).toHaveLength(4);
    const pf = await run(a.session, () => campaignPreflight(campaignId));
    expect(pf.eligible).toBe(2);
    expect(pf.blockers).toEqual([]);
    expect(pf.samples[0].subject).toMatch(/^שלום /);
    // rebuild replaces the previous DRAFT campaign (no duplicates)
    const again = await run(a.session, () => buildDraft(d0.id, a.user.id));
    expect(again.campaignId).not.toBe(campaignId);
    expect(await db.campaign.count({ where: { id: campaignId } })).toBe(0);
    expect((await run(a.session, () => listDrafts("email"))).some((d) => d.id === d0.id)).toBe(false); // built drafts appear as campaigns
    // send (simulated) + double click protection + report
    await run(a.session, () => changeCampaignStatus(again.campaignId, "start", undefined, a.user.id));
    await expect(run(a.session, () => changeCampaignStatus(again.campaignId, "start", undefined, a.user.id))).rejects.toThrow();
    for (let i = 0; i < 3; i++) await run(a.session, () => processDueCampaigns());
    const report = await run(a.session, () => campaignReport(again.campaignId));
    expect(report.simulated).toBe(true);
    expect(report.recipients.SENT).toBe(2);
    expect(report.recipients.SKIPPED).toBe(2);
    await expect(run(a.session, () => buildDraft(d0.id, a.user.id))).rejects.toThrow(/כבר נשלח/);
  });

  it("SMS draft has no template step; schedule → unschedule → back to draft; delete draft removes campaign + working template", async () => {
    const d = await run(a.session, () => createDraft("sms", a.user.id, "SMS בדיקה"));
    expect(d.steps).toEqual(["info", "audience", "content", "review"]);
    await run(a.session, () => updateDraft(d.id, { data: { senderCredentialId: smsCred, senderId: "+972501110000", listIds: [listA], body: "היי {{first_name|לקוח}}, מבצע!" } }));
    const { campaignId } = await run(a.session, () => buildDraft(d.id, a.user.id));
    await run(a.session, () => changeCampaignStatus(campaignId, "start", new Date(Date.now() + 86400_000).toISOString(), a.user.id, "Asia/Jerusalem"));
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("SCHEDULED");
    await run(a.session, () => changeCampaignStatus(campaignId, "unschedule", undefined, a.user.id));
    const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c).toMatchObject({ status: "DRAFT", scheduledAt: null });
    const draft = await run(a.session, () => getDraft(d.id));
    await run(a.session, () => deleteDraft(d.id, a.user.id));
    expect(await db.campaign.count({ where: { id: campaignId } })).toBe(0);
    expect(await db.template.count({ where: { id: draft.templateId! } })).toBe(0);
  });

  it("a legacy DRAFT campaign opens in the builder at the review step with its data", async () => {
    const legacy = await run(a.session, () => createCampaign({ channel: "email", name: "ישן", listId: listA, templateId: sourceTpl, variables: {}, providerCredentialId: emailCred }, a.user.id));
    const d = await run(a.session, () => draftFromCampaign(legacy.id, a.user.id));
    expect(d).toMatchObject({ step: "review", campaignId: legacy.id, name: "ישן" });
    expect(d.data.listIds).toEqual([listA]);
    expect(d.data.subject).toBe("מקור");
    await run(a.session, () => deleteDraftCampaign(legacy.id, a.user.id));
  });

  it("tenant isolation: business B cannot read or build A's draft, and A's lists are invisible to B", async () => {
    const d = await run(a.session, () => createDraft("email", a.user.id, "סודי"));
    await expect(run(b.session, () => getDraft(d.id))).rejects.toThrow(/לא נמצאה/);
    await expect(run(b.session, () => buildDraft(d.id, b.user.id))).rejects.toThrow();
    expect((await run(b.session, () => listAudienceCounts())).length).toBe(0);
    await expect(run(b.session, () => previewAudience({ listIds: [listA], channel: "email" }))).rejects.toThrow(/אינם נגישים/);
  });
});
