// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ stores: vi.fn(), carts: vi.fn(), update: vi.fn(), emit: vi.fn(), transaction: vi.fn() }));
const tx = { cart: { updateMany: m.update } };
vi.mock('@/lib/db', () => ({ prisma: { storeConnection: { findMany: m.stores }, cart: { findMany: m.carts }, $transaction: m.transaction } }));
vi.mock('@/lib/events', () => ({ emitEvent: m.emit }));
vi.mock('@/lib/crm/contacts', () => ({ findOrCreateContactByPhone: vi.fn() }));
vi.mock('@/lib/suppression', () => ({ contactForIdentifier: vi.fn() }));
vi.mock('@/server/channels/registry', () => ({ openConfig: vi.fn(), sealConfig: vi.fn() }));
import { processAbandonedCarts } from '@/server/services/cart-service';
beforeEach(() => {
  vi.resetAllMocks();
  m.stores.mockResolvedValue([{ id: 'store', abandonAfterMinutes: 30 }]);
  m.carts.mockResolvedValue([{ id: 'cart', contactId: 'contact', lastActivityAt: new Date('2026-01-01') }]);
  m.update.mockResolvedValue({ count: 1 });
  m.transaction.mockImplementation(async callback => callback(tx));
});
it('records the abandonment event through the same transaction as its guarded state change', async () => {
  expect(await processAbandonedCarts('business')).toEqual({ processed: 1 });
  expect(m.emit).toHaveBeenCalledWith(tx, expect.objectContaining({ type: 'cart.abandoned', contactId: 'contact' }));
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cart', status: 'open', lastActivityAt: new Date('2026-01-01') } }));
});
it('propagates outbox failure to the transaction instead of committing abandoned state alone', async () => {
  m.emit.mockRejectedValue(new Error('outbox unavailable'));
  await expect(processAbandonedCarts('business')).rejects.toThrow('outbox unavailable');
});
it('does not emit or count a cart changed by a purchase or new activity', async () => {
  m.update.mockResolvedValue({ count: 0 });
  expect(await processAbandonedCarts('business')).toEqual({ processed: 0 });
  expect(m.emit).not.toHaveBeenCalled();
});
it('counts anonymous abandonment without creating a contact event', async () => {
  m.carts.mockResolvedValue([{ id: 'cart', contactId: null, lastActivityAt: new Date('2026-01-01') }]);
  expect(await processAbandonedCarts('business')).toEqual({ processed: 1 });
  expect(m.emit).not.toHaveBeenCalled();
});
