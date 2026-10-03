// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ message: vi.fn(), event: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { message: { findFirst: m.message }, domainEvent: { findFirst: m.event } } }));
vi.mock('@/lib/events', () => ({ MAX_AUTOMATION_DEPTH: 5 }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/suppression', () => ({ sendBlockReason: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getBusinessSettings: vi.fn(), isWithinDialWindow: vi.fn() }));
import { whatsappButtonState } from '@/server/automations/button-condition';
import { sequenceSchema } from '@/server/services/sequence-service';
import { metaButtonReply, metaWebhookSchema } from '@/lib/validation/whatsapp-webhook';
import { quickReplyButtons } from '@/lib/journey-buttons';
const run = { id: 'run-1', contactId: 'contact-1' };
const condition = { sourceStep: 0, buttonText: 'Interested', timeoutMinutes: 60 };
beforeEach(() => { vi.resetAllMocks(); m.message.mockResolvedValue({ providerMessageId: 'wamid.out', providerCredentialId: 'sender-1', createdAt: new Date('2026-01-01T10:00:00.500Z'), acceptedAt: new Date('2026-01-01T10:00:01Z'), status: 'SENT' }); m.event.mockResolvedValue(null); });
it('retains Meta callback context and payload through webhook validation', () => {
  const parsed = metaWebhookSchema.parse({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'in', from: '972501234567', timestamp: '1767261601', type: 'button', context: { id: 'wamid.out', from: 'sender' }, button: { text: 'Interested', payload: 'choice-1' } }] } }] }] });
  expect(metaButtonReply(parsed.entry[0].changes[0].value.messages![0])).toEqual({ contextMessageId: 'wamid.out', buttonText: 'Interested', buttonId: 'choice-1' });
});
it('typed text and context-free buttons cannot qualify as clicks', () => {
  expect(metaButtonReply({ id: 'in', timestamp: '1', type: 'text', text: { body: 'Interested' }, context: { id: 'wamid.out' } })).toBeUndefined();
  expect(metaButtonReply({ id: 'in', timestamp: '1', type: 'button', button: { text: 'Interested' } })).toBeUndefined();
});
it('supports structured interactive button replies', () => {
  expect(metaButtonReply({ id: 'in', timestamp: '1', type: 'interactive', context: { id: 'out' }, interactive: { button_reply: { title: 'Interested', id: 'choice' } } })).toEqual({ contextMessageId: 'out', buttonText: 'Interested', buttonId: 'choice' });
});
it('only exposes real quick reply buttons, not URL or telephone buttons', () => {
  expect(quickReplyButtons([{ type: 'QUICK_REPLY', text: 'Interested' }, { type: 'URL', text: 'Visit' }, { type: 'PHONE_NUMBER', text: 'Call' }])).toEqual(['Interested']);
});
it('waits without a click before the deadline', async () => { expect(await whatsappButtonState(run, condition, new Date('2026-01-01T10:30:00Z'))).toBe('waiting'); });
it('expires without a click rather than continuing', async () => { expect(await whatsappButtonState(run, condition, new Date('2026-01-01T11:01:00Z'))).toBe('expired'); });
it('uses the exact run message, contact, sender, callback label and provider timestamp window', async () => {
  m.event.mockResolvedValue({ id: 'reply' });
  expect(await whatsappButtonState(run, condition, new Date('2026-01-01T11:01:00Z'))).toBe('matched');
  expect(m.message.mock.calls[0][0].where).toMatchObject({ requestKey: 'seq:run-1:0', direction: 'OUTBOUND', channel: 'whatsapp', conversation: { contactId: 'contact-1' } });
  expect(m.event.mock.calls[0][0].where).toMatchObject({ contactId: 'contact-1', type: 'message.received', occurredAt: { gte: new Date('2026-01-01T10:00:00Z'), lte: new Date('2026-01-01T11:00:01Z') }, AND: expect.arrayContaining([{ payload: { path: ['providerCredentialId'], equals: 'sender-1' } }, { payload: { path: ['whatsappReply', 'contextMessageId'], equals: 'wamid.out' } }, { payload: { path: ['whatsappReply', 'buttonText'], equals: 'Interested' } }]) });
});
it.each([null, { status: 'FAILED', providerMessageId: 'out' }, { status: 'SENT', providerMessageId: null }])('cannot pass when source message was not sent: %j', async sent => { m.message.mockResolvedValue(sent); expect(await whatsappButtonState(run, condition)).toBe('missing'); expect(m.event).not.toHaveBeenCalled(); });
const send = { action: 'send', channel: 'whatsapp', templateId: 'tpl', waitMinutes: 0, condition: { requireNoReply: false } };
const def = () => ({ name: 'Warm leads', trigger: 'CONTACT_CREATED', stopOn: ['conversion'], steps: [send, { action: 'condition', channel: 'whatsapp', waitMinutes: 0, condition: { requireNoReply: false, whatsappButton: condition } }, send] });
it('accepts immediate message → wait for specific button → follow-up', () => { expect(sequenceSchema.safeParse(def()).success).toBe(true); });
it('rejects reply stop conditions that would kill the button journey', () => { expect(sequenceSchema.safeParse({ ...def(), stopOn: ['reply'] }).success).toBe(false); });
it('rejects invalid/future source references', () => { const d = def(); d.steps[1].condition = { requireNoReply: false, whatsappButton: { ...condition, sourceStep: 2 } }; expect(sequenceSchema.safeParse(d).success).toBe(false); });
it('rejects no-reply filtering after a click gate', () => { const d = def(); d.steps[2] = { ...send, condition: { requireNoReply: true } }; expect(sequenceSchema.safeParse(d).success).toBe(false); });
