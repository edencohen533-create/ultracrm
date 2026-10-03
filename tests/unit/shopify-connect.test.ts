// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { StoreConnection } from "@/generated/prisma/client";
const m = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/safe-url", () => ({ safeFetch: m.fetch }));
vi.mock("@/lib/db", () => ({ prisma: { storeConnection: { update: m.update } } }));
vi.mock("@/server/services/cart-service", () => ({ sealStoreConfig: (v: unknown) => v }));
vi.mock("@/server/channels/registry", () => ({ openConfig: () => ({}) }));
import { connectShopify } from "@/server/services/store-api";
const store = { id: "s1", platform: "shopify", config: {}, domain: null } as unknown as StoreConnection;
const credentials = { shop: "my-shop.myshopify.com", accessToken: "test-token", apiSecret: "test-secret" };
const first = () => Response.json({ data: { shop: { name: "Shop" }, webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
beforeEach(() => { vi.clearAllMocks(); m.update.mockImplementation(async ({ data }) => ({ ...store, ...data })); });
it("does not count GraphQL userErrors as registered subscriptions", async () => {
  m.fetch.mockResolvedValueOnce(first()).mockImplementation(async () => Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: "Access denied for topic" }] } } }));
  const result = await connectShopify(store, credentials);
  expect(result.registered).toEqual([]); expect(result.failed).toHaveLength(3); expect(result.store.webhookStatus).toBe("failed");
});
it("registers paid events rather than treating order creation as payment", async () => {
  m.fetch.mockResolvedValueOnce(first()).mockImplementation(async () => Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://hook" }, userErrors: [] } } }));
  const result = await connectShopify(store, credentials);
  expect(result.registered).toEqual(["CHECKOUTS_CREATE", "CHECKOUTS_UPDATE", "ORDERS_PAID"]);
  expect(m.fetch.mock.calls[0][0]).toContain('/2026-10/graphql.json');
  expect(result.store.webhookStatus).toBe("configured"); expect(result.store.lastVerifiedEventAt).toBeNull();
});
it("does not accept HTTP 422 as successful subscription registration", async () => {
  m.fetch.mockResolvedValueOnce(first()).mockImplementation(async () => new Response("invalid", { status: 422 }));
  const result = await connectShopify(store, credentials);
  expect(result.registered).toEqual([]); expect(result.failed).toHaveLength(3); expect(result.store.webhookStatus).toBe("failed");
});
it("does not save rejected credentials", async () => {
  m.fetch.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
  await expect(connectShopify(store, credentials)).rejects.toThrow(); expect(m.update).not.toHaveBeenCalled();
});
it("reuses existing topic and destination subscriptions", async () => {
  const { webhookUrlFor } = await import("@/lib/store-urls");
  m.fetch.mockResolvedValueOnce(Response.json({ data: { shop: { name: "Shop" }, webhookSubscriptions: { nodes: ["CHECKOUTS_CREATE", "CHECKOUTS_UPDATE", "ORDERS_PAID"].map(topic => ({ topic, uri: webhookUrlFor("shopify",store.id) })), pageInfo: { hasNextPage: false } } } }));
  expect((await connectShopify(store, credentials)).registered).toHaveLength(3); expect(m.fetch).toHaveBeenCalledOnce();
});
