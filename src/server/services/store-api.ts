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

export const SHOPIFY_API_VERSION = "2024-10";
const SHOPIFY_TOPICS = ["checkouts/create", "checkouts/update", "orders/create"];

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
  const shopRes = await call(`${base}/shop.json`, { headers }, "Shopify");
  if (!shopRes.ok) throw new ApiError(`Shopify החזירה שגיאה ${shopRes.status}`, 502, "store_error");
  const shopName = ((await shopRes.json().catch(() => ({}))) as { shop?: { name?: string } }).shop?.name ?? host;
  const listRes = await call(`${base}/webhooks.json?limit=250`, { headers }, "Shopify");
  if (!listRes.ok) throw new ApiError("אין לטוקן הרשאה לנהל Webhooks (נדרשות הרשאות read_orders ו-read_checkouts)", 400, "store_scope");
  const existing = (((await listRes.json().catch(() => ({}))) as { webhooks?: Array<{ topic: string; address: string }> }).webhooks) ?? [];
  const address = webhookUrlFor("shopify", store.id);
  const registered: string[] = []; const failed: string[] = [];
  for (const topic of SHOPIFY_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.address === address)) { registered.push(topic); continue; }
    const r = await call(`${base}/webhooks.json`, { method: "POST", headers, body: JSON.stringify({ webhook: { topic, address, format: "json" } }) }, "Shopify");
    if (r.ok || r.status === 422) registered.push(topic); else failed.push(`${topic} (${r.status})`);
  }
  const cfg = { ...openConfig(store.config), webhookSecret: input.apiSecret.trim(), accessToken: input.accessToken.trim(), apiShop: host, apiConnectedAt: new Date().toISOString(), apiWebhooks: registered, apiStoreName: shopName };
  const updated = await prisma.storeConnection.update({ where: { id: store.id }, data: { config: sealStoreConfig(cfg), domain: store.domain ?? host } });
  return { store: updated, registered, failed, shopName };
}

/** Non-secret API status for the setup screen. */
export function apiStatus(store: Pick<StoreConnection, "config">) {
  const c = openConfig(store.config) as Record<string, unknown>;
  if (!c.apiConnectedAt) return null;
  return { connectedAt: String(c.apiConnectedAt), target: String(c.apiShop ?? c.apiSite ?? ""), webhooks: Array.isArray(c.apiWebhooks) ? (c.apiWebhooks as string[]) : [] };
}
