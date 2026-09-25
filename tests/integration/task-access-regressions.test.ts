import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { db } from '@/lib/db';
import { withBusiness } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';
import { createBusiness, destroyBusiness } from './helpers';
import { createTask, updateTask } from '@/lib/crm/pipeline';
import { importContacts } from '@/lib/crm/contacts';
vi.mock('@/lib/events', async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
let tenant: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser, manager: SessionUser;
const accounts: string[] = [];
let contactId: string, leadId: string, dealId: string, conversationId: string;
const run = <T,>(user: SessionUser, fn: () => Promise<T>) => withBusiness(user.businessId, fn, user);
const input = () => ({ contactId, dueAt: new Date().toISOString(), title: 'QA task' });
beforeAll(async () => {
  tenant = await createBusiness('task-access');
  async function member(role: 'agent' | 'manager') {
    const account = await db.account.create({ data: { email: `${role}-${tenant.business.id}@test.local`, fullName: role, passwordHash: 'test' } });
    accounts.push(account.id);
    return db.user.create({ data: { businessId: tenant.business.id, accountId: account.id, email: account.email, fullName: role, role } });
  }
  agent = await member('agent'); manager = await member('manager');
  const contact = await db.contact.create({ data: { businessId: tenant.business.id, fullName: 'Task contact', phoneE164: '+972501239901', phoneRaw: '0501239901' } });
  contactId = contact.id;
  leadId = (await db.lead.create({ data: { businessId: tenant.business.id, contactId, ownerUserId: tenant.user.id, title: 'Private lead' } })).id;
  dealId = (await db.deal.create({ data: { businessId: tenant.business.id, contactId, ownerUserId: tenant.user.id, title: 'Private deal' } })).id;
  conversationId = (await db.conversation.create({ data: { businessId: tenant.business.id, contactId, assignedAgentId: tenant.user.id } })).id;
});
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id, ...accounts]); });
it.each(['leadId', 'dealId', 'conversationId'] as const)('rejects task linked to inaccessible %s', async field => {
  const ids = { leadId, dealId, conversationId };
  await expect(run(agent, () => createTask(agent, { ...input(), [field]: ids[field] }))).rejects.toMatchObject({ status: 404 });
});
it('does not reveal another users task through requestKey replay', async () => {
  const requestKey = 'private-task-request';
  await run(tenant.session, () => createTask(tenant.session, { ...input(), requestKey, note: 'Private task body' }));
  await expect(run(agent, () => createTask(agent, { ...input(), requestKey }))).rejects.toMatchObject({ status: 403 });
});
it('manager cannot create tasks assigned outside their teams', async () => {
  await expect(run(manager, () => createTask(manager, { ...input(), userId: agent.id }))).rejects.toMatchObject({ status: 403 });
});
it('manager cannot reassign their task outside their teams', async () => {
  const task = await run(manager, () => createTask(manager, input()));
  await expect(run(manager, () => updateTask(manager, task.id, { assignedToId: agent.id }))).rejects.toMatchObject({ status: 403 });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).userId).toBe(manager.id);
});
it('allows own task replay and owner-authorized links', async () => {
  const task = await run(tenant.session, () => createTask(tenant.session, { ...input(), leadId, dealId, conversationId, requestKey: 'allowed-task-request' }));
  const repeat = await run(tenant.session, () => createTask(tenant.session, { ...input(), requestKey: 'allowed-task-request' }));
  expect(repeat.id).toBe(task.id);
});
it('import clears an old bounce when the primary email changes', async () => {
  await db.contact.update({ where: { id: contactId }, data: { email: 'old@test.local', emailStatus: 'hard_bounce', emailBouncedAt: new Date() } });
  await run(tenant.session, () => importContacts(tenant.session, [{ fullName: 'Task contact', phone: '+972501239901', email: 'new@test.local' }]));
  expect(await db.contact.findUniqueOrThrow({ where: { id: contactId } })).toMatchObject({ email: 'new@test.local', emailStatus: null, emailBouncedAt: null });
});
it('import preserves a bounce when the email stays the same', async () => {
  await db.contact.update({ where: { id: contactId }, data: { email: 'same@test.local', emailStatus: 'hard_bounce', emailBouncedAt: new Date() } });
  await run(tenant.session, () => importContacts(tenant.session, [{ fullName: 'Task contact', phone: '+972501239901', email: 'same@test.local' }]));
  expect((await db.contact.findUniqueOrThrow({ where: { id: contactId } })).emailStatus).toBe('hard_bounce');
});
