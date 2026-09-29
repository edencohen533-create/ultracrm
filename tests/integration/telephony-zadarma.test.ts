/**
 * Zadarma as backup (real DB, the REAL Zadarma adapter with fetch intercepted – nothing reaches Zadarma, no calls are
 * placed). Primary = a fake Telnyx that can be made to fail. Webhooks go through the real route handler with real
 * signatures. MOCKED: every Zadarma HTTP response; the event flow for callback calls is not documented by Zadarma and
 * is exactly what the live test must prove on a real account.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { sealSecret } from "@/lib/crypto";
import { createBusiness, destroyBusiness } from "./helpers";
import { startCall, reconcileCall, hangupCall, sendDtmf } from "@/lib/dialer/calls";
import { claimNextLead } from "@/lib/dialer/queue";
import { startMonitor } from "@/lib/dialer/monitor";
import { __setTestAdapters } from "@/lib/telephony/registry";
import { chooseProviderForNewCall } from "@/lib/telephony/routing";
import { zadarmaSignature, zadarmaAdapter, __resetZadarmaThrottle } from "@/lib/telephony/zadarma";
import { startZadarmaLiveTest } from "@/server/services/zadarma-admin-service";
import { POST as zadarmaWebhook } from "@/app/api/webhooks/zadarma/[account]/route";
import { TelephonyProviderError, type TelephonyAdapter } from "@/lib/telephony/types";

// ── fake primary ─────────────────────────────────────────────────────────────
const primary = { down: false, dials: 0 };
const fakeTelnyx: TelephonyAdapter = {
  name: "telnyx", simulation: false, testOnly: true,
  capabilities: { outboundDial: true, inboundCalls: true, conference: true, supervisorMonitor: true, recording: true, answeringMachineDetection: true, dtmf: true, agentClient: "telnyx-webrtc", legLookupByReference: true, dialModel: "agent_then_lead", serverHangup: true },
  configStatus: () => ({ configured: true, missing: [], accountRef: "fake" }), verifyConfig: async () => [{ name: "fake", ok: true }],
  agentAddress: async (u) => `tx-${u.slice(-6)}`, findLegByReference: async () => "none",
  dialAgent: async (i) => { primary.dials++; if (primary.down) throw new TelephonyProviderError("503", 503, "provider_outage"); return { legId: `tx-agent-${i.callId}` }; },
  dialLead: async (i) => ({ legId: `tx-lead-${i.callId}` }), hangupLeg: async () => undefined, answerLeg: async () => undefined,
  createConference: async (l) => `conf-${l}`, dialSupervisor: async (i) => ({ legId: `sup-${i.monitorId}` }), switchSupervisorRole: async () => undefined,
  sendDtmf: async () => undefined, isLegAlive: async () => true, createBrowserToken: async (u) => ({ token: "t", sipUsername: `tx-${u}`, expiresAt: new Date(Date.now() + 3600_000) }),
  getRecordingDownloadUrl: async () => null, deleteRecording: async () => true,
};

// ── intercepted Zadarma HTTP ────────────────────────────────────────────────
interface Req { url: URL; method: string; auth: string | null }
const requests: Req[] = [];
let zd: { callback: "ok" | "timeout" | "no_money"; stats: Array<Record<string, unknown>> } = { callback: "ok", stats: [] };
const realFetch = globalThis.fetch;

type Biz = Awaited<ReturnType<typeof createBusiness>> & { credId: string; secret: string; key: string; agent: SessionUser };
let A: Biz, B: Biz;
const accounts: string[] = [];
const run = <T,>(user: SessionUser, fn: () => Promise<T>) => withBusiness(user.businessId, fn, user);
let seq = 0;
const contact = async (businessId: string) => { seq++; return db.contact.create({ data: { businessId, fullName: `ZD ${seq}`, phoneE164: `+97250${String(1000000 + Date.now() % 100000 * 10 + seq).slice(-7)}`, phoneRaw: "x" } }); };
const dial = (user: SessionUser, contactId: string) => run(user, () => startCall(user, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId }));
const sign = (secret: string, s: string) => Buffer.from(crypto.createHmac("sha1", secret).update(s).digest("hex")).toString("base64");
async function hook(biz: Biz, fields: Record<string, string>, secret = biz.secret, account = biz.credId) {
  const signed = fields.event === "NOTIFY_RECORD" ? `${fields.pbx_call_id}${fields.call_id_with_rec}` : `${fields.internal}${fields.destination}${fields.call_start}`;
  const res = await zadarmaWebhook(new NextRequest(`http://localhost/api/webhooks/zadarma/${account}`, { method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded", signature: sign(secret, signed) } }), { params: Promise.resolve({ account }) });
  return { status: res.status, body: await res.json() };
}
const digits = (e164: string) => e164.replace(/\D/g, "");

async function setupBusiness(tag: string): Promise<Biz> {
  const t = await createBusiness(tag, { modules: { crm: true, telephony: true } });
  accounts.push(t.account.id);
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: `${tag} agent`, passwordHash: "x" } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: t.business.id, accountId: acc.id, email: acc.email, fullName: acc.fullName, role: "manager" } });
  const agent: SessionUser = { id: u.id, accountId: acc.id, businessId: t.business.id, email: acc.email, fullName: acc.fullName, role: "manager", teamId: null };
  const key = `key-${tag}-${crypto.randomUUID().slice(0, 8)}`, secret = `secret-${tag}-${crypto.randomUUID()}`;
  const cred = await db.telephonyProviderCredential.create({ data: { businessId: t.business.id, provider: "zadarma", secrets: sealSecret(JSON.stringify({ apiKey: key, apiSecret: secret })), callerIdE164: "+97235550000", callerIdSource: "zadarma_number", callerIdApprovedAt: new Date(), testNumbers: ["+972500000001"], lastCheckAt: new Date(), lastCheckOk: true, liveTestPassedAt: new Date() } });
  await db.telephonyAgentEndpoint.create({ data: { businessId: t.business.id, userId: t.user.id, provider: "zadarma", extension: "101" } });
  await db.telephonyAgentEndpoint.create({ data: { businessId: t.business.id, userId: u.id, provider: "zadarma", extension: "102" } });
  const now = new Date();
  await db.numberConnection.create({ data: { businessId: t.business.id, status: "verified", fingerprint: "mock", checkedAt: now } });
  await db.phoneNumber.create({ data: { businessId: t.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "telnyx", verificationStatus: "verified", verifiedAt: now } });
  return { ...t, credId: cred.id, secret, key, agent };
}

describe("Zadarma backup", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    process.env.TELEPHONY_ROUTING = "on";
    A = await setupBusiness("zd-a"); B = await setupBusiness("zd-b");
  }, 300_000);
  afterAll(async () => {
    __setTestAdapters(null); delete process.env.TELEPHONY_ROUTING;
    for (const b of [A, B]) if (b) await destroyBusiness(b.business.id);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 300_000);
  beforeEach(async () => {
    __setTestAdapters({ telnyx: fakeTelnyx });
    __resetZadarmaThrottle();
    primary.down = false; primary.dials = 0; requests.length = 0; zd = { callback: "ok", stats: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.zadarma.com") return realFetch(input as RequestInfo, init);
      requests.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/v1/request/callback/") {
        if (zd.callback === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
        if (zd.callback === "no_money") return json({ status: "error", message: "Not enough money" }, 400);
        return json({ status: "success", from: url.searchParams.get("from"), to: url.searchParams.get("to"), time: 1 });
      }
      if (url.pathname === "/v1/statistics/pbx/") return json({ status: "success", stats: zd.stats });
      if (url.pathname === "/v1/pbx/record/request/") return json({ status: "success", link: "https://api.zadarma.com/rec/abc.mp3", lifetime_till: "x" });
      if (url.pathname === "/v1/webrtc/get_key/") return json({ status: "success", key: "widget-key" });
      return json({ status: "error", message: "unexpected in test" }, 404);
    });
    for (const b of [A, B]) {
      await db.telephonyRouting.deleteMany({ where: { businessId: b.business.id } });
      await db.telephonyProviderHealth.deleteMany({ where: { businessId: b.business.id } });
      await db.telephonySwitchLog.deleteMany({ where: { businessId: b.business.id } });
      await db.call.updateMany({ where: { businessId: b.business.id }, data: { activeForUser: null, endedAt: new Date(), outcomeSavedAt: new Date() } });
      await db.telephonyRouting.create({ data: { businessId: b.business.id, primaryProvider: "telnyx", backupProvider: "zadarma", mode: "auto_failover", failureThreshold: 1 } });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("primary outage → the next call goes to Zadarma as a signed callback from the agent's extension, with the approved caller ID; managers are alerted once", async () => {
    primary.down = true;
    await dial(A.session, (await contact(A.business.id)).id); // trips the primary
    const c = await contact(A.business.id);
    const call = await dial(A.session, c.id);
    expect(call.provider).toBe("zadarma");
    expect(call.fromE164).toBe("+97235550000");
    const req = requests.find((r) => r.url.pathname === "/v1/request/callback/")!;
    expect(Object.fromEntries(req.url.searchParams)).toEqual({ from: "101", sip: "101", to: digits(c.phoneE164) });
    expect(req.auth).toBe(`${A.key}:${zadarmaSignature("/v1/request/callback/", { from: "101", sip: "101", to: digits(c.phoneE164) }, A.secret)}`);
    const log = await db.telephonySwitchLog.findFirstOrThrow({ where: { businessId: A.business.id, kind: "auto_failover" } });
    expect(log.toProvider).toBe("zadarma");
    expect(log.reason).toMatch(/provider_outage/);
    expect(log.notifiedAt).not.toBeNull();
  });

  it("webhooks drive the call: start → answered → end; duplicates and late events change nothing; the recording is stored", async () => {
    primary.down = true;
    const c = await contact(A.business.id);
    const call = await (async () => { await dial(A.session, (await contact(A.business.id)).id); return dial(A.session, c.id); })();
    const base = { internal: "101", destination: digits(c.phoneE164), call_start: "2026-09-29 12:00:00", pbx_call_id: `out_${call.id}` };
    expect((await hook(A, { event: "NOTIFY_OUT_START", ...base })).status).toBe(200);
    let fresh = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(fresh.leadLegId).toBe(`out_${call.id}`);
    expect(fresh.agentAnsweredAt).not.toBeNull();
    expect(fresh.ringingAt).toBeNull();
    expect((await hook(A, { event: "NOTIFY_OUT_START", ...base })).body.duplicates).toBe(2);
    await hook(A, { event: "NOTIFY_OUT_END", ...base, disposition: "answered", duration: "30", is_recorded: "1", call_id_with_rec: "rec-1" });
    fresh = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(fresh.endedAt).not.toBeNull();
    expect(fresh.telephonyResult).toBe("answered");
    expect(fresh.talkSeconds).toBeGreaterThanOrEqual(29);
    await hook(A, { event: "NOTIFY_OUT_START", ...base, call_start: "2026-09-29 12:00:05" }); // late, different id
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).telephonyResult).toBe("answered");
    await hook(A, { event: "NOTIFY_RECORD", pbx_call_id: `out_${call.id}`, call_id_with_rec: "rec-1" });
    fresh = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(fresh.recordingStatus).toBe("saved");
    expect(fresh.recordingId).toBe("rec-1");
    // The recording link is requested with THIS business's account.
    const src = await zadarmaAdapter.getRecordingDownloadUrl("rec-1");
    expect(src?.url).toContain("/rec/abc.mp3");
    expect(requests.find((r) => r.url.pathname === "/v1/pbx/record/request/")!.auth!.startsWith(`${A.key}:`)).toBe(true);
  });

  it("isolation: a bad signature, or business A's event posted to business B's URL, is rejected and touches nothing", async () => {
    primary.down = true;
    const c = await contact(A.business.id);
    await dial(A.session, (await contact(A.business.id)).id);
    const call = await dial(A.session, c.id);
    const fields = { event: "NOTIFY_OUT_END", internal: "101", destination: digits(c.phoneE164), call_start: "2026-09-29 12:01:00", pbx_call_id: `x_${call.id}`, disposition: "answered", duration: "5" };
    expect((await hook(A, fields, "wrong-secret")).status).toBe(401);
    expect((await hook(B, fields, A.secret, B.credId)).status).toBe(401);
    const signedByB = await hook(B, fields); // valid for B, but no B call matches A's call
    expect(signedByB.body.matched).toBe(false);
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).endedAt).toBeNull();
  });

  it("busy and wrong number are results; 'no money' is an account failure: technical failure, no attempt charged, breaker opens", async () => {
    await db.telephonyRouting.update({ where: { businessId: A.business.id }, data: { mode: "manual_backup", manualActive: "backup" } });
    const c1 = await contact(A.business.id);
    const busyCall = await dial(A.session, c1.id);
    const b1 = { internal: "101", destination: digits(c1.phoneE164), call_start: "2026-09-29 12:02:00", pbx_call_id: `b_${busyCall.id}` };
    await hook(A, { event: "NOTIFY_OUT_START", ...b1 });
    await hook(A, { event: "NOTIFY_OUT_END", ...b1, disposition: "busy", duration: "0" });
    expect((await db.call.findUniqueOrThrow({ where: { id: busyCall.id } })).telephonyResult).toBe("busy");
    expect(await db.telephonyProviderHealth.count({ where: { businessId: A.business.id, provider: "zadarma", state: "open" } })).toBe(0);
    await db.call.update({ where: { id: busyCall.id }, data: { outcomeSavedAt: new Date() } });
    // A lead in a dial list: a provider-side failure must not count as a dial attempt.
    const c2 = await contact(A.business.id);
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "zd list" } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: c2.id } });
    const session = await db.dialerSession.create({ data: { businessId: A.business.id, userId: A.user.id, listId: list.id, mode: "preview", browserSessionId: "zd1" } });
    const claimed = await run(A.session, () => claimNextLead(A.business.id, A.user.id, list.id));
    const call = await run(A.session, () => startCall(A.session, { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: session.id, browserSessionId: "zd1", leadId: claimed!.id, lockToken: claimed!.lockToken! }));
    const b2 = { internal: "101", destination: digits(c2.phoneE164), call_start: "2026-09-29 12:03:00", pbx_call_id: `m_${call.id}` };
    await hook(A, { event: "NOTIFY_OUT_START", ...b2 });
    await hook(A, { event: "NOTIFY_OUT_END", ...b2, disposition: "no money", duration: "0" });
    const after = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.status).toBe("failed");
    expect(after.outcomeSavedAt).not.toBeNull(); // technical failure: nothing for the agent to document
    const lead = await db.listLead.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(lead.attempts).toBe(0);
    expect(lead.status).toBe("pending");
    expect((await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: A.business.id, provider: "zadarma" } } })).state).toBe("open");
    await db.dialerSession.update({ where: { id: session.id }, data: { status: "ended" } });
  });

  it("hang-up, DTMF and supervisor listening are refused with a reason on a Zadarma call – never reported as done", async () => {
    await db.telephonyRouting.update({ where: { businessId: A.business.id }, data: { mode: "manual_backup", manualActive: "backup" } });
    const call = await dial(A.agent, (await contact(A.business.id)).id);
    await expect(run(A.agent, () => hangupCall(A.agent, call.id))).rejects.toMatchObject({ code: "provider_capability_missing" });
    await db.call.update({ where: { id: call.id }, data: { answeredAt: new Date(), leadLegId: `l_${call.id}` } });
    await expect(run(A.agent, () => sendDtmf(A.agent, call.id, "1"))).rejects.toMatchObject({ code: "provider_capability_missing" });
    await expect(run(A.session, () => startMonitor(A.session, call.id))).rejects.toMatchObject({ code: "provider_capability_missing" }); // owner listening to the agent
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).hangupRequestedAt).toBeNull();
  });

  it("callback timeout: uncertain; found in statistics → adopted; not found → settlement, and never a second callback", async () => {
    await db.telephonyRouting.update({ where: { businessId: A.business.id }, data: { mode: "manual_backup", manualActive: "backup" } });
    zd.callback = "timeout";
    const c = await contact(A.business.id);
    const call = await dial(A.session, c.id);
    expect(call.dialPendingSince).not.toBeNull();
    expect((await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } })).status).toBe("uncertain");
    zd.stats = [{ sip: "101", destination: digits(c.phoneE164), pbx_call_id: `st_${call.id}`, callstart: "2026-09-29 12:04:00" }];
    await db.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date(Date.now() - 20_000) } });
    const adopted = await run(A.session, () => reconcileCall(call.id));
    expect(adopted?.leadLegId).toBe(`st_${call.id}`);
    expect((await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } })).status).toBe("created");
    await db.call.update({ where: { id: call.id }, data: { endedAt: new Date(), outcomeSavedAt: new Date(), activeForUser: null } });
    // Second call: nothing in the statistics → after the window it waits for settlement.
    __resetZadarmaThrottle(); zd.stats = [];
    const c2 = await contact(A.business.id);
    const call2 = await dial(A.session, c2.id);
    await db.call.update({ where: { id: call2.id }, data: { dialPendingSince: new Date(Date.now() - 60_000) } });
    const closed = await run(A.session, () => reconcileCall(call2.id));
    expect(closed?.failureReason).toBe("provider_unconfirmed");
    expect((await db.callAttempt.findFirstOrThrow({ where: { callId: call2.id } })).status).toBe("needs_settlement");
    expect(requests.filter((r) => r.url.pathname === "/v1/request/callback/" && r.url.searchParams.get("to") === digits(c2.phoneE164))).toHaveLength(1);
  });

  it("both providers down: the dial is refused up front, nothing is created", async () => {
    primary.down = true;
    await dial(A.session, (await contact(A.business.id)).id); // trips primary
    await db.telephonyProviderHealth.upsert({ where: { businessId_provider: { businessId: A.business.id, provider: "zadarma" } }, create: { businessId: A.business.id, provider: "zadarma", state: "open", openedAt: new Date(), nextProbeAt: new Date(Date.now() + 600_000) }, update: { state: "open", openedAt: new Date(), nextProbeAt: new Date(Date.now() + 600_000) } });
    const c = await contact(A.business.id);
    await expect(dial(A.session, c.id)).rejects.toMatchObject({ code: "telephony_unavailable" });
    expect(await db.call.count({ where: { contactId: c.id } })).toBe(0);
  });

  it("capacity: the account's concurrent-call limit is enforced before dialing", async () => {
    await db.telephonyRouting.update({ where: { businessId: A.business.id }, data: { mode: "manual_backup", manualActive: "backup" } });
    await db.telephonyProviderCredential.update({ where: { id: A.credId }, data: { maxConcurrent: 1 } });
    try {
      await dial(A.session, (await contact(A.business.id)).id);
      await expect(dial(A.agent, (await contact(A.business.id)).id)).rejects.toMatchObject({ code: "backup_capacity" });
    } finally { await db.telephonyProviderCredential.update({ where: { id: A.credId }, data: { maxConcurrent: null } }); }
  });

  it("two businesses dialing through Zadarma at the same time use their own accounts", async () => {
    for (const b of [A, B]) await db.telephonyRouting.update({ where: { businessId: b.business.id }, data: { mode: "manual_backup", manualActive: "backup" } });
    const [ca, cb] = [await contact(A.business.id), await contact(B.business.id)];
    const [x, y] = await Promise.all([dial(A.session, ca.id), dial(B.session, cb.id)]);
    expect([x.provider, y.provider]).toEqual(["zadarma", "zadarma"]);
    const cbs = requests.filter((r) => r.url.pathname === "/v1/request/callback/");
    expect(cbs.find((r) => r.url.searchParams.get("to") === digits(ca.phoneE164))!.auth!.startsWith(`${A.key}:`)).toBe(true);
    expect(cbs.find((r) => r.url.searchParams.get("to") === digits(cb.phoneE164))!.auth!.startsWith(`${B.key}:`)).toBe(true);
  });

  it("not live-tested → not eligible: failover stays on the primary; the live test only calls an approved test number and passes on the end event", async () => {
    await db.telephonyProviderCredential.update({ where: { id: A.credId }, data: { liveTestPassedAt: null } });
    primary.down = true;
    await dial(A.session, (await contact(A.business.id)).id);
    expect((await chooseProviderForNewCall(A.business.id)).reason).toBe("backup_unavailable:live_test_required");
    await expect(run(A.session, () => startZadarmaLiveTest(A.session, "+972541111111"))).rejects.toMatchObject({ code: "test_number_not_approved" });
    const { callId } = await run(A.session, () => startZadarmaLiveTest(A.session, "+972500000001"));
    const t = { internal: "101", destination: "972500000001", call_start: "2026-09-29 12:10:00", pbx_call_id: `lt_${callId}` };
    await hook(A, { event: "NOTIFY_OUT_START", ...t });
    await hook(A, { event: "NOTIFY_OUT_END", ...t, disposition: "answered", duration: "3" });
    expect((await db.telephonyProviderCredential.findUniqueOrThrow({ where: { id: A.credId } })).liveTestPassedAt).not.toBeNull();
    const testCall = await db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(testCall.outcomeSavedAt).not.toBeNull();
    expect(testCall.activeForUser).toBeNull();
  });

  it("controlled return: once the primary's cooldown passes and its probe succeeds, new calls go back to it (logged)", async () => {
    primary.down = true;
    await dial(A.session, (await contact(A.business.id)).id);
    expect((await dial(A.session, (await contact(A.business.id)).id)).provider).toBe("zadarma");
    await db.call.updateMany({ where: { businessId: A.business.id }, data: { activeForUser: null, endedAt: new Date(), outcomeSavedAt: new Date() } });
    primary.down = false;
    await db.telephonyProviderHealth.update({ where: { businessId_provider: { businessId: A.business.id, provider: "telnyx" } }, data: { nextProbeAt: new Date(Date.now() - 1000) } });
    expect((await dial(A.session, (await contact(A.business.id)).id)).provider).toBe("telnyx");
    expect(await db.telephonySwitchLog.count({ where: { businessId: A.business.id, kind: "auto_recovery" } })).toBe(1);
  });
});
