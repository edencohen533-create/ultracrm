/**
 * Telephony provider layer (real DB, fake providers – never a real call): routing policy, circuit breaker,
 * provider-bound calls, uncertain dials, webhook order/duplicates, concurrency and business isolation.
 * Two test-only adapters stand in for "primary" (enum telnyx) and "backup" (enum mock).
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { startCall, reconcileCall, hangupCall } from "@/lib/dialer/calls";
import { claimNextLead } from "@/lib/dialer/queue";
import { processProviderEvent, UNCONFIRMED_HOLD_MINUTES } from "@/lib/telephony/events";
import { __setTestAdapters } from "@/lib/telephony/registry";
import { chooseProviderForNewCall } from "@/lib/telephony/routing";
import { routingOverview, saveRouting, settleAttempt } from "@/server/services/telephony-admin-service";
import { TelephonyProviderError, TelephonyRequestTimeout, type ProviderEvent, type TelephonyAdapter } from "@/lib/telephony/types";

type FakeMode = "ok" | "down" | "timeout" | "auth" | "rate";
interface Fake { adapter: TelephonyAdapter; mode: FakeMode; dials: string[]; hangups: string[]; lookup: "none" | "found" | null }

function fake(name: "telnyx" | "mock", agentClient: TelephonyAdapter["capabilities"]["agentClient"] = "telnyx-webrtc"): Fake {
  const f: Fake = { mode: "ok", dials: [], hangups: [], lookup: "none", adapter: null as unknown as TelephonyAdapter };
  const fail = () => {
    if (f.mode === "down") throw new TelephonyProviderError(`${name} 503`, 503, "provider_outage");
    if (f.mode === "timeout") throw new TelephonyRequestTimeout();
    if (f.mode === "auth") throw new TelephonyProviderError(`${name} 401`, 401, "auth");
    if (f.mode === "rate") throw new TelephonyProviderError(`${name} 429`, 429, "rate_limit", 1);
  };
  f.adapter = {
    name, simulation: false, testOnly: true,
    capabilities: { outboundDial: true, inboundCalls: true, conference: true, supervisorMonitor: true, recording: true, answeringMachineDetection: true, dtmf: true, agentClient, legLookupByReference: true },
    configStatus: () => ({ configured: true, missing: [], accountRef: `fake-${name}` }),
    verifyConfig: async () => [{ name: "fake", ok: true }],
    agentAddress: async (userId) => `${name}-sip-${userId.slice(-6)}`,
    findLegByReference: async (ref) => (f.lookup === "found" ? { legId: `${name}-${ref.leg}-${ref.callId}` } : f.lookup),
    dialAgent: async (i) => { f.dials.push(`agent:${i.callId}`); fail(); return { legId: `${name}-agent-${i.callId}` }; },
    dialLead: async (i) => { f.dials.push(`lead:${i.callId}`); fail(); return { legId: `${name}-lead-${i.callId}` }; },
    hangupLeg: async (legId) => { f.hangups.push(legId); },
    answerLeg: async () => undefined,
    createConference: async (legId) => `${name}-conf-${legId}`,
    dialSupervisor: async (i) => ({ legId: `${name}-sup-${i.monitorId}` }),
    switchSupervisorRole: async () => undefined,
    sendDtmf: async () => undefined,
    isLegAlive: async () => true,
    createBrowserToken: async (userId) => ({ token: "t", sipUsername: `${name}-sip-${userId.slice(-6)}`, expiresAt: new Date(Date.now() + 3600_000) }),
    getRecordingDownloadUrl: async () => null,
    deleteRecording: async () => true,
  };
  return f;
}

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, agent2: SessionUser, ownerB: SessionUser;
const accounts: string[] = [];
let primary: Fake, backup: Fake;
const run = <T,>(user: SessionUser, fn: () => Promise<T>) => withBusiness(user.businessId, fn, user);
let seq = 0;
const contact = async (businessId = a.business.id) => { seq++; return db.contact.create({ data: { businessId, fullName: `Lead ${seq}`, phoneE164: `+9725${String(40000000 + Date.now() % 1000000 * 10 + seq).slice(-8)}`, phoneRaw: "x" } }); };
const dial = (user: SessionUser, contactId: string, extra: Partial<Parameters<typeof startCall>[1]> = {}) => run(user, () => startCall(user, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId, ...extra }));
const ev = (call: { id: string; provider: "telnyx" | "mock" }, id: string, type: ProviderEvent["type"], leg: "agent" | "lead", extra: Partial<ProviderEvent> = {}): ProviderEvent => ({ provider: call.provider, eventId: `${call.id}:${id}`, type, legId: `${call.provider}-${leg}-${call.id}`, callId: call.id, leg, occurredAt: new Date(), raw: {}, ...extra });
const setRouting = (businessId: string, data: Record<string, unknown>) => db.telephonyRouting.upsert({ where: { businessId }, create: { businessId, ...data }, update: data });
/** Close a call cleanly so the agent is free for the next test. */
const finish = async (call: { id: string; provider: "telnyx" | "mock"; userId: string }) => {
  await processProviderEvent(ev(call, `h-${crypto.randomUUID()}`, "leg.hangup", "agent", { hangupCause: "normal_clearing" }));
  await db.call.updateMany({ where: { id: call.id }, data: { outcomeSavedAt: new Date(), endedAt: new Date(), activeForUser: null } });
};

