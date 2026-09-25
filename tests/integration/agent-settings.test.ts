import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { settingsOverview, saveAgentSettings, getAgentSettings } from "@/lib/agent-settings";
import { DEFAULT_AGENT_SETTINGS, retryRule, agentSettingsSchema } from "@/lib/agent-settings-schema";
import { claimNextLead, releaseLead, applyOutcomeToLead } from "@/lib/dialer/queue";
import { saveOutcome } from "@/lib/dialer/calls";
import { selectOutboundNumber } from "@/lib/numbers/selection";
import type { SessionUser } from "@/lib/auth";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/auth";
import { GET, POST } from "@/app/api/crm-settings/follow-ups/route";
let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser, peer: SessionUser, listId: string, oldId: string, newId: string, phone: string;
let nums: string[];
const run = <T,>(fn: () => Promise<T>, user = a.session) => withBusiness(user.businessId, fn, user);
const prefs = (extra = {}) => ({ ...structuredClone(DEFAULT_AGENT_SETTINGS), ...extra });
beforeAll(async () => {
  a = await createBusiness("agent-settings"); b = await createBusiness("agent-settings-other");
  const team = await db.team.create({ data: { businessId: a.business.id, name: "Team", managerId: a.user.id } });
  const users = [];
  for (const name of ["Agent", "Peer"]) {
    const account = await db.account.create({ data: { email: `${name}-${a.business.id}@test.local`, fullName: name, passwordHash: "x" } });
    users.push(await db.user.create({ data: { businessId: a.business.id, accountId: account.id, email: account.email, fullName: name, role: "agent", teamId: team.id } }));
  }
  [agent, peer] = users;
  listId = (await db.dialList.create({ data: { businessId: a.business.id, name: "Shared", maxAttempts: 10, retryIntervalMinutes: 1 } })).id;
  const leads = [];
  for (let i = 0; i < 2; i++) {
    const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `Lead ${i}`, phoneE164: `+97250100000${i}`, phoneRaw: `050100000${i}` } });
    leads.push(await db.listLead.create({ data: { businessId: a.business.id, listId, contactId: c.id, createdAt: new Date(Date.now() - (2 - i) * 86400_000) } }));
    if (i === 1) phone = c.phoneE164;
  }
  [oldId, newId] = leads.map(l => l.id);
  nums = [];
  for (let i = 0; i < 3; i++) nums.push((await db.phoneNumber.create({ data: { businessId: a.business.id, e164: `+97273388800${i}`, provider: "mock", assignedUserId: i === 2 ? peer.id : null } })).id);
});
beforeEach(async () => {
  await db.call.deleteMany({ where: { businessId: a.business.id } });
  await db.listLead.updateMany({ where: { listId }, data: { status: "pending", attempts: 0, followUpAttempts: null, nextAttemptAt: null, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null } });
  await db.user.updateMany({ where: { businessId: a.business.id }, data: { crmSettings: prefs() } });
});
afterAll(async () => { if (a) await destroyBusiness(a.business.id, [a.account.id, agent.accountId, peer.accountId]); if (b) await destroyBusiness(b.business.id, [b.account.id]); });
it("agent edits self; owner edits agent; other agents and tenants remain inaccessible", async () => {
  await run(() => saveAgentSettings(agent, agent.id, prefs({ rotateAfter: 4 })), agent);
  expect((await run(() => getAgentSettings(a.business.id, agent.id)))?.rotateAfter).toBe(4);
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ rotateAfter: 5 })));
  expect((await run(() => getAgentSettings(a.business.id, agent.id)))?.rotateAfter).toBe(5);
  await expect(run(() => saveAgentSettings(agent, peer.id, prefs()), agent)).rejects.toMatchObject({ status: 403 });
  await expect(run(() => settingsOverview(a.session, b.user.id))).rejects.toMatchObject({ status: 404 });
  expect((await run(() => getAgentSettings(a.business.id, peer.id)))?.rotateAfter).toBe(2);
});
it("rejects numbers assigned elsewhere and invalid retry ranges", async () => {
  await expect(run(() => saveAgentSettings(agent, agent.id, prefs({ numbers: [{ id: nums[2], enabled: true }] })), agent)).rejects.toMatchObject({ code: "invalid_number" });
  expect(agentSettingsSchema.safeParse(prefs({ newLead: [{ through: 5, delay: 2, unit: "hours" }, { through: 4, delay: 1, unit: "days" }] })).success).toBe(false);
  expect(retryRule(prefs(), false, 4).minutes).toBe(120);
  expect(retryRule(prefs(), false, 5).minutes).toBe(1440);
});
it("selects actual queue leads in the agent's chosen order", async () => {
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ strategy: "oldest" })));
  const first = await run(() => claimNextLead(a.business.id, agent.id, listId)); expect(first?.id).toBe(oldId);
  await run(() => releaseLead(agent.id, oldId, "test"));
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ strategy: "new_first" })));
  expect((await run(() => claimNextLead(a.business.id, agent.id, listId)))?.id).toBe(newId);
});
it("daily unanswered cap is shared across agents for the same destination", async () => {
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ strategy: "new_first", maxDailyUnanswered: 1 })));
  await db.call.create({ data: { businessId: a.business.id, userId: peer.id, mode: "power", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: phone, fromE164: "x", status: "ended", telephonyResult: "no_answer", endedAt: new Date(), outcomeSavedAt: new Date() } });
  expect((await run(() => claimNextLead(a.business.id, agent.id, listId)))?.id).toBe(oldId);
});
it("uses separate follow-up retries and stops at the configured final attempt", async () => {
  await db.listLead.update({ where: { id: newId }, data: { attempts: 6, followUpAttempts: 1 } });
  await run(() => applyOutcomeToLead({ businessId: a.business.id, userId: agent.id, leadId: newId, outcome: "no_answer" }));
  let l = await db.listLead.findUniqueOrThrow({ where: { id: newId } });
  expect(l.status).toBe("pending"); expect(l.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(119 * 60_000);
  await db.listLead.update({ where: { id: newId }, data: { followUpAttempts: 10 } });
  await run(() => applyOutcomeToLead({ businessId: a.business.id, userId: agent.id, leadId: newId, outcome: "no_answer" }));
  l = await db.listLead.findUniqueOrThrow({ where: { id: newId } }); expect(l.status).toBe("exhausted");
});
it("rotates after unanswered streak; respects explicit policy and disabled numbers", async () => {
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ numbers: nums.slice(0, 2).map(id => ({ id, enabled: true })), rotateAfter: 2, randomRotation: false })));
  const pick = (phoneNumberId?: string) => run(() => prisma.$transaction(tx => selectOutboundNumber(tx, { businessId: a.business.id, userId: agent.id, toE164: phone, simulation: true, phoneNumberId })));
  expect((await pick()).number.id).toBe(nums[0]);
  for (let i = 0; i < 2; i++) await db.call.create({ data: { businessId: a.business.id, userId: agent.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: phone, fromE164: "x", phoneNumberId: nums[0], status: "ended", telephonyResult: "no_answer", endedAt: new Date(), outcomeSavedAt: new Date() } });
  expect((await pick()).number.id).toBe(nums[1]); expect((await pick(nums[0])).number.id).toBe(nums[0]);
  await run(() => saveAgentSettings(a.session, agent.id, prefs({ numbers: nums.slice(0, 2).map(id => ({ id, enabled: false })) })));
  await expect(pick()).rejects.toMatchObject({ code: "no_eligible_number" });
});
it("manual follow-up take requires saved permission and updates the task atomically", async () => {
  await db.listLead.update({ where: { id: oldId }, data: { status: "callback", preferredUserId: peer.id, followUpAttempts: 0 } });
  const lead = await db.listLead.findUniqueOrThrow({ where: { id: oldId } });
  await db.task.create({ data: { businessId: a.business.id, userId: peer.id, contactId: lead.contactId, listLeadId: oldId, type: "callback", dueAt: new Date() } });
  const req = async (post = false) => new NextRequest("http://localhost/api/crm-settings/follow-ups", { method: post ? "POST" : "GET", headers: { cookie: `ultracrm_session=${await signSession(agent)}`, "Content-Type": "application/json" }, ...(post ? { body: JSON.stringify({ id: oldId }) } : {}) });
  const ctx = { params: Promise.resolve({}) };
  expect((await GET(await req(), ctx)).status).toBe(403);
  await run(() => saveAgentSettings(agent, agent.id, prefs({ takeFollowUps: true })), agent);
  expect((await POST(await req(true), ctx)).status).toBe(200);
  expect((await db.listLead.findUniqueOrThrow({ where: { id: oldId } })).preferredUserId).toBe(agent.id);
  expect((await db.task.findFirstOrThrow({ where: { listLeadId: oldId } })).userId).toBe(agent.id);
  expect((await POST(await req(true), ctx)).status).toBe(409);
});

