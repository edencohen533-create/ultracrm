/**
 * "חיבור עם API" for stores: the manager pastes the store's API credentials once; we verify them against the store
 * and register the webhooks ourselves (no copy-pasting URLs in the store admin).
 *  • Shopify: shop.myshopify.com + Admin API access token (custom app with read_orders + read_checkouts) + the app's
 *    API secret key (Shopify signs webhooks created by the app with it).
 *  • WooCommerce: site URL + REST API consumer key/secret (Read/Write) – we choose the webhook secret.
 * Credentials are stored sealed (encrypted) in the store config and never returned to the browser.
 */
import type { StoreConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { openConfig } from "@/server/channels/registry";
import { webhookUrlFor } from "@/lib/store-urls";
import { assertPublicHttpsUrl, safeFetch } from "@/lib/safe-url";
import { newWebhookSecret, sealStoreConfig, storeSecret } from "./cart-service";

export const SHOPIFY_API_VERSION = "2024-10";
const SHOPIFY_TOPICS = ["checkouts/create", "checkouts/update", "orders/create"];
const WOO_TOPICS = ["order.created", "order.updated"];

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

export async function connectWooCommerce(store: StoreConnection, input: { siteUrl: string; consumerKey: string; consumerSecret: string }) {
  const origin = assertPublicHttpsUrl(input.siteUrl, "כתובת האתר").origin;
  const auth = `Basic ${Buffer.from(`${input.consumerKey.trim()}:${input.consumerSecret.trim()}`).toString("base64")}`;
  const headers = { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" };
  const listRes = await call(`${origin}/wp-json/wc/v3/webhooks?per_page=100`, { headers }, "WooCommerce");
  if (listRes.status === 404) throw new ApiError("לא נמצא WooCommerce REST API בכתובת הזו (בדוק שהכתובת נכונה ושה-Permalinks אינם 'Plain')", 400, "store_not_woocommerce");
  if (!listRes.ok) throw new ApiError(`WooCommerce החזירה שגיאה ${listRes.status}`, 502, "store_error");
  const existing = ((await listRes.json().catch(() => [])) as Array<{ topic: string; delivery_url: string; status: string }>) ?? [];
  const address = webhookUrlFor("woocommerce", store.id);
  const secret = storeSecret(store) || newWebhookSecret();
  const registered: string[] = []; const failed: string[] = [];
  for (const topic of WOO_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.delivery_url === address && w.status === "active")) { registered.push(topic); continue; }
    const r = await call(`${origin}/wp-json/wc/v3/webhooks`, { method: "POST", headers, body: JSON.stringify({ name: `UltraCRM – ${topic}`, topic, delivery_url: address, secret, status: "active" }) }, "WooCommerce");
    if (r.ok) registered.push(topic); else failed.push(`${topic} (${r.status})`);
  }
  const cfg = { ...openConfig(store.config), webhookSecret: secret, consumerKey: input.consumerKey.trim(), consumerSecret: input.consumerSecret.trim(), apiSite: origin, apiConnectedAt: new Date().toISOString(), apiWebhooks: registered };
  const updated = await prisma.storeConnection.update({ where: { id: store.id }, data: { config: sealStoreConfig(cfg), domain: store.domain ?? new URL(origin).host } });
  return { store: updated, registered, failed, shopName: new URL(origin).host };
}

/** Non-secret API status for the setup screen. */
export function apiStatus(store: Pick<StoreConnection, "config">) {
  const c = openConfig(store.config) as Record<string, unknown>;
  if (!c.apiConnectedAt) return null;
  return { connectedAt: String(c.apiConnectedAt), target: String(c.apiShop ?? c.apiSite ?? ""), webhooks: Array.isArray(c.apiWebhooks) ? (c.apiWebhooks as string[]) : [] };
}
