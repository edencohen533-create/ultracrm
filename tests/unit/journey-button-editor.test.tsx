import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JourneyBuilder, type Journey } from '@/components/automations/journey/journey-builder';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/client/use-lead-statuses', () => ({ useLeadStatuses: () => ({ items: [] }) }));
vi.mock('@/components/automations/journey/journey-ai', () => ({ JourneyAiPanel: () => null }));
vi.mock('@/components/automations/journey/journey-dialogs', () => ({ PublishDialog: () => null, SimulateDialog: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function initial(): Journey { return { id: 'journey', name: 'Warm leads', status: 'draft', version: 0, hasDraft: false, trigger: 'CONTACT_CREATED', triggerConfig: {}, stopOn: ['reply', 'conversion'], steps: [
  { action: 'send', channel: 'whatsapp', templateId: 'intro', waitMinutes: 0, variables: {}, condition: { requireNoReply: true } },
  { action: 'condition', channel: 'email', waitMinutes: 0, variables: {}, condition: { requireNoReply: true } },
  { action: 'send', channel: 'whatsapp', templateId: 'followup', waitMinutes: 0, variables: {}, condition: { requireNoReply: true } },
] }; }
function mount() {
  render(<JourneyBuilder initial={initial()} tags={[]} lists={[]} templates={[{ id: 'intro', name: 'Welcome', channel: 'whatsapp', buttons: [{ type: 'QUICK_REPLY', text: 'Tell me more' }, { type: 'URL', text: 'Visit website' }] }, { id: 'followup', name: 'Details', channel: 'whatsapp' }]} />);
  fireEvent.click(screen.getByTestId('journey-step-1'));
  fireEvent.change(screen.getByTestId('journey-condition-type'), { target: { value: 'whatsapp_button' } });
  fireEvent.change(screen.getByTestId('journey-button-source'), { target: { value: '0' } });
  fireEvent.change(screen.getByTestId('journey-button-choice'), { target: { value: 'Tell me more' } });
}
it('selects a real template button and saves a journey that can continue after the reply', async () => {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: { id: 'journey' } }) })); vi.stubGlobal('fetch', fetchMock);
  mount();
  expect(screen.queryByRole('option', { name: 'Visit website' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByTestId('journey-button-timeout'), { target: { value: '120' } });
  fireEvent.click(screen.getByTestId('journey-save'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const saved = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(saved.stopOn).toEqual(['conversion']);
  expect(saved.steps[1].condition).toMatchObject({ requireNoReply: false, whatsappButton: { sourceStep: 0, buttonText: 'Tell me more', timeoutMinutes: 120 } });
  expect(saved.steps[2].condition.requireNoReply).toBe(false);
});
it('invalidates a removed source instead of silently tracking a different message', () => {
  mount();
  fireEvent.click(screen.getByTestId('journey-step-0'));
  fireEvent.click(screen.getByTestId('journey-step-delete'));
  fireEvent.click(screen.getByTestId('journey-step-0'));
  expect(screen.getByTestId('journey-button-source')).toHaveValue('-1');
});
