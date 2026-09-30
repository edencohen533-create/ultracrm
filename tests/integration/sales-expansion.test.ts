import crypto from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import {
  connectMetaAds,
  leadAdvertisement,
  metaAdStatus,
} from "@/server/sales/meta-ads";
import {
  saveQualification,
  qualificationAnswers,
} from "@/server/ai/qualification";
import { salesDiagnostics } from "@/server/sales/diagnostics";
import { switchMode } from "@/lib/dialer/monitor";
const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  switchRole: vi.fn(async () => {}),
}));
vi.mock("@/lib/meta/graph", () => ({ graph: mocks.graph }));
vi.mock("@/lib/telephony", () => {
  // Actions on an existing call go through adapterFor(call.provider) since the provider layer (PR #20).
  const adapter = () => ({ switchSupervisorRole: mocks.switchRole, simulation: true, capabilities: { supervisorMonitor: true, serverHangup: true, dtmf: true, dialModel: "agent_then_lead" } });
  return { getTelephony: adapter, adapterFor: adapter };
});
let a: Awaited<ReturnType<typeof createBusiness>>,
  b: Awaited<ReturnType<typeof createBusiness>>,
  contactId: string,
  leadId: string;
const run = <T>(f: () => Promise<T>) =>
  withBusiness(a.business.id, f, a.session);
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  a = await createBusiness("sales-expand", {
    modules: { crm: true, telephony: true, whatsapp: true },
  });
  b = await createBusiness("sales-other");
  contactId = (
    await db.contact.create({
      data: {
        businessId: a.business.id,
        fullName: "QA",
        phoneE164: "+972550001234",
        phoneRaw: "qa",
        ownerUserId: a.user.id,
        customFields: { metaAdId: "123456" },
      },
    })
  ).id;
  leadId = (
    await db.lead.create({
      data: {
        businessId: a.business.id,
        contactId,
        ownerUserId: a.user.id,
        source: "FB",
        sourceAttribution: { adId: "123456" },
        createdAt: new Date(Date.now() - 20 * 86400000),
      },
    })
  ).id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await destroyBusiness(a.business.id, [a.account.id]);
  await destroyBusiness(b.business.id, [b.account.id]);
});
it("Meta secrets stay sealed and another ad account cannot leak creative", async () => {
  mocks.graph.mockResolvedValueOnce({ account_id: "987654", name: "QA ads" });
  await run(() =>
    connectMetaAds(a.session, {
      accountId: "act_987654",
      accessToken: "test-not-a-real-token",
    }),
  );
  const saved = await db.metaAdConnection.findUniqueOrThrow({
    where: { businessId: a.business.id },
  });
  expect(saved.tokenSealed).toMatch(/^enc:v1:/);
  expect(
    JSON.stringify(await run(() => metaAdStatus(a.session))),
  ).not.toContain("token");
  mocks.graph.mockResolvedValueOnce({
    id: "123456",
    account_id: "000000",
    creative: { body: "private-other-account" },
  });
  const r = await run(() => leadAdvertisement(a.session, leadId));
  expect(r.status).toBe("account_mismatch");
  expect(JSON.stringify(r)).not.toContain("private-other-account");
  await expect(
    withBusiness(
      b.business.id,
      () => leadAdvertisement(b.session, leadId),
      b.session,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});
it("ad view reports absent attribution and filters untrusted media URLs", async () => {
  expect((await run(() => leadAdvertisement(a.session, leadId))).status).toBe(
    "not_connected",
  );
  mocks.graph.mockResolvedValueOnce({ account_id: "987654" });
  await run(() =>
    connectMetaAds(a.session, {
      accountId: "987654",
      accessToken: "test-not-a-real-token",
    }),
  );
  mocks.graph.mockResolvedValueOnce({
    id: "123456",
    account_id: "987654",
    creative: { title: "Ad title", image_url: "javascript:alert(1)" },
  });
  expect(await run(() => leadAdvertisement(a.session, leadId))).toMatchObject({
    status: "available",
    ad: { title: "Ad title", image: null },
  });
  await db.lead.update({
    where: { id: leadId },
    data: { sourceAttribution: { campaign: "ambiguous" } },
  });
  expect((await run(() => leadAdvertisement(a.session, leadId))).status).toBe(
    "missing_attribution",
  );
});
it("qualification saves only configured questions and actual inbound excerpts, with deduplication and human takeover", async () => {
  await db.business.update({
    where: { id: a.business.id },
    data: {
      settings: {
        ai: {
          service: { enabled: true, qualificationQuestions: ["מה התקציב?"] },
        },
      },
    },
  });
  const conv = await db.conversation.create({
    data: {
      businessId: a.business.id,
      contactId,
      channel: "whatsapp",
      aiMode: "ai",
    },
  });
  const m = await db.message.create({
    data: {
      businessId: a.business.id,
      conversationId: conv.id,
      direction: "INBOUND",
      type: "TEXT",
      body: "התקציב שלי 500",
      status: "DELIVERED",
    },
  });
  expect(
    await run(() =>
      saveQualification(a.business.id, contactId, m.id, {
        question: "מה התקציב?",
        answer: "10000",
      }),
    ),
  ).toHaveProperty("error");
  expect(
    await run(() =>
      saveQualification(a.business.id, contactId, m.id, {
        question: "לא מוגדרת",
        answer: "500",
      }),
    ),
  ).toHaveProperty("error");
  const save = () =>
    run(() =>
      saveQualification(a.business.id, contactId, m.id, {
        question: "מה התקציב?",
        answer: "500",
      }),
    );
  expect(await save()).toMatchObject({ saved: true, complete: true });
  await save();
  expect(await run(() => qualificationAnswers(contactId))).toHaveLength(1);
  expect(
    await withBusiness(b.business.id, () =>
      saveQualification(b.business.id, contactId, m.id, {
        question: "מה התקציב?",
        answer: "500",
      }),
    ),
  ).toHaveProperty("error");
  await db.conversation.update({
    where: { id: conv.id },
    data: { aiMode: "human" },
  });
  expect(await save()).toHaveProperty("error");
});
it("diagnostics count genuine attempts and separate pre-dial failures, scope tenants and enforce minimum samples", async () => {
  const now = new Date();
  for (let i = 0; i < 40; i++) {
    const old = i < 20,
      at = new Date(now.getTime() - (old ? 10 : 2) * 86400000);
    await db.call.create({
      data: {
        businessId: a.business.id,
        userId: a.user.id,
        contactId,
        mode: "manual",
        provider: "mock",
        idempotencyKey: crypto.randomUUID(),
        toE164: "+972550001234",
        fromE164: "+97239000000",
        status: "ended",
        createdAt: at,
        leadDialedAt: at,
        endedAt: at,
        answeredAt: old || i < 25 ? at : null,
      },
    });
  }
  await db.call.create({
    data: {
      businessId: a.business.id,
      userId: a.user.id,
      mode: "manual",
      provider: "mock",
      idempotencyKey: crypto.randomUUID(),
      toE164: "+972550001234",
      fromE164: "+97239000000",
      status: "failed",
      failureReason: "agent_failed",
      endedAt: new Date(now.getTime() - 1000),
      createdAt: new Date(now.getTime() - 2000),
    },
  });
  const r = await run(() => salesDiagnostics(a.session, now));
  expect(r.rows.find((x) => x.dimension === "caller")).toMatchObject({
    current: { attempts: 20, answered: 5, failedBeforeDial: 1 },
    previous: { attempts: 20, answered: 20 },
    drop: true,
  });
  expect(
    (await withBusiness(b.business.id, () => salesDiagnostics(b.session, now)))
      .rows,
  ).toHaveLength(0);
  await expect(
    run(() => salesDiagnostics({ ...a.session, role: "agent" })),
  ).rejects.toMatchObject({ code: "forbidden" });
});
it("live expert mode requires an authorized live monitor and sends provider barge then monitor", async () => {
  const peer = await db.user.create({
    data: {
      businessId: a.business.id,
      accountId: b.account.id,
      email: "peer@test.local",
      fullName: "peer",
      role: "agent",
    },
  });
  const call = await db.call.create({
    data: {
      businessId: a.business.id,
      userId: peer.id,
      mode: "manual",
      provider: "mock",
      idempotencyKey: crypto.randomUUID(),
      toE164: "+972550001234",
      fromE164: "+97239000000",
      status: "answered",
      answeredAt: new Date(),
    },
  });
  const m = await db.callMonitor.create({
    data: {
      businessId: a.business.id,
      callId: call.id,
      managerId: a.user.id,
      activeForManager: a.user.id,
      legId: "mock-supervisor",
      mode: "listen",
      status: "listening",
    },
  });
  expect(await run(() => switchMode(a.session, m.id, "barge"))).toMatchObject({
    mode: "barge",
    status: "speaking",
  });
  expect(mocks.switchRole).toHaveBeenCalledWith("mock-supervisor", "barge");
  expect(await run(() => switchMode(a.session, m.id, "listen"))).toMatchObject({
    status: "listening",
  });
  await expect(
    withBusiness(b.business.id, () => switchMode(b.session, m.id, "barge")),
  ).rejects.toMatchObject({ code: "not_found" });
  await db.call.update({
    where: { id: call.id },
    data: { endedAt: new Date() },
  });
  await expect(
    run(() => switchMode(a.session, m.id, "barge")),
  ).rejects.toMatchObject({ code: "monitor_ended" });
});
it("expert requests require the caller, target a permitted recently active manager and expire", async () => {
  const { assistanceCandidates, requestAssistance, assistanceInbox } =
    await import("@/server/sales/assistance");
  const peer = await db.user.create({
    data: {
      businessId: a.business.id,
      accountId: b.account.id,
      email: "peer@test.local",
      fullName: "peer",
      role: "agent",
    },
  });
  const call = await db.call.create({
    data: {
      businessId: a.business.id,
      userId: peer.id,
      mode: "manual",
      provider: "mock",
      idempotencyKey: crypto.randomUUID(),
      toE164: "+972550001234",
      fromE164: "+97239000000",
      status: "answered",
      answeredAt: new Date(),
    },
  });
  await db.user.update({
    where: { id: a.user.id },
    data: { lastSeenAt: new Date() },
  });
  expect(
    (await run(() => assistanceCandidates(peer, call.id))).candidates,
  ).toEqual([{ id: a.user.id, name: a.user.fullName }]);
  await expect(
    run(() =>
      requestAssistance(a.session, {
        callId: call.id,
        expertId: peer.id,
        summary: "Help needed",
      }),
    ),
  ).rejects.toMatchObject({ code: "call_unavailable" });
  const req = await run(() =>
    requestAssistance(peer, {
      callId: call.id,
      expertId: a.user.id,
      summary: "Needs closing help",
    }),
  );
  await run(() =>
    requestAssistance(peer, {
      callId: call.id,
      expertId: a.user.id,
      summary: "Updated summary",
    }),
  );
  expect((await run(() => assistanceInbox(a.session))).items).toHaveLength(1);
  expect(
    (await withBusiness(b.business.id, () => assistanceInbox(b.session))).items,
  ).toHaveLength(0);
  await db.opsRecommendation.update({
    where: { id: req.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect((await run(() => assistanceInbox(a.session))).items).toHaveLength(0);
});
it("lead attribution is a creation snapshot and survives later contact edits", async () => {
  const { createLead } = await import("@/lib/crm/pipeline");
  // One open lead per person: close the one opened earlier in this file (this test is about the attribution snapshot).
  await db.lead.updateMany({ where: { contactId, status: { in: ["new", "contacted", "follow_up", "qualified"] } }, data: { status: "lost", closedAt: new Date() } });
  const l = await run(() =>
    createLead(a.session, {
      contactId,
      title: "Snapshot",
      ownerUserId: a.user.id,
    }),
  );
  expect(l.sourceAttribution).toMatchObject({
    adId: "123456",
    sourceType: "submitted",
  });
  await db.contact.update({
    where: { id: contactId },
    data: { customFields: { metaAdId: "999999" } },
  });
  expect(
    (await db.lead.findUniqueOrThrow({ where: { id: l.id } }))
      .sourceAttribution,
  ).toMatchObject({ adId: "123456" });
});
it("Meta video media is returned only when its source is permitted; lack of video access keeps ad details", async () => {
  mocks.graph.mockResolvedValueOnce({ account_id: "987654" });
  await run(() =>
    connectMetaAds(a.session, {
      accountId: "987654",
      accessToken: "test-not-a-real-token",
    }),
  );
  mocks.graph
    .mockResolvedValueOnce({
      id: "123456",
      account_id: "987654",
      creative: { video_id: "444444", title: "Video ad" },
    })
    .mockResolvedValueOnce({ source: "https://video.fbcdn.net/qa.mp4" });
  expect(await run(() => leadAdvertisement(a.session, leadId))).toMatchObject({
    status: "available",
    ad: { hasVideo: true, video: "https://video.fbcdn.net/qa.mp4" },
  });
  mocks.graph
    .mockResolvedValueOnce({
      id: "123456",
      account_id: "987654",
      creative: { video_id: "444444", title: "Video ad" },
    })
    .mockRejectedValueOnce(new Error("Missing video permission"));
  expect(await run(() => leadAdvertisement(a.session, leadId))).toMatchObject({
    status: "available",
    ad: { video: null, title: "Video ad" },
  });
});