it("callback assignment is enforced by the outcome service", async () => {
  const lead = await db.listLead.findUniqueOrThrow({ where: { id: newId } });
  const call = await db.call.create({ data: { businessId: a.business.id, userId: agent.id, contactId: lead.contactId, leadId: newId, listId, mode: "preview", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: phone, fromE164: "x", status: "ended", endedAt: new Date(), telephonyResult: "answered" } });
  const input = { callId: call.id, outcome: "callback" as const, callbackAt: new Date(Date.now() + 3600_000), callbackUserId: peer.id };
  await expect(run(() => saveOutcome(agent, input), agent)).rejects.toMatchObject({ status: 403 });
  expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).outcomeSavedAt).toBeNull();
  await run(() => saveAgentSettings(agent, agent.id, prefs({ assignFollowUps: true })), agent);
  await run(() => saveOutcome(agent, input), agent);
  expect((await db.task.findFirstOrThrow({ where: { callId: call.id } })).userId).toBe(peer.id);
  const updated = await db.listLead.findUniqueOrThrow({ where: { id: newId } });
  expect(updated.preferredUserId).toBe(peer.id); expect(updated.followUpAttempts).toBe(0);
});
it("manager can only change settings for their visible team", async () => {
  const manager = { ...peer, role: "manager" as const, teamId: null };
  await expect(run(() => saveAgentSettings(manager, agent.id, prefs()), manager)).rejects.toMatchObject({ status: 403 });
  await run(() => saveAgentSettings({ ...manager, teamId: agent.teamId }, agent.id, prefs({ rotateAfter: 7 })), { ...manager, teamId: agent.teamId });
  expect((await run(() => getAgentSettings(a.business.id, agent.id)))?.rotateAfter).toBe(7);
});

it("leaves legacy retry behavior unchanged until personal settings are saved", async () => {
  await db.user.update({ where: { id: agent.id }, data: { crmSettings: Prisma.DbNull } });
  await db.listLead.update({ where: { id: newId }, data: { attempts: 6, followUpAttempts: 1, preferredUserId: agent.id } });
  await run(() => applyOutcomeToLead({ businessId: a.business.id, userId: agent.id, leadId: newId, outcome: "no_answer" }));
  const lead = await db.listLead.findUniqueOrThrow({ where: { id: newId } });
  expect(lead.status).toBe("pending"); expect(lead.preferredUserId).toBeNull();
  expect(lead.nextAttemptAt!.getTime() - Date.now()).toBeLessThan(61_000);
});
