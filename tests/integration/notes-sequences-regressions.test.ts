import { beforeAll, afterAll, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { signSession } from '@/lib/auth';
import { withBusiness } from '@/lib/tenant';
import { createBusiness, destroyBusiness } from './helpers';
import { saveSequence, sequenceSchema, processDueSequenceRuns } from '@/server/services/sequence-service';
import { POST } from '@/app/api/conversations/[id]/notes/route';
let a: Awaited<ReturnType<typeof createBusiness>>, b: typeof a;
let conversationId: string;
beforeAll(async () => {
  a = await createBusiness('notes-seq-a'); b = await createBusiness('notes-seq-b');
  const contact = await db.contact.create({ data: { businessId: a.business.id, fullName: 'Notes QA', phoneE164: '+972501238001', phoneRaw: '0501238001' } });
  conversationId = (await db.conversation.create({ data: { businessId: a.business.id, contactId: contact.id } })).id;
});
afterAll(async () => {
  if (a) await destroyBusiness(a.business.id, [a.account.id]);
  if (b) await destroyBusiness(b.business.id, [b.account.id]);
});
async function note(user: typeof a.session, body = 'Saved QA note') {
  const token = await signSession(user);
  return POST(new NextRequest(`http://localhost/api/conversations/${conversationId}/notes`, { method: 'POST', headers: { cookie: `ultracrm_session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }), { params: Promise.resolve({ id: conversationId }) });
}
it('saves an authorized conversation note and its audit record', async () => {
  const response = await note(a.session);
  expect(response.status).toBe(201);
  const { note: saved } = await response.json();
  expect(await db.note.findUnique({ where: { id: saved.id } })).toMatchObject({ body: 'Saved QA note', conversationId, businessId: a.business.id });
  expect(await db.auditLog.count({ where: { entityId: saved.id, action: 'note.created' } })).toBe(1);
});
it('rejects cross-business conversation notes without a server error', async () => {
  expect((await note(b.session)).status).toBe(404);
  expect(await db.note.count({ where: { businessId: b.business.id } })).toBe(0);
});
const taskSequence = (templateId?: string) => sequenceSchema.parse({ name: 'Task only', trigger: 'CONTACT_CREATED', steps: [{ action: 'task', channel: 'sms', waitMinutes: 0, taskTitle: 'Follow up', templateId }] });
it('creates task-only sequences without requiring any message templates', async () => {
  const input = taskSequence();
  const seq = await withBusiness(a.business.id, () => saveSequence(a.session, input), a.session);
  const step = await db.sequenceStep.findFirstOrThrow({ where: { sequenceId: seq.id } });
  expect(step.templateId).toBeNull();
  expect(input.steps[0].templateId).toBeUndefined();
});
it('never links a task step to a template from another business', async () => {
  const template = await db.template.create({ data: { businessId: b.business.id, name: 'Foreign', body: 'Private', channel: 'sms', status: 'APPROVED', category: 'MARKETING' } });
  const seq = await withBusiness(a.business.id, () => saveSequence(a.session, taskSequence(template.id)), a.session);
  expect((await db.sequenceStep.findFirstOrThrow({ where: { sequenceId: seq.id } })).templateId).toBeNull();
});
it('still rejects sending steps without a template', () => {
  expect(sequenceSchema.safeParse({ name: 'Invalid', trigger: 'CONTACT_CREATED', steps: [{ action: 'send', channel: 'sms', waitMinutes: 0 }] }).success).toBe(false);
});

it('executes a task-only sequence once without a template or messaging provider', async () => {
  await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } } } } });
  const seq = await withBusiness(a.business.id, () => saveSequence(a.session, taskSequence()), a.session);
  const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const run = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId: conversation.contactId, sourceKey: 'qa-task-only', nextAt: new Date(0) } });
  await withBusiness(a.business.id, () => processDueSequenceRuns(), a.session);
  await withBusiness(a.business.id, () => processDueSequenceRuns(), a.session);
  expect((await db.sequenceRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('COMPLETED');
  expect(await db.task.count({ where: { businessId: a.business.id, requestKey: `seq:${run.id}:0` } })).toBe(1);
});
