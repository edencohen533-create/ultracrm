/**
 * "חיבור עם API" for stores: the manager pastes the store's API credentials once; we verify them against the store
 * and register the webhooks ourselves (no copy-pasting URLs in the store admin).
 *  • Shopify: shop.myshopify.com + Admin API access token (custom app with read_orders + read_checkouts) + the app's
 *    API secret key (Shopify signs webhooks created by the app with it).
 *  • WooCommerce: see src/server/services/woo/connect.ts (test per resource, webhooks, import, reconcile).
 * Credentials are stored sealed (encrypted) in the store config and never returned to the browser.
 */
import type { StoreConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { openConfig } from "@/server/channels/registry";
import { webhookUrlFor } from "@/lib/store-urls";
import { safeFetch } from "@/lib/safe-url";
import { sealStoreConfig } from "./cart-service";

export const SHOPIFY_API_VERSION = "2026-10";
const SHOPIFY_TOPICS = ["CHECKOUTS_CREATE", "CHECKOUTS_UPDATE", "ORDERS_PAID"];

async function call(url: string, init: RequestInit, what: string) {
  let res: Response;
  try { res = await safeFetch(url, init); } catch (e) { throw new ApiError(`לא ניתן להתחבר ל${what}: ${(e as Error).message}`, 502, "store_unreachable"); }
  if (res.status === 401 || res.status === 403) throw new ApiError(`${what} דחתה את פרטי ה-API (בדוק את הטוקן/המפתחות וההרשאות)`, 400, "store_auth_failed");
  if (res.status >= 300 && res.status < 400) throw new ApiError(`${what} הפנתה לכתובת אחרת – השתמש בכתובת הראשית של החנות (https)`, 400, "store_redirect");
  return res;
}

export async function connectShopify(store: StoreConnection, input: { shop: string; accessToken: string; apiSecret: string }) {
  const host = input.shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) throw new ApiError("כתובת החנות צריכה להיות בפורמט your-store.myshopify.com", 400, "invalid_shop");
  const base = `https://${host}/admin/api/${SHOPIFY_API_VERSION}`;
  const headers = { "X-Shopify-Access-Token": input.accessToken.trim(), "Content-Type": "application/json", Accept: "application/json" };
  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await call(`${base}/graphql.json`, { method: "POST", headers, body: JSON.stringify({ query, variables }) }, "Shopify");
    if (!r.ok) throw new ApiError(`Shopify החזירה שגיאה ${r.status}`, 502, "store_error");
    const body = await r.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length || !body.data) throw new ApiError(body.errors?.map(e => e.message).join("; ") ?? "Invalid Shopify response", 400, "store_scope");
    return body.data;
  }
  const initial = await graphql<{ shop: { name: string }; webhookSubscriptions: { nodes: Array<{ topic: string; uri: string }>; pageInfo: { hasNextPage: boolean; endCursor: string } } }>(`query { shop { name } webhookSubscriptions(first: 250) { nodes { topic uri } pageInfo { hasNextPage endCursor } } }`);
  const shopName = initial.shop.name;
  const existing = [...initial.webhookSubscriptions.nodes];
  let page = initial.webhookSubscriptions.pageInfo;
  while (page.hasNextPage) {
    const next = await graphql<{ webhookSubscriptions: typeof initial.webhookSubscriptions }>(`query($cursor: String!) { webhookSubscriptions(first: 250, after: $cursor) { nodes { topic uri } pageInfo { hasNextPage endCursor } } }`, { cursor: page.endCursor });
    existing.push(...next.webhookSubscriptions.nodes); page = next.webhookSubscriptions.pageInfo;
  }
  const address = webhookUrlFor("shopify", store.id);
  const registered: string[] = []; const failed: string[] = [];
  for (const topic of SHOPIFY_TOPICS) {
    if (existing.some(w => w.topic === topic && w.uri === address)) { registered.push(topic); continue; }
    try {
      const r = await graphql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ message: string }> } }>(`mutation($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) { webhookSubscription { id } userErrors { message } } }`, { topic, input: { uri: address, format: "JSON" } });
      const result = r.webhookSubscriptionCreate;
      if (result.webhookSubscription && !result.userErrors.length) registered.push(topic);
      else failed.push(`${topic}: ${result.userErrors.map(e => e.message).join("; ") || "Subscription not created"}`);
    } catch (error) { failed.push(`${topic}: ${(error as Error).message}`); }
  }
  const cfg = { ...openConfig(store.config), webhookSecret: input.apiSecret.trim(), accessToken: input.accessToken.trim(), apiShop: host, apiConnectedAt: new Date().toISOString(), apiWebhooks: registered, apiStoreName: shopName };
  const updated = await prisma.storeConnection.update({ where: { id: store.id }, data: { config: sealStoreConfig(cfg), domain: store.domain ?? host, apiStatus: "ok", apiCheckedAt: new Date(), webhookStatus: failed.length ? "failed" : "configured", webhookError: failed.join("; ") || null, lastVerifiedEventAt: null } });
  return { store: updated, registered, failed, shopName };
}

/** Non-secret API status for the setup screen. */
export function apiStatus(store: Pick<StoreConnection, "config">) {
  const c = openConfig(store.config) as Record<string, unknown>;
  if (!c.apiConnectedAt) return null;
  return { connectedAt: String(c.apiConnectedAt), target: String(c.apiShop ?? c.apiSite ?? ""), webhooks: Array.isArray(c.apiWebhooks) ? (c.apiWebhooks as string[]) : [] };
}
