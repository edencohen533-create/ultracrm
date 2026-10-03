import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformAdmin } from '@/components/access/PlatformAdmin';
import { UserAccessEditor, type AccessUserRow } from '@/components/access/AccessMatrix';
import { MODULES } from '@/lib/access/catalog';
vi.mock('@/components/access/BusinessPricing', () => ({ BusinessPricing: () => null }));
const user = { id: 'agent', fullName: 'QA agent', email: 'qa@example.test', role: 'agent', isActive: true, template: 'custom', scope: 'own', permissions: {}, effective: null, derived: false } as AccessUserRow;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('all package checkboxes toggle independently and the saved version preserves choices', async () => {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: init?.method === 'POST' ? { id: 'plan' } : { items: [] } }) })); vi.stubGlobal('fetch', fetchMock);
  render(<PlatformAdmin />); fireEvent.click(screen.getByTestId('platform-tab-plans')); fireEvent.click(await screen.findByTestId('platform-new-plan'));
  fireEvent.change(screen.getByTestId('platform-plan-name'), { target: { value: 'QA package' } });
  for (const m of MODULES) { fireEvent.click(screen.getByTestId(`platform-plan-${m}`)); expect(screen.getByTestId(`platform-plan-${m}`)).toBeChecked(); }
  fireEvent.click(screen.getByTestId('platform-plan-email')); expect(screen.getByTestId('platform-plan-email')).not.toBeChecked();
  fireEvent.click(screen.getByTestId('platform-plan-save'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const saved = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1]?.body));
  expect(saved.modules.crm.included).toBe(true); expect(saved.modules.email.included).toBe(false);
});
it('user module and action checkboxes toggle and persist grant/revoke selections', async () => {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: {} }) }));vi.stubGlobal('fetch', fetchMock);
  render(<UserAccessEditor user={user} actor={null} endpoint="/api/platform/businesses/test/users/agent" packageModules={Object.fromEntries(MODULES.map(m => [m, { included: true }])) as never} onClose={() => {}} onSaved={() => {}} />);
  for (const m of MODULES) { fireEvent.click(screen.getByTestId(`access-enable-${m}`)); expect(screen.getByTestId(`access-enable-${m}`)).toBeChecked(); }
  fireEvent.click(screen.getByTestId('access-crm-view')); expect(screen.getByTestId('access-crm-view')).toBeChecked();
  fireEvent.click(screen.getByTestId('access-enable-email')); fireEvent.click(screen.getByTestId('access-save'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled()); const saved = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(saved.modules.crm).toMatchObject({ enabled: true, actions: ['view'] }); expect(saved.modules.email.enabled).toBe(false);
});
it('zero-seat downgrade can be confirmed without checking and unchecking an impossible seat', async () => {
  const { ChangePreview } = await import('@/components/access/PlatformAdmin');
  const impact = { modulesRemoved: [], usersLosing: {}, seatOverflow: { crm: { seats: 0, holders: [{ id: 'agent', fullName: 'Agent' }] } }, campaigns: [], journeys: [], inboxAutomations: 0, serviceAgent: false, dialerSessions: 0, dialLists: 0 };
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: { impact } }) })); vi.stubGlobal('fetch', fetchMock);
  render(<ChangePreview businessId="test" target={{ planVersionId: 'zero' }} onClose={() => {}} onDone={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('platform-apply')).toBeEnabled());
  expect(screen.getByTestId('platform-keep-crm-agent')).toBeDisabled(); fireEvent.click(screen.getByTestId('platform-apply'));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).keep).toEqual({ crm: [] });
});
