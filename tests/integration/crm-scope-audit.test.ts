import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { contactScope } from "@/lib/crm/access";
import { canAccessContact, waitingToday } from "@/lib/crm/lead-ops";
import { createDeal, createLead, createTask, convertLead, listTasks, taskFilterSchema, updateDeal, updateLead } from "@/lib/crm/pipeline";
import { createBusiness, destroyBusiness } from "./helpers";

vi.mock("@/lib/events", async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
let tenant: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser;
let agentAccount: string;
let privateContactId: string, ownContactId: string, poolLeadId: string, poolDealId: string;
const run = <T,>(user: SessionUser, fn: () => Promise<T>) => withBusiness(user.businessId, fn, user);

beforeAll(async () => {
  tenant = await createBusiness("crm-scope-audit");
  const account = await db.account.create({ data: { email: `scope-${tenant.business.id}@test.local`, fullName: "Agent", passwordHash: "test" } });
  agentAccount = account.id;
  agent = await db.user.create({ data: { businessId: tenant.business.id, accountId: account.id, email: account.email, fullName: account.fullName, role: "agent" } });
  const contact = (phone: string, ownerUserId: string | null) => db.contact.create({ data: { businessId: tenant.business.id, fullName: "Scope test", phoneE164: phone, phoneRaw: phone, ownerUserId } });
  privateContactId = (await contact("+972509881001", tenant.user.id)).id;
  ownContactId = (await contact("+972509881002", agent.id)).id;
  const pool = await contact("+972509881003", null);
  poolLeadId = (await db.lead.create({ data: { businessId: tenant.business.id, contactId: pool.id } })).id;
  poolDealId = (await db.deal.create({ data: { businessId: tenant.business.id, contactId: pool.id, title: "Hidden pool deal" } })).id;
});
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id, agentAccount]); });

it("denies updating an unassigned lead when the shared pool is hidden", async () => {
  await expect(run(agent, () => updateLead(agent, poolLeadId, { title: "Unauthorized" }))).rejects.toMatchObject({ status: 403 });
  expect((await db.lead.findUniqueOrThrow({ where: { id: poolLeadId } })).title).toBeNull();
});
it("denies converting an unassigned lead when the shared pool is hidden", async () => {
  await expect(run(agent, () => convertLead(agent, poolLeadId, {}))).rejects.toMatchObject({ status: 403 });
});
it("denies updating an unassigned deal when the shared pool is hidden", async () => {
  await expect(run(agent, () => updateDeal(agent, poolDealId, { amount: 99 }))).rejects.toMatchObject({ status: 403 });
});
it("excludes hidden pool leads from the waiting-for-a-call dashboard", async () => {
  // Restore status independently so an earlier regression cannot hide this one.
  await db.lead.update({ where: { id: poolLeadId }, data: { status: "new" } });
  const result = await run(agent, () => waitingToday(agent));
  expect(result.ids.total).not.toContain(poolLeadId);
  expect(result.counts.unassigned).toBe(0);
});
it.each(["lead", "deal", "task"] as const)("cannot create a %s on another agent's private contact", async (kind) => {
  const action = (): Promise<unknown> => kind === "lead" ? createLead(agent, { contactId: privateContactId, ownerUserId: agent.id })
    : kind === "deal" ? createDeal(agent, { contactId: privateContactId, title: "Unauthorized" })
    : createTask(agent, { contactId: privateContactId, dueAt: new Date().toISOString() });
  await expect(run(agent, action)).rejects.toMatchObject({ status: 404 });
});
it.each(["lead", "deal"] as const)("cannot assign a new %s outside the allowed user scope", async (kind) => {
  const action = (): Promise<unknown> => kind === "lead" ? createLead(agent, { contactId: ownContactId, ownerUserId: tenant.user.id })
    : createDeal(agent, { contactId: ownContactId, title: "Unauthorized assignment", ownerUserId: tenant.user.id });
  await expect(run(agent, action)).rejects.toMatchObject({ status: 403 });
});
it("cannot reassign an owned deal outside the allowed user scope", async () => {
  const deal = await db.deal.create({ data: { businessId: tenant.business.id, contactId: ownContactId, ownerUserId: agent.id, title: "Own deal" } });
  await expect(run(agent, () => updateDeal(agent, deal.id, { ownerUserId: tenant.user.id }))).rejects.toMatchObject({ status: 403 });
});
it("contact list/export visibility matches the detail guard for the shared pool", async () => {
  await db.business.update({ where: { id: tenant.business.id }, data: { settings: { permissions: { agentSeesUnassigned: true } } } });
  const c = await db.contact.create({ data: { businessId: tenant.business.id, fullName: "Other agent's lead", phoneE164: "+972509881004", phoneRaw: "x" } });
  await db.lead.create({ data: { businessId: tenant.business.id, contactId: c.id, ownerUserId: tenant.user.id } });
  expect(await run(agent, () => canAccessContact(agent, c))).toBe(false);
  const rows = await db.contact.findMany({ where: { businessId: tenant.business.id, ...contactScope(await visibleUserIds(agent)) } });
  expect(rows.map((x) => x.id)).not.toContain(c.id);
  expect(rows.map((x) => x.id)).toContain(ownContactId);
});
it("still permits explicitly enabled pool access and creation on owned contacts", async () => {
  await expect(run(agent, () => updateLead(agent, poolLeadId, { title: "Allowed" }))).resolves.toMatchObject({ title: "Allowed" });
  await expect(run(agent, () => createLead(agent, { contactId: ownContactId, ownerUserId: agent.id }))).resolves.toMatchObject({ ownerUserId: agent.id });
});

it("conversation task lists include only that conversation and its contact's unlinked tasks", async () => {
  const conversation = await db.conversation.create({ data: { businessId: tenant.business.id, contactId: ownContactId, assignedAgentId: agent.id } });
  const otherConversation = await db.conversation.create({ data: { businessId: tenant.business.id, contactId: ownContactId, assignedAgentId: agent.id } });
  const makeTask = (contactId: string, conversationId: string | null) => db.task.create({ data: { businessId: tenant.business.id, userId: agent.id, contactId, conversationId, dueAt: new Date() } });
  const linked = await makeTask(ownContactId, conversation.id);
  const unlinked = await makeTask(ownContactId, null);
  const other = await makeTask(privateContactId, null);
  const otherLinked = await makeTask(ownContactId, otherConversation.id);
  const result = await run(agent, () => listTasks(agent, taskFilterSchema.parse({ conversationId: conversation.id })));
  expect(result.items.map((x) => x.id)).toEqual(expect.arrayContaining([linked.id, unlinked.id]));
  expect(result.items.map((x) => x.id)).not.toContain(other.id);
  expect(result.items.map((x) => x.id)).not.toContain(otherLinked.id);
});
it("rejects a task-list request for an inaccessible conversation", async () => {
  const conversation = await db.conversation.create({ data: { businessId: tenant.business.id, contactId: privateContactId, assignedAgentId: tenant.user.id } });
  await expect(run(agent, () => listTasks(agent, taskFilterSchema.parse({ conversationId: conversation.id })))).rejects.toMatchObject({ status: 404 });
});

it("permits a task on an explicitly accessible conversation even without CRM contact access", async () => {
  const conversation = await db.conversation.create({ data: { businessId: tenant.business.id, contactId: privateContactId, assignedAgentId: agent.id } });
  await expect(run(agent, () => createTask(agent, { contactId: privateContactId, conversationId: conversation.id, dueAt: new Date().toISOString() }))).resolves.toMatchObject({ conversationId: conversation.id, userId: agent.id });
});