describe("telephony provider routing", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    process.env.TELEPHONY_ROUTING = "on";
    a = await createBusiness("tel-route", { modules: { crm: true, telephony: true } });
    b = await createBusiness("tel-route-b", { modules: { crm: true, telephony: true } });
    accounts.push(a.account.id, b.account.id);
    owner = a.session; ownerB = b.session;
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "Agent 2", passwordHash: "x" } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: acc.fullName, role: "manager" } });
    agent2 = { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: acc.fullName, role: "manager", teamId: null };
    const now = new Date();
    for (const biz of [a.business.id, b.business.id]) {
      await db.numberConnection.upsert({ where: { businessId: biz }, create: { businessId: biz, status: "verified", fingerprint: "mock", checkedAt: now }, update: { status: "verified", fingerprint: "mock", checkedAt: now } });
      // One verified caller id per provider: a number is used only through the provider that owns it.
      await db.phoneNumber.create({ data: { businessId: biz, e164: `+9727${String(Date.now() + 1).slice(-8)}`, provider: "telnyx", verificationStatus: "verified", verifiedAt: now } });
      await db.phoneNumber.create({ data: { businessId: biz, e164: `+9727${String(Date.now() + 2).slice(-8)}`, provider: "mock", verificationStatus: "verified", verifiedAt: now } });
    }
  }, 300_000);
  afterAll(async () => {
    __setTestAdapters(null);
    delete process.env.TELEPHONY_ROUTING;
    if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 300_000);
  beforeEach(async () => {
    primary = fake("telnyx"); backup = fake("mock");
    __setTestAdapters({ telnyx: primary.adapter, mock: backup.adapter });
    for (const biz of [a.business.id, b.business.id]) {
      await db.telephonyProviderHealth.deleteMany({ where: { businessId: biz } });
      await db.telephonySwitchLog.deleteMany({ where: { businessId: biz } });
      await db.telephonyRouting.deleteMany({ where: { businessId: biz } });
      await db.call.updateMany({ where: { businessId: biz, activeForUser: { not: null } }, data: { activeForUser: null, endedAt: new Date(), outcomeSavedAt: new Date() } });
      await db.call.updateMany({ where: { businessId: biz, outcomeSavedAt: null }, data: { outcomeSavedAt: new Date(), endedAt: new Date() } });
    }
    await db.user.updateMany({ where: { businessId: { in: [a.business.id, b.business.id] } }, data: { presence: "available" } });
  });

  it("feature flag off: new calls use the platform default, routing rows are ignored", async () => {
    process.env.TELEPHONY_ROUTING = "off";
    try {
      await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover" });
      expect((await chooseProviderForNewCall(a.business.id)).reason).toBe("routing_off");
    } finally { process.env.TELEPHONY_ROUTING = "on"; }
  });

  it("primary only: a provider outage fails the call as a technical failure, trips the breaker, never switches", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "primary_only", failureThreshold: 2 });
    primary.mode = "down";
    for (let i = 0; i < 3; i++) {
      const call = await dial(owner, (await contact()).id);
      expect(call.provider).toBe("telnyx");
      expect(call.status).toBe("failed");
    }
    expect(backup.dials).toHaveLength(0);
    const h = await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } } });
    expect(h.state).toBe("open");
    const attempts = await db.callAttempt.findMany({ where: { businessId: a.business.id, provider: "telnyx", failureClass: "provider_outage" } });
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts.every((x) => x.status === "failed" && x.httpStatus === 503)).toBe(true);
  });

  it("automatic failover: after the threshold new calls go to the backup (logged once), active calls stay put", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 2 });
    primary.mode = "down";
    await dial(owner, (await contact()).id);
    await dial(owner, (await contact()).id);
    const c3 = await dial(owner, (await contact()).id);
    const c4 = await dial(agent2, (await contact()).id);
    expect(c3.provider).toBe("mock");
    expect(c4.provider).toBe("mock");
    expect(c3.agentLegId).toBe(`mock-agent-${c3.id}`);
    const log = await db.telephonySwitchLog.findMany({ where: { businessId: a.business.id }, orderBy: { createdAt: "asc" } });
    expect(log.filter((l) => l.kind === "auto_failover")).toHaveLength(1);
    expect(log.some((l) => l.kind === "breaker_open" && l.fromProvider === "telnyx")).toBe(true);
    // The primary recovers and the manager returns routing to it: the call already on the backup is still hung up there.
    primary.mode = "ok";
    await hangupCall(owner, c3.id);
    expect(backup.hangups).toContain(`mock-agent-${c3.id}`);
    expect(primary.hangups).not.toContain(`mock-agent-${c3.id}`);
    await finish(c3); await finish(c4);
  });

  it("busy / no answer are call results: they never count toward the breaker or cause a switch", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 1 });
    for (const cause of ["user_busy", "no_answer", "call_rejected"]) {
      const call = await dial(owner, (await contact()).id);
      await processProviderEvent(ev(call, "ag-ans", "leg.answered", "agent"));
      await processProviderEvent(ev(call, "ld-hang", "leg.hangup", "lead", { hangupCause: cause }));
      const after = await db.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(after.provider).toBe("telnyx");
      expect(after.endedAt).not.toBeNull();
      await finish(call);
    }
    const h = await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } } });
    expect(h.state).toBe("closed");
    expect(h.failuresInWindow).toBe(0);
    expect(await db.telephonySwitchLog.count({ where: { businessId: a.business.id, kind: "auto_failover" } })).toBe(0);
  });

  it("rate limiting backs off without tripping; an auth failure trips at once", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 2 });
    primary.mode = "rate";
    for (let i = 0; i < 3; i++) await dial(owner, (await contact()).id);
    let h = await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } } });
    expect(h.state).toBe("closed");
    expect(h.lastFailureClass).toBe("rate_limit");
    primary.mode = "auth";
    await dial(owner, (await contact()).id);
    h = await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } } });
    expect(h.state).toBe("open");
  });

  it("controlled recovery: after the cooldown only probe calls reach the primary; success closes it and routing returns", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 1, cooldownSeconds: 30, probeCalls: 1 });
    primary.mode = "auth";
    await dial(owner, (await contact()).id); // trips
    const onBackup = await dial(owner, (await contact()).id);
    expect(onBackup.provider).toBe("mock");
    await finish(onBackup);
    primary.mode = "ok";
    await db.telephonyProviderHealth.update({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } }, data: { nextProbeAt: new Date(Date.now() - 1000) } });
    // Two choices before any result comes back: the single probe slot goes to the primary, the other call to the backup.
    const [first, second] = [await chooseProviderForNewCall(a.business.id), await chooseProviderForNewCall(a.business.id)];
    expect(first).toMatchObject({ provider: "telnyx", probe: true });
    expect(second.provider).toBe("mock");
    // Release the unused reservation (as after a cooldown) and let a real probe call succeed.
    await db.telephonyProviderHealth.update({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } }, data: { probesStarted: 0 } });
    const probe = await dial(owner, (await contact()).id);
    expect(probe.provider).toBe("telnyx");
    const h = await db.telephonyProviderHealth.findUniqueOrThrow({ where: { businessId_provider: { businessId: a.business.id, provider: "telnyx" } } });
    expect(h.state).toBe("closed"); // the probe's dial succeeded
    await finish(probe);
    const next = await dial(owner, (await contact()).id);
    expect(next.provider).toBe("telnyx");
    const kinds = (await db.telephonySwitchLog.findMany({ where: { businessId: a.business.id }, orderBy: { createdAt: "asc" } })).map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(["breaker_open", "auto_failover", "breaker_closed", "auto_recovery"]));
    await finish(next);
  });

  it("dial timeout → uncertain: no redial on any provider; a leg found by reference is adopted", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 5 });
    primary.mode = "timeout";
    const call = await dial(owner, (await contact()).id);
    expect(call.dialPendingSince).not.toBeNull();
    expect(call.endedAt).toBeNull();
    const att = await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } });
    expect(att.status).toBe("uncertain");
    // While uncertain, nobody can dial the same number – on either provider.
    await expect(dial(agent2, call.contactId!)).rejects.toMatchObject({ code: "number_in_call" });
    primary.lookup = "found";
    await db.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date(Date.now() - 20_000) } });
    const after = await run(owner, () => reconcileCall(call.id));
    expect(after?.agentLegId).toBe(`telnyx-agent-${call.id}`);
    expect((await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } })).status).toBe("created");
    expect(primary.dials.filter((d) => d === `agent:${call.id}`)).toHaveLength(1);
    expect(backup.dials).toHaveLength(0);
    await finish(call);
  });

  it("dial timeout that cannot be proven → settlement: call closed, lead not charged an attempt and held, no redial", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", mode: "primary_only" });
    const c = await contact();
    const list = await db.dialList.create({ data: { businessId: a.business.id, name: "routing test" } });
    await db.listLead.create({ data: { businessId: a.business.id, listId: list.id, contactId: c.id } });
    const session = await db.dialerSession.create({ data: { businessId: a.business.id, userId: owner.id, listId: list.id, mode: "preview", browserSessionId: "rt1" } });
    const claimed = await run(owner, () => claimNextLead(a.business.id, owner.id, list.id));
    expect(claimed?.contactId).toBe(c.id);
    primary.mode = "timeout"; primary.lookup = "none";
    const call = await run(owner, () => startCall(owner, { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: session.id, browserSessionId: "rt1", leadId: claimed!.id, lockToken: claimed!.lockToken! }));
    await db.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date(Date.now() - 60_000) } });
    const after = await run(owner, () => reconcileCall(call.id));
    expect(after?.endedAt).not.toBeNull();
    expect(after?.failureReason).toBe("provider_unconfirmed");
    expect((await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } })).status).toBe("needs_settlement");
    const l = await db.listLead.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(l.attempts).toBe(0); // a technical failure is not a dial attempt
    expect(l.status).toBe("pending"); // never "not relevant"
    expect(l.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + (UNCONFIRMED_HOLD_MINUTES - 1) * 60_000);
    expect(primary.dials.filter((d) => d === `agent:${call.id}`)).toHaveLength(1);
    const overview = await run(owner, () => routingOverview(a.business.id));
    expect(overview.settlement.map((s) => s.callId)).toContain(call.id);
    const attempt = await db.callAttempt.findFirstOrThrow({ where: { callId: call.id } });
    await run(owner, () => settleAttempt(a.business.id, owner.id, attempt.id, "no_call"));
    expect((await db.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).settledAt).not.toBeNull();
    await db.dialerSession.update({ where: { id: session.id }, data: { status: "ended" } });
  });

  it("webhooks: duplicates, late and reversed events; an event can never attach to another provider's call", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", mode: "primary_only" });
    const call = await dial(owner, (await contact()).id);
    await processProviderEvent(ev(call, "ag-ans", "leg.answered", "agent"));
    await processProviderEvent(ev(call, "ld-hang", "leg.hangup", "lead", { hangupCause: "normal_clearing" })); // hangup before "answered"
    const dup = await processProviderEvent(ev(call, "ld-hang", "leg.hangup", "lead", { hangupCause: "normal_clearing" }));
    expect(dup.duplicate).toBe(true);
    await processProviderEvent(ev(call, "ld-ans-late", "leg.answered", "lead")); // late
    const after = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.endedAt).not.toBeNull();
    expect(after.answeredAt).toBeNull();
    // Same call id echoed by a different provider: ignored, the call is untouched.
    const foreign = await processProviderEvent({ ...ev(call, "foreign", "leg.answered", "lead"), provider: "mock" });
    expect(foreign.callId).toBeNull();
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).answeredAt).toBeNull();
    await finish(call);
  });

  it("concurrent dials to one number (different agents) create one call, whatever the provider", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover" });
    const c = await contact();
    const res = await Promise.allSettled([dial(owner, c.id), dial(agent2, c.id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.call.count({ where: { contactId: c.id } })).toBe(1);
    const won = (res.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof dial>>>).value;
    await finish(won);
  });

  it("a browser registered with another provider must reconnect before dialing", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", mode: "primary_only" });
    await expect(dial(owner, (await contact()).id, { agentProvider: "mock" })).rejects.toMatchObject({ code: "agent_reregister_required" });
  });

  it("a backup without an agent client, or not configured, is never used for real calls", async () => {
    backup = fake("mock", "sip-websocket");
    __setTestAdapters({ telnyx: primary.adapter, mock: backup.adapter });
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 1 });
    primary.mode = "auth";
    await dial(owner, (await contact()).id);
    const choice = await chooseProviderForNewCall(a.business.id);
    expect(choice.provider).toBe("telnyx");
    expect(choice.reason).toBe("backup_unavailable:agent_client_missing");
    await expect(run(owner, () => saveRouting(a.business.id, owner.id, { mode: "manual_backup", manualActive: "backup" }))).rejects.toMatchObject({ code: "backup_not_eligible" });
  });

  it("manual switch: logged, new calls follow it, calls in progress keep their provider", async () => {
    await run(owner, () => saveRouting(a.business.id, owner.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "manual_backup" }));
    const before = await dial(owner, (await contact()).id);
    expect(before.provider).toBe("telnyx");
    await run(owner, () => saveRouting(a.business.id, owner.id, { manualActive: "backup" }));
    const afterSwitch = await dial(agent2, (await contact()).id);
    expect(afterSwitch.provider).toBe("mock");
    expect((await db.call.findUniqueOrThrow({ where: { id: before.id } })).provider).toBe("telnyx");
    const manual = await db.telephonySwitchLog.findFirstOrThrow({ where: { businessId: a.business.id, kind: "manual" } });
    expect(manual).toMatchObject({ fromProvider: "telnyx", toProvider: "mock", actorId: owner.id });
    await finish(before); await finish(afterSwitch);
  });

  it("business isolation: one business's outage, policy and log do not touch another", async () => {
    await setRouting(a.business.id, { primaryProvider: "telnyx", backupProvider: "mock", mode: "auto_failover", failureThreshold: 1 });
    primary.mode = "auth";
    await dial(owner, (await contact()).id);
    expect((await chooseProviderForNewCall(a.business.id)).provider).toBe("mock");
    primary.mode = "ok";
    await setRouting(b.business.id, { primaryProvider: "telnyx", mode: "primary_only" });
    const inB = await dial(ownerB, (await contact(b.business.id)).id);
    expect(inB.provider).toBe("telnyx");
    const ovB = await run(ownerB, () => routingOverview(b.business.id));
    expect(ovB.log).toHaveLength(0);
    expect(ovB.health.every((h) => h.state === "closed")).toBe(true);
    // Row-level security: inside business B's scope, business A's routing rows are invisible.
    expect(await run(ownerB, async () => { const { prisma } = await import("@/lib/db"); return prisma.telephonySwitchLog.count({ where: { businessId: a.business.id } }); })).toBe(0);
    await finish(inB);
  });
});
