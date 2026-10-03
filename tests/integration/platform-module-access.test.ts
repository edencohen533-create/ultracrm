import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { applyEntitlementChange, computeImpact, savePlan, setUserPermissions } from '@/lib/access/manage';
import { assertAccess, businessEntitlement, invalidateEntitlement } from '@/lib/access/engine';
import { MODULES } from '@/lib/access/catalog';
import { createBusiness, destroyBusiness } from './helpers';
import { signSession, type SessionUser } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { GET as meGET } from '@/app/api/auth/me/route';
import { PUT as permissionsPUT } from '@/app/api/platform/businesses/[id]/users/[userId]/route';
let agentAccountId: string;
let agentCookie: string;
const request = (cookie: string, method = 'GET', body?: unknown) => new NextRequest('http://localhost/api/test', { method, headers: { cookie, origin: 'http://localhost', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
let business: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser;
const planIds: string[] = [];
beforeAll(async () => {
  business = await createBusiness('module-access', { modules: Object.fromEntries(MODULES.map(m => [m, true])) });
  await db.account.update({ where: { id: business.account.id }, data: { isPlatformAdmin: true } });
  const account = await db.account.create({ data: { email: `${business.business.slug}-agent@test.local`, fullName: 'QA agent', passwordHash: 'unused-test-only' } }); agentAccountId = account.id;
  const row = await db.user.create({ data: { accountId: account.id, businessId: business.business.id, email: `${business.business.slug}-agent@test.local`, fullName: 'QA agent', role: 'agent', permissions: { template: 'custom', scope: 'own', modules: {} } } });
  agent = { ...business.session, id: row.id, accountId: account.id, email: account.email, role: 'agent' };
  agentCookie = `ultracrm_session=${await signSession(agent)}`;
});
afterAll(async () => {
  if (business) { await db.subscription.deleteMany({ where: { businessId: business.business.id } }); await destroyBusiness(business.business.id, [business.account.id, agentAccountId]); }
  await db.plan.deleteMany({ where: { id: { in: planIds } } });
});
it('each module grants and revokes real end-user access without a new session; ungranted actions stay forbidden', async () => {
  for (const module of MODULES) {
    await expect(assertAccess(agent, module)).rejects.toMatchObject({ status: 403 });
    const action = module === 'telephony' ? 'use' : 'view';
    // Catalog is authoritative (telephony has view as well, but use is its actual dialer entry action).
    const { ACTIONS } = await import('@/lib/access/catalog');
    const supportedAction = action in ACTIONS[module] ? action : Object.keys(ACTIONS[module])[0];
    const adminCookie = `ultracrm_session=${await signSession(business.session)}`;
    const ctx = { params: Promise.resolve({ id: business.business.id, userId: agent.id }) };
    expect((await permissionsPUT(request(adminCookie, 'PUT', { scope: 'own', modules: { [module]: { enabled: true, actions: [supportedAction] } } }), ctx)).status).toBe(200);
    const enabled = await meGET(request(agentCookie), { params: Promise.resolve({}) });
    expect(enabled.status).toBe(200); expect((await enabled.json()).data.access.modules[module].state).toBe('active');
    await expect(assertAccess(agent, `${module}.${supportedAction}` as never)).resolves.toBeDefined();
    const ungranted = Object.keys(ACTIONS[module]).find(x => x !== supportedAction);
    if (ungranted) await expect(assertAccess(agent, `${module}.${ungranted}` as never)).rejects.toMatchObject({ status: 403 });
    await setUserPermissions(business.session, agent.id, { scope: 'own', modules: { [module]: { enabled: false, actions: [supportedAction] } } }, { platform: true });
    await expect(assertAccess(agent, module)).rejects.toMatchObject({ status: 403 });
    const disabled = await meGET(request(agentCookie), { params: Promise.resolve({}) }); expect((await disabled.json()).data.access.modules[module].state).toBe('not_assigned');
  }
});
it('package removal blocks existing users and re-adding a package never silently re-grants them access', async () => {
  const on = await savePlan(business.session, { name: 'QA email on', modules: { email: { included: true, seats: null } } }); planIds.push(on.planId);
  const off = await savePlan(business.session, { name: 'QA email off', modules: {} }); planIds.push(off.planId);
  await applyEntitlementChange(business.session, business.business.id, { planVersionId: on.id });
  await setUserPermissions(business.session, agent.id, { scope: 'own', modules: { email: { enabled: true, actions: ['view'] } } }, { platform: true });
  await expect(assertAccess(agent, 'email.view')).resolves.toBeDefined();
  expect((await computeImpact(business.business.id, { planVersionId: off.id })).impact.modulesRemoved).toContain('email');
  await applyEntitlementChange(business.session, business.business.id, { planVersionId: off.id });
  await expect(assertAccess(agent, 'email.view')).rejects.toMatchObject({ status: 403 });
  await expect(setUserPermissions(business.session, agent.id, { scope: 'own', modules: { email: { enabled: true, actions: ['view'] } } }, { platform: true })).rejects.toMatchObject({ code: 'module_not_purchased' });
  await applyEntitlementChange(business.session, business.business.id, { planVersionId: on.id });
  await expect(assertAccess(agent, 'email.view')).rejects.toMatchObject({ status: 403 });
});
it('paid subscription impact matches actual access, grant revocation preserves purchased modules, and misleading package changes are rejected', async () => {
  await db.subscription.create({ data: { businessId: business.business.id, status: 'active', items: { create: { businessId: business.business.id, code: 'crm', module: 'crm', kind: 'per_business', quantity: 1, unitPriceMinor: 0 } } } }); invalidateEntitlement(business.business.id);
  const target = { addGrant: { module: 'sms' as const, kind: 'addon', seats: null, expiresAt: null } };
  const preview = await computeImpact(business.business.id, target);
  expect(preview.after.crm.included).toBe(true); expect(preview.after.email.included).toBe(false); expect(preview.after.sms.included).toBe(true);
  await applyEntitlementChange(business.session, business.business.id, target);
  const after = await businessEntitlement(business.business.id);
  for (const module of MODULES) expect(after.modules[module].included).toBe(preview.after[module].included);
  const grant = await db.entitlementGrant.findFirstOrThrow({ where: { businessId: business.business.id, module: 'sms', revokedAt: null } });
  await applyEntitlementChange(business.session, business.business.id, { revokeGrantId: grant.id });
  expect((await businessEntitlement(business.business.id)).modules.crm.included).toBe(true);
  expect((await businessEntitlement(business.business.id)).modules.sms.included).toBe(false);
  await expect(computeImpact(business.business.id, { planVersionId: null })).rejects.toMatchObject({ code: 'subscription_managed' });
});
