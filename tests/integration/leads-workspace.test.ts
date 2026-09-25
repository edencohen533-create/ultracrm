import { beforeAll, afterAll, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { withBusiness } from '@/lib/tenant';
import { listLeads, leadFilterSchema } from '@/lib/crm/pipeline';
import { createBusiness, destroyBusiness } from './helpers';
import type { SessionUser } from '@/lib/auth';
let a: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser, accountId: string;
const run = (filters: Record<string, unknown>, user = a.session) => withBusiness(a.business.id, () => listLeads(user, leadFilterSchema.parse(filters)), user);
beforeAll(async () => {
  a = await createBusiness('leads-workspace');
  const account = await db.account.create({ data: { email: `${a.business.id}@workspace.test`, fullName: 'Agent', passwordHash: 'test' } }); accountId = account.id;
  agent = await db.user.create({ data: { businessId: a.business.id, accountId, email: account.email, fullName: 'Agent', role: 'agent' } });
  for (let i = 0; i < 3; i++) {
    const contact = await db.contact.create({ data: { businessId: a.business.id, fullName: ['Alpha','Beta','Private'][i], phoneE164: `+97250123480${i}`, phoneRaw: `050123480${i}`, email: `lead${i}@workspace.test`, customFields: { product: i === 0 ? 'Vitamin' : 'Collagen', campaign: 'Summer', ad: `Ad ${i}` } } });
    const lead = await db.lead.create({ data: { businessId: a.business.id, contactId: contact.id, source: i === 0 ? 'facebook' : 'tiktok', ownerUserId: i === 2 ? a.user.id : agent.id, createdAt: new Date(`2026-09-${10+i}T12:00:00Z`) } });
    await db.deal.create({ data: { businessId: a.business.id, contactId: contact.id, leadId: lead.id, title: 'Won deal', status: 'won', stage: 'won', amount: (i + 1) * 100, ownerUserId: lead.ownerUserId } });
  }
});
afterAll(async () => { if (a) await destroyBusiness(a.business.id, [a.account.id, accountId]); });
it('filters source metadata and dates on the server', async () => {
  const result = await run({ source: 'facebook', product: 'vitamin', campaign: 'summer', ad: 'Ad 0', createdFrom: '2026-09-10T00:00:00Z', createdTo: '2026-09-11T00:00:00Z' });
  expect(result.total).toBe(1); expect(result.items[0].contact.fullName).toBe('Alpha');
  expect(result.metrics).toMatchObject({ leads: 1, deals: 1, revenue: 100, conversion: 100 });
});
it('searches email and excludes the upper date boundary', async () => {
  expect((await run({ q: 'lead1@workspace.test' })).items[0].contact.fullName).toBe('Beta');
  expect((await run({ createdTo: '2026-09-10T12:00:00Z' })).total).toBe(0);
});
it('keeps metrics and distribution scoped across pagination', async () => {
  const result = await run({ limit: 1, sort: 'name', direction: 'desc' }, agent);
  expect(result.items).toHaveLength(1); expect(result.items[0].contact.fullName).toBe('Beta');
  expect(result.metrics).toMatchObject({ leads: 2, deals: 2, revenue: 300 });
  expect(result.byOwner).toEqual([{ id: agent.id, name: agent.fullName, count: 2 }]);
  expect((await run({ q: 'Private' }, agent)).metrics.leads).toBe(0);
});
it('supports unassigned filtering without exposing another owners data', async () => {
  expect((await run({ ownerUserId: 'unassigned' }, agent)).total).toBe(0);
  expect((await run({ ownerUserId: a.user.id }, agent)).metrics.revenue).toBe(0);
});
