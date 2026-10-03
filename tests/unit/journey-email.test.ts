// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ message: vi.fn(), event: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { message: { findFirst: m.message }, domainEvent: { findFirst: m.event } } }));
vi.mock('@/lib/events', () => ({ MAX_AUTOMATION_DEPTH: 5 }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/suppression', () => ({ sendBlockReason: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getBusinessSettings: vi.fn(), isWithinDialWindow: vi.fn() }));
import { emailConditionState } from '@/server/automations/email-condition';
import { sequenceSchema } from '@/server/services/sequence-service';
import type { EmailCondition } from '@/lib/journey-email';
const run = { id: 'run', contactId: 'contact' };
const sent = { id: 'message', status: 'SENT', providerMessageId: 'resend-id', createdAt: new Date('2026-01-01T10:00:00.500Z'), acceptedAt: new Date('2026-01-01T10:00:01Z'), openedAt: null, clickedAt: null };
const condition: EmailCondition = { sourceStep: 0, event: 'clicked', timeoutMinutes: 60 };
const before = new Date('2026-01-01T10:30:00Z'), after = new Date('2026-01-01T11:01:00Z');
beforeEach(() => { vi.resetAllMocks(); m.message.mockResolvedValue(sent); m.event.mockResolvedValue(null); });
it.each(['clicked', 'opened', 'delivered', 'bounced', 'failed'] as const)('waits for %s then expires without a report', async event => {
  expect(await emailConditionState(run, { ...condition, event }, before)).toBe('waiting');
  expect(await emailConditionState(run, { ...condition, event }, after)).toBe('expired');
});
it.each([['clicked', 'clickedAt'], ['opened', 'openedAt'], ['delivered', 'deliveredAt'], ['bounced', 'bouncedAt'], ['failed', 'failedAt']] as const)('matches %s inside the window even when the worker runs late', async (event, key) => {
  m.message.mockResolvedValue({ ...sent, [key]: before });
  expect(await emailConditionState(run, { ...condition, event }, after)).toBe('matched');
  m.message.mockResolvedValue({ ...sent, [key]: after });
  expect(await emailConditionState(run, { ...condition, event }, after)).toBe('expired');
});
it.each(['not_clicked', 'not_opened'] as const)('never treats %s as true before the deadline', async event => {
  expect(await emailConditionState(run, { ...condition, event }, before)).toBe('waiting');
  expect(await emailConditionState(run, { ...condition, event }, after)).toBe('matched');
  m.message.mockResolvedValue({ ...sent, clickedAt: before, openedAt: before });
  expect(await emailConditionState(run, { ...condition, event }, before)).toBe('expired');
});
it.each(['FAILED', 'BOUNCED', 'CANCELLED'])('does not put %s messages into the no-response segment', async status => {
  m.message.mockResolvedValue({ ...sent, status }); expect(await emailConditionState(run, { ...condition, event: 'not_clicked' }, after)).toBe('missing');
});
it('tracks a specific URL on the exact run message and contact within the timestamp window', async () => {
  const c = { ...condition, link: 'https://example.com/offer' };
  m.message.mockResolvedValue({ ...sent, clickedAt: before });
  expect(await emailConditionState(run, c, before)).toBe('waiting');
  m.event.mockResolvedValue({ id: 'event' }); expect(await emailConditionState(run, c, before)).toBe('matched');
  expect(m.message.mock.calls[0][0].where).toMatchObject({ requestKey: 'seq:run:0', channel: 'email', conversation: { contactId: 'contact' } });
  expect(m.event.mock.calls[0][0].where).toMatchObject({ contactId: 'contact', type: 'email.engagement', occurredAt: { gte: new Date('2026-01-01T10:00:00Z'), lte: new Date('2026-01-01T11:00:01Z') }, AND: expect.arrayContaining([{ payload: { path: ['messageId'], equals: 'message' } }, { payload: { path: ['link'], equals: c.link } }]) });
});
it('cannot pass if the source send was skipped or never sent', async () => {
  m.message.mockResolvedValue(null); expect(await emailConditionState(run, condition, after)).toBe('missing');
  m.message.mockResolvedValue({ ...sent, providerMessageId: null }); expect(await emailConditionState(run, condition, after)).toBe('missing');
});
const definition = (c: Record<string, unknown> = condition) => ({ name: 'Email follow-up', trigger: 'CONTACT_CREATED', steps: [
  { action: 'send', channel: 'email', waitMinutes: 0, templateId: 'intro' },
  { action: 'condition', channel: 'email', waitMinutes: 0, condition: { requireNoReply: false, emailEvent: c } },
] });
it('validates an email journey and rejects missing/future/wrong-channel sources and invalid link events', () => {
  expect(sequenceSchema.safeParse(definition()).success).toBe(true);
  for (const c of [{ ...condition, sourceStep: 1 }, { ...condition, sourceStep: -1 }, { ...condition, timeoutMinutes: 0 }, { ...condition, event: 'opened', link: 'https://example.com' }, { ...condition, link: 'javascript:alert(1)' }]) expect(sequenceSchema.safeParse(definition(c)).success).toBe(false);
  const d = definition(); d.steps[0].channel = 'whatsapp'; expect(sequenceSchema.safeParse(d).success).toBe(false);
});
