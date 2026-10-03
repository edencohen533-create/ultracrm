// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ templates: vi.fn(), provider: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { template: { findMany: m.templates }, providerCredential: { findFirst: m.provider }, contact: { count: async () => 0 } } }));
vi.mock('@/lib/access/engine', () => ({ effectiveAccess: async () => ({}), can: () => true, businessCanUse: async () => true }));
vi.mock('@/lib/events', () => ({ MAX_AUTOMATION_DEPTH: 5 }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/suppression', () => ({ sendBlockReason: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getBusinessSettings: vi.fn(), isWithinDialWindow: vi.fn() }));
import { publishChecks } from '@/server/automations/journeys';
import type { SessionUser } from '@/lib/auth';
const user = { id: 'owner', businessId: 'business' } as SessionUser;
const def = { name: 'Warm', trigger: 'CONTACT_CREATED', stopOn: [], steps: [
  { action: 'send', channel: 'email', templateId: 'intro', waitMinutes: 0 },
  { action: 'condition', channel: 'email', waitMinutes: 0, condition: { requireNoReply: false, emailEvent: { sourceStep: 0, event: 'opened', timeoutMinutes: 60 } } },
] };
beforeEach(() => { vi.resetAllMocks(); m.templates.mockResolvedValue([{ id: 'intro', name: 'intro', channel: 'email', status: 'APPROVED', internal: false }]); m.provider.mockResolvedValue({ id: 'sender', provider: 'resend', sendingBlocked: false }); });
it('permits Resend but explicitly says that external tracking settings remain unverified', async () => {
  const result = await publishChecks(user, def);
  expect(result.checks.filter(c => c.blocking && !c.ok)).toEqual([]);
  expect(result.checks.find(c => c.key === 'emailTracking')).toMatchObject({ ok: false, blocking: false });
});
it.each([null, { provider: 'mock_email' }, { provider: 'resend', sendingBlocked: true }])('blocks an unavailable or simulated provider: %j', async sender => {
  m.provider.mockResolvedValue(sender); const result = await publishChecks(user, def);
  expect(result.checks.find(c => c.key === 'emailEventProvider')).toMatchObject({ ok: false, blocking: true });
});
