import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { withBusiness } from '@/lib/tenant';
import type { SessionUser } from '@/lib/auth';
import type { Contact, Lead, Conversation } from '@/generated/prisma/client';
import { toSession } from '@/lib/auth-compat';
import { signSession } from '@/lib/auth';
import { createBusiness, destroyBusiness } from './helpers';
vi.mock('@/lib/events', async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
import { listLeads, listDeals, leadFilterSchema, dealFilterSchema, convertLead, createNote } from '@/lib/crm/pipeline';
import { contactTimeline } from '@/lib/crm/timeline';
import { getConversationForUser, listConversations } from '@/server/services/conversation-service';
import { updateContact, mergeContacts } from '@/lib/crm/contacts';
import { suppressContact } from '@/lib/suppression';
let a: Awaited<ReturnType<typeof createBusiness>>, b: typeof a;
let agent: SessionUser, other: SessionUser, c: Contact, lead: Lead, conv: Conversation;
const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
async function makeAgent(name: string) {
    const account = await db.account.create({ data: { email: `${name}-${a.business.id}@test.local`, fullName: name, passwordHash: 'test-only' } });
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: account.id, email: account.email, fullName: name, role: 'agent' } });
    return { ...u, sessionVersion: 0 };
}
beforeAll(async () => {
    a = await createBusiness('review-a');
    b = await createBusiness('review-b');
    agent = await makeAgent('agent');
    other = await makeAgent('other');
    c = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Secret Customer', phoneE164: '+972501234501', phoneRaw: '0501234501', ownerUserId: other.id } });
    lead = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: other.id, title: 'Restricted Lead' } });
    await db.deal.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: other.id, title: 'Restricted Deal', amount: 9000 } });
    conv = await db.conversation.create({ data: { businessId: a.business.id, contactId: c.id, assignedAgentId: other.id } });
    await db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, direction: 'INBOUND', body: 'PRIVATE MESSAGE', type: 'TEXT', status: 'SENT' } });
});
afterAll(async () => {
    await destroyBusiness(a.business.id, [a.account.id, agent.accountId, other.accountId]);
    await destroyBusiness(b.business.id, [b.account.id]);
    await db.$disconnect();
});
it('R01: searching leads must preserve agent visibility', async () => {
    const base = await run(agent, () => listLeads(agent, leadFilterSchema.parse({})));
    expect(base.items.some((x) => x.id === lead.id)).toBe(false);
    const searched = await run(agent, () => listLeads(agent, leadFilterSchema.parse({ q: 'Restricted' })));
    expect(searched.items.some((x) => x.id === lead.id)).toBe(false);
});
it('R02: searching deals must preserve agent visibility', async () => {
    const result = await run(agent, () => listDeals(agent, dealFilterSchema.parse({ q: 'Restricted' })));
    expect(result.items).toHaveLength(0);
});
it('R03: contact timeline must not expose a denied conversation', async () => {
    const denied = await run(agent, () => getConversationForUser(toSession(agent), conv.id));
    expect(denied).toBeNull();
    const timeline = await run(agent, () => contactTimeline(agent, c.id));
    expect(timeline.some((x) => x.body === 'PRIVATE MESSAGE')).toBe(false);
});
it('R04: agent must not convert another agents lead', async () => {
    await expect(run(agent, () => convertLead(agent, lead.id, {}))).rejects.toMatchObject({ status: 403 });
});
it('R05: note must not reference another business conversation', async () => {
    const bc = await db.contact.create({ data: { businessId: b.business.id, fullName: 'B', phoneE164: '+972501234502', phoneRaw: '0501234502' } });
    const bv = await db.conversation.create({ data: { businessId: b.business.id, contactId: bc.id } });
    await expect(run(agent, () => createNote(agent, { contactId: c.id, conversationId: bv.id, body: 'CROSS TENANT INJECTION' }))).rejects.toThrow();
});
it('R06: text conversation search must exclude unmatched phone numbers', async () => {
    const result = await run(a.session, () => listConversations(toSession(a.session), { search: 'NO_SUCH_TEXT_XYZ' }));
    expect(result).toHaveLength(0);
});
it('R07: CRM module disabled must reject lead API', async () => {
    await db.business.update({ where: { id: a.business.id }, data: { modules: { crm: false } } });
    const { invalidateEntitlements } = await import('@/lib/modules');
    invalidateEntitlements(a.business.id);
    const { GET } = await import('@/app/api/leads/route');
    const token = await signSession(agent);
    const res = await GET(new NextRequest('http://localhost/api/leads', { headers: { cookie: `ultracrm_session=${token}` } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    await db.business.update({ where: { id: a.business.id }, data: { modules: { crm: true } } });
    invalidateEntitlements(a.business.id);
});
it('R08: OPTED_OUT plus isBlocked false must preserve marketing suppression', async () => {
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c.id, scope: 'marketing', source: 'manual', reason: 'stop' }));
    await run(a.session, () => updateContact(a.session, c.id, { consentStatus: 'OPTED_OUT', isBlocked: false, consentEvidence: 'keep opted out' }));
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).consentStatus).toBe('OPTED_OUT');
});
it('R09: merging two contacts with same-agent drafts must succeed', async () => {
    const d = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Duplicate', phoneE164: '+972501234503', phoneRaw: '0501234503' } });
    await db.noteDraft.createMany({ data: [c, d].map(x => ({ businessId: a.business.id, userId: agent.id, contactId: x.id, body: 'draft' })) });
    await expect(run(a.session, () => mergeContacts(a.session, c.id, d.id))).resolves.toMatchObject({ id: c.id });
});
it('R10: updateContact must return the saved consent state', async () => {
    const d = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Fresh', phoneE164: '+972501234504', phoneRaw: '0501234504' } });
    const updated = await run(a.session, () => updateContact(a.session, d.id, { consentStatus: 'OPTED_IN' }));
    const saved = await db.contact.findUniqueOrThrow({ where: { id: d.id } });
    expect(saved.consentStatus).toBe('OPTED_IN');
    expect(updated.consentStatus).toBe(saved.consentStatus);
});
it('R11: lead detail must not bypass the list visibility rule', async () => {
    const { GET } = await import('@/app/api/leads/[id]/route');
    const token = await signSession(agent);
    const res = await GET(new NextRequest(`http://localhost/api/leads/${lead.id}`, { headers: { cookie: `ultracrm_session=${token}` } }), { params: Promise.resolve({ id: lead.id }) });
    expect([403, 404]).toContain(res.status);
});
it('R12: importing a new contact must not duplicate another contacts email', async () => {
    const { importContacts } = await import('@/lib/crm/contacts');
    await db.contact.update({ where: { id: c.id }, data: { email: 'unique-review@example.test' } });
    const result = await run(a.session, () => importContacts(a.session, [{ fullName: 'Imported', phone: '0501234505', email: 'unique-review@example.test' }]));
    expect(result.created).toBe(0);
    expect(await db.contact.count({ where: { businessId: a.business.id, email: 'unique-review@example.test' } })).toBe(1);
});
it('R13: concurrent conversions must create only one deal for a lead', async () => {
    const fresh = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, title: 'Race', ownerUserId: a.user.id } });
    await Promise.all([run(a.session, () => convertLead(a.session, fresh.id, {})), run(a.session, () => convertLead(a.session, fresh.id, {}))]);
    expect(await db.deal.count({ where: { leadId: fresh.id } })).toBe(1);
});
it('R14: saving call outcome with a new email must clear the old hard bounce', async () => {
    process.env.TELEPHONY_PROVIDER = 'mock';
    const { saveOutcome } = await import('@/lib/dialer/calls');
    const d = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Bounced', phoneE164: '+972501234506', phoneRaw: '0501234506', email: 'old@example.test', emailStatus: 'hard_bounce', emailBouncedAt: new Date() } });
    const call = await db.call.create({ data: { businessId: a.business.id, userId: agent.id, contactId: d.id, mode: 'manual', provider: 'mock', idempotencyKey: `review-outcome:${d.id}`, toE164: d.phoneE164, fromE164: '+972501110000', status: 'ended', endedAt: new Date(), telephonyResult: 'answered' } });
    await run(agent, () => saveOutcome(agent, { callId: call.id, outcome: 'answered_interested', contactUpdates: { email: 'new@example.test' } }));
    const saved = await db.contact.findUniqueOrThrow({ where: { id: d.id } });
    expect(saved.email).toBe('new@example.test');
    expect(saved.emailStatus).toBeNull();
});
it('R15: authorized conversion remains available and idempotent', async () => {
    const own = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: agent.id, title: 'Own lead' } });
    const first = await run(agent, () => convertLead(agent, own.id, { amount: 250 }));
    const again = await run(agent, () => convertLead(agent, own.id, { amount: 999 }));
    expect(again.id).toBe(first.id);
    expect(Number(again.amount)).toBe(250);
});
it('R16: notes accept an authorized conversation but reject mismatched contacts', async () => {
    const ownConversation = await db.conversation.create({ data: { businessId: a.business.id, contactId: c.id, assignedAgentId: agent.id } });
    const note = await run(agent, () => createNote(agent, { contactId: c.id, conversationId: ownConversation.id, body: 'Allowed' }));
    expect(note.conversationId).toBe(ownConversation.id);
    const d = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Unrelated', phoneE164: '+972501234507', phoneRaw: '0501234507' } });
    await expect(run(a.session, () => createNote(a.session, { contactId: d.id, conversationId: ownConversation.id, body: 'Wrong contact' }))).rejects.toMatchObject({ status: 404 });
});
it('R17: removing a full block preserves opt-out until explicit re-consent', async () => {
    const { sendBlockReason, callBlockReason } = await import('@/lib/suppression');
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c.id, scope: 'all', source: 'manual' }));
    const unblocked = await run(a.session, () => updateContact(a.session, c.id, { isBlocked: false, consentEvidence: 'Customer permits service only' }));
    expect(unblocked).toMatchObject({ isBlocked: false, consentStatus: 'OPTED_OUT' });
    expect(await run(a.session, () => sendBlockReason(a.business.id, c.id, 'service'))).toBeNull();
    expect(await run(a.session, () => callBlockReason(a.business.id, c.phoneE164))).toBeNull();
    expect(await run(a.session, () => sendBlockReason(a.business.id, c.id, 'marketing'))).not.toBeNull();
    const optedIn = await run(a.session, () => updateContact(a.session, c.id, { consentStatus: 'OPTED_IN', consentEvidence: 'Explicit marketing opt-in' }));
    expect(optedIn.consentStatus).toBe('OPTED_IN');
    expect(await run(a.session, () => sendBlockReason(a.business.id, c.id, 'marketing'))).toBeNull();
});
it('R18: a rejected consent change rolls back other contact fields', async () => {
    await run(a.session, () => suppressContact({ businessId: a.business.id, contactId: c.id, scope: 'marketing', source: 'manual' }));
    const before = await db.contact.findUniqueOrThrow({ where: { id: c.id } });
    await expect(run(a.session, () => updateContact(a.session, c.id, { fullName: 'Must not persist', consentStatus: 'OPTED_IN' }))).rejects.toMatchObject({ code: 'evidence_required' });
    expect(await db.contact.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ fullName: before.fullName, consentStatus: 'OPTED_OUT' });
});
it('R19: detail APIs and contact cards do not expose another agents deal or private notes', async () => {
    const hiddenDeal = await db.deal.findFirstOrThrow({ where: { contactId: c.id, ownerUserId: other.id } });
    await run(a.session, () => createNote(a.session, { contactId: c.id, conversationId: conv.id, body: 'PRIVATE NOTE' }));
    const token = await signSession(agent);
    const headers = { cookie: `ultracrm_session=${token}` };
    const { GET: getDeal } = await import('@/app/api/deals/[id]/route');
    expect((await getDeal(new NextRequest(`http://localhost/api/deals/${hiddenDeal.id}`, { headers }), { params: Promise.resolve({ id: hiddenDeal.id }) })).status).toBe(404);
    const { GET: getCard } = await import('@/app/api/contacts/[id]/route');
    const response = await getCard(new NextRequest(`http://localhost/api/contacts/${c.id}`, { headers }), { params: Promise.resolve({ id: c.id }) });
    const card = (await response.json()).data;
    expect(card.deals.some((deal: {
        id: string;
    }) => deal.id === hiddenDeal.id)).toBe(false);
    expect(card.noteItems.some((note: {
        body: string;
    }) => note.body === 'PRIVATE NOTE')).toBe(false);
});
it('R20: a search with no digits really filters lead names', async () => {
    const found = await run(a.session, () => listLeads(a.session, leadFilterSchema.parse({ q: 'NO_SUCH_TEXT_XYZ' })));
    expect(found.total).toBe(0);
});
