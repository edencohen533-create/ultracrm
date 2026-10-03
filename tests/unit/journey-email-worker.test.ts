// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ runs: vi.fn(), claim: vi.fn(), update: vi.fn(), sequence: vi.fn(), button: vi.fn(), send: vi.fn(), blocked: vi.fn(), reply: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: {
  sequenceRun: { findMany: m.runs, updateMany: m.claim, update: m.update }, marketingSequence: { findUnique: m.sequence },
  contact: { findFirst: async () => ({ id: 'contact' }), findUniqueOrThrow: async () => ({ fullName: 'Test' }) }, message: { findFirst: m.reply },
} }));
vi.mock('@/server/automations/email-condition', () => ({ emailConditionState: m.button }));
vi.mock('@/lib/events', () => ({ MAX_AUTOMATION_DEPTH: 5 }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getBusinessSettings: async () => ({ marketing: { window: {} } }), isWithinDialWindow: () => true }));
vi.mock('@/lib/suppression', () => ({ sendBlockReason: m.blocked }));
vi.mock('@/lib/access/engine', () => ({ businessCanUse: async () => true }));
vi.mock('@/server/providers/provider-registry', () => ({ resolveSender: async () => ({ id: 'sender' }), ProviderUnavailableError: class extends Error {} }));
vi.mock('@/server/services/conversation-service', () => ({ startConversationForAutomation: async () => ({ id: 'conversation' }) }));
vi.mock('@/server/services/message-service', () => ({ createOutboundMessage: m.send, FrequencyCapError: class extends Error {}, MessagePolicyError: class extends Error {} }));
vi.mock('@/lib/campaigns', () => ({ personalizeVariables: (x: unknown) => x }));
import { processDueSequenceRuns } from '@/server/services/sequence-service';
const steps = [
  { position: 0, action: 'send', channel: 'whatsapp', templateId: 'intro', waitMinutes: 0, variables: {}, condition: { requireNoReply: false } },
  { position: 1, action: 'condition', channel: 'email', waitMinutes: 0, variables: {}, condition: { requireNoReply: false, emailEvent: { sourceStep: 0, event: 'clicked', timeoutMinutes: 60 } } },
  { position: 2, action: 'send', channel: 'whatsapp', templateId: 'details', waitMinutes: 0, variables: {}, condition: { requireNoReply: false } },
];
beforeEach(() => {
  vi.resetAllMocks();
  let current: Record<string, unknown> = { id: 'run', sequenceId: 'seq', contactId: 'contact', status: 'PENDING', stepIndex: 1, startedAt: new Date(), sourceKey: 'event:lead', versionId: null, log: [] };
  m.runs.mockImplementation(async () => current.status === 'PENDING' ? [current] : []);
  m.claim.mockResolvedValue({ count: 1 });
  m.update.mockImplementation(async ({ data }) => { current = { ...current, ...data }; return current; });
  m.sequence.mockResolvedValue({ id: 'seq', name: 'warm', isActive: true, createdById: 'owner', stopOn: [], steps });
  m.blocked.mockResolvedValue(null); m.reply.mockResolvedValue(null);
  m.send.mockResolvedValue({ message: { id: 'sent', status: 'SENT' } });
});
it('keeps the gate pending and sends nothing until the email event arrives', async () => {
  m.button.mockResolvedValue('waiting'); await processDueSequenceRuns(undefined, 'business');
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', lockedAt: null }) }));
  expect(m.update.mock.calls[0][0].data.stepIndex).toBeUndefined(); expect(m.send).not.toHaveBeenCalled();
});
it('continues to the follow-up after a matching email event and uses the normal protected send path', async () => {
  m.button.mockResolvedValue('matched'); await processDueSequenceRuns(undefined, 'business');
  expect(m.update.mock.calls[0][0].data.stepIndex).toBe(2);
  await processDueSequenceRuns(undefined, 'business');
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'details', requestKey: 'seq:run:2', requireOptIn: true, automated: true }));
  expect(m.update.mock.calls.at(-1)![0].data.status).toBe('COMPLETED');
});
it.each(['expired', 'missing'])('stops for %s source/click and never sends the next message', async state => {
  m.button.mockResolvedValue(state); await processDueSequenceRuns(undefined, 'business'); await processDueSequenceRuns(undefined, 'business');
  expect(m.update.mock.calls[0][0].data.status).toBe('STOPPED'); expect(m.send).not.toHaveBeenCalled();
});
it('still blocks the follow-up when the contact unsubscribed after clicking', async () => {
  m.button.mockResolvedValue('matched'); await processDueSequenceRuns(undefined, 'business');
  m.blocked.mockResolvedValue('opted out'); await processDueSequenceRuns(undefined, 'business');
  expect(m.send).not.toHaveBeenCalled(); expect(m.update.mock.calls.at(-1)![0].data.stopReason).toContain('unsubscribe');
});
