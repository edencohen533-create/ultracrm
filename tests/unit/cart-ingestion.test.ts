// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreConnection } from "@/generated/prisma/client";
const m = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), saved: vi.fn(), store: vi.fn(), contact: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { cart: { findUnique: m.find, createMany: m.create, updateMany: m.update, findUniqueOrThrow: m.saved, upsert: m.upsert }, storeConnection: { update: m.store } } }));
vi.mock("@/lib/events", () => ({ emitEvent: m.emit }));
vi.mock("@/lib/crm/contacts", () => ({ findOrCreateContactByPhone: m.contact }));
vi.mock("@/lib/suppression", () => ({ contactForIdentifier: vi.fn() }));
vi.mock("@/server/channels/registry", () => ({ openConfig: (v: unknown) => v, sealConfig: (v: unknown) => v }));
import { ingestCart, ingestOrder } from "@/server/services/cart-service";
const store = { id: "store", businessId: "business", platform: "custom" } as StoreConnection;
beforeEach(() => { vi.clearAllMocks(); m.find.mockResolvedValue(null); m.saved.mockResolvedValue({ id: "c1", status: "open" }); });
describe("cart activity and purchase correlation", () => {
  it("does not fabricate contact details for an anonymous visitor", async () => {
    await ingestCart(store, { externalId: "c1", items: [{ name: "x", quantity: 1 }] });
    expect(m.contact).not.toHaveBeenCalled();
    expect(m.create.mock.calls[0][0].data[0]).toMatchObject({ email: null, phoneE164: null, contactId: null, customerName: null });
  });
  it("stale and duplicate activity cannot reopen a cart or postpone abandonment", async () => {
    const existing = { status: "abandoned", lastActivityAt: new Date("2026-01-02T00:00:00Z") };
    m.find.mockResolvedValue(existing);
    for (const activityAt of ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]) expect(await ingestCart(store, { externalId: "c1", activityAt })).toBe(existing);
    expect(m.update).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
  });
  it("new activity resets abandonment using source time", async () => {
    m.find.mockResolvedValue({ status: "abandoned", lastActivityAt: new Date("2026-01-01T00:00:00Z") });
    await ingestCart(store, { externalId: "c1", activityAt: "2026-01-02T00:00:00Z" });
    expect(m.update.mock.calls[0][0]).toMatchObject({ data: { status: "open", abandonedAt: null, lastActivityAt: new Date("2026-01-02T00:00:00Z") }, where: { status: { notIn: ["converted", "recovered"] } } });
  });
  it("guards the database update against a simultaneous purchase", async () => {
    m.find.mockResolvedValue({ status: "open", lastActivityAt: new Date("2026-01-01T00:00:00Z") });
    m.saved.mockResolvedValue({ status: "converted" });
    expect(await ingestCart(store, { externalId: "c1", activityAt: "2026-01-02T00:00:00Z" })).toMatchObject({ status: "converted" });
    expect(m.create.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(m.update.mock.calls[0][0].where).toMatchObject({ status: { notIn: ["converted", "recovered"] }, lastActivityAt: { lt: new Date("2026-01-02T00:00:00Z") } });
  });
  it("empty carts do not enter abandonment", async () => {
    await ingestCart(store, { externalId: "c1", items: [] });
    expect(m.create.mock.calls[0][0].data[0].status).toBe("empty");
  });
  it("paid-before-cart creates a tombstone for precisely that external ID", async () => {
    m.upsert.mockResolvedValue({ status: "converted", contactId: null });
    await ingestOrder(store, { externalId: "paid-cart", orderId: "o1", email: "same@example.test" });
    expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { storeId_externalId: { storeId: "store", externalId: "paid-cart" } }, create: expect.objectContaining({ status: "converted", externalId: "paid-cart" }) }));
  });
  it("an order without cart ID cannot close a cart based on an email guess", async () => {
    expect(await ingestOrder(store, { orderId: "o1", email: "same@example.test" })).toBeNull();
    expect(m.find).not.toHaveBeenCalled(); expect(m.upsert).not.toHaveBeenCalled();
  });
  it("late activity never reopens a paid cart", async () => {
    m.find.mockResolvedValue({ status: "converted" });
    await ingestCart(store, { externalId: "c1" }); expect(m.update).not.toHaveBeenCalled();
  });
});
