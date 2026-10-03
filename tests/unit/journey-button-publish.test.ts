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
  { action: 'send', channel: 'whatsapp', templateId: 'intro', waitMinutes: 0, condition: { requireNoReply: false } },
  { action: 'condition', channel: 'email', waitMinutes: 0, condition: { requireNoReply: false, whatsappButton: { sourceStep: 0, buttonText: 'More', timeoutMinutes: 60 } } },
] };
beforeEach(() => { vi.resetAllMocks(); m.templates.mockResolvedValue([{ id: 'intro', name: 'intro', channel: 'whatsapp', status: 'APPROVED', internal: false, buttons: [{ type: 'QUICK_REPLY', text: 'More' }] }]); m.provider.mockResolvedValue({ id: 'sender', provider: 'meta_whatsapp_cloud_api', sendingBlocked: false }); });
it('permits a real quick reply from an approved template and connected Meta sender', async () => {
  const r = await publishChecks(user, def); expect(r.checks.filter(c => c.blocking && !c.ok)).toEqual([]);
});
it('rejects a deleted, renamed or URL button even through a direct API definition', async () => {
  m.templates.mockResolvedValue([{ id: 'intro', channel: 'whatsapp', status: 'APPROVED', buttons: [{ type: 'URL', text: 'More' }] }]);
  const r = await publishChecks(user, def); expect(r.checks.find(c => c.key === 'whatsappButtons')?.ok).toBe(false);
});
it('does not advertise live button tracking through a mock sender', async () => {
  m.provider.mockResolvedValue({ id: 'demo', provider: 'mock' });
  const r = await publishChecks(user, def); expect(r.checks.find(c => c.key === 'buttonProvider')?.ok).toBe(false);
});
