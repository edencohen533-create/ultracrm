/**
 * Connecting a WooCommerce store, end to end:
 *  1. Credentials: site URL + REST API consumer key / secret (WooCommerce → Settings → Advanced → REST API → Add key,
 *     for a user with the shop-manager / administrator role). "Read" is enough to read orders, customers and products;
 *     "Read/Write" is needed only so WE can create the webhooks for you (the key is never used to change orders).
 *  2. Test = real API requests to every resource we need; the result is stored per resource. "Saved" is never "connected".
 *  3. Webhooks: created through the REST API (topics below) with a secret WE generate and sign-check (HMAC-SHA256 over the
 *     raw body, X-WC-Webhook-Signature). Existing ones pointing at us are repaired (re-activated / secret updated) and
 *     duplicates removed – reconnecting never multiplies them. Without write permission → exact manual instructions.
 *     Status: configured (created / reported) → verified only when a SIGNED event actually arrives.
 *  4. Disconnect / key rotation never deletes customers, orders, carts or history.
 * The consumer key / secret and the webhook secret are different things: the first authenticates US to the store, the
 * second lets us verify the store's deliveries. All are sealed (encrypted) in the store config; never logged or returned.
 */
import type { StoreConnection } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { openConfig } from "@/server/channels/registry";
import { webhookUrlFor } from "@/lib/store-urls";
import { newWebhookSecret, sealStoreConfig, storeSecret } from "@/server/services/cart-service";
import { wooOrigin, wooRequest, WooError, type WooCredentials } from "./client";
import { wooCredentials } from "./events";

export const WOO_TOPICS = ["order.created", "order.updated", "order.deleted", "customer.created", "customer.updated", "product.created", "product.updated", "product.deleted"] as const;
export type Access = { orders: boolean; customers: boolean; products: boolean; webhooksRead: boolean; webhooksWrite: boolean | null; storeName?: string | null };

/** Real requests per resource. Throws only when the store itself cannot be used (address / key / blocking). */
export async function testWoo(creds: WooCredentials): Promise<{ access: Access; problems: string[] }> {
  const problems: string[] = [];
  const probe = async (path: string, label: string) => {
    try { await wooRequest(creds, path, { query: { per_page: 1 } }); return true; }
    catch (e) {
      if (e instanceof WooError && (e.kind === "permission" || (e.kind === "auth" && path !== "/orders"))) { problems.push(`אין הרשאת קריאה ל${label}`); return false; }
      throw e;
    }
  };
  const orders = await probe("/orders", "הזמנות");
  const customers = await probe("/customers", "לקוחות");
  const products = await probe("/products", "מוצרים");
  const webhooksRead = await probe("/webhooks", "Webhooks");
  let storeName: string | null = null;
  try { const r = await wooRequest<{ environment?: { site_url?: string } }>(creds, "/system_status"); storeName = r.data?.environment?.site_url ?? null; } catch { /* optional */ }
  return { access: { orders, customers, products, webhooksRead, webhooksWrite: null, storeName }, problems };
}

async function saveHealth(store: StoreConnection, data: Prisma.StoreConnectionUpdateInput) {
  return prisma.storeConnection.update({ where: { id: store.id }, data });
}

/** Save credentials (only after a successful test), then set up webhooks. */
export async function connectWoo(store: StoreConnection, input: WooCredentials) {
  if (store.platform !== "woocommerce") throw new ApiError("החנות אינה WooCommerce", 400, "platform_mismatch");
  const origin = wooOrigin(input.siteUrl);
  const creds = { siteUrl: origin, consumerKey: input.consumerKey.trim(), consumerSecret: input.consumerSecret.trim() };
  let test: Awaited<ReturnType<typeof testWoo>>;
  try { test = await testWoo(creds); }
  catch (e) {
    await saveHealth(store, { apiStatus: "failed", apiCheckedAt: new Date(), apiError: (e as Error).message.slice(0, 300) });
    throw e;
  }
  if (!test.access.orders) {
    await saveHealth(store, { apiStatus: "failed", apiCheckedAt: new Date(), apiError: test.problems.join("; ").slice(0, 300), apiAccess: test.access as unknown as Prisma.InputJsonValue });
    throw new ApiError(`למפתח אין הרשאה לקרוא הזמנות – צור מפתח עם הרשאת Read (או Read/Write) למשתמש מנהל. ${test.problems.join("; ")}`, 400, "woo_permission");
  }
  const secret = storeSecret(store) || newWebhookSecret();
  const cfg = { ...openConfig(store.config), webhookSecret: secret, consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, apiSite: origin, apiConnectedAt: new Date().toISOString() };
  let updated = await saveHealth(store, { config: sealStoreConfig(cfg), domain: store.domain ?? new URL(origin).host, apiStatus: "ok", apiCheckedAt: new Date(), apiError: test.problems.length ? test.problems.join("; ").slice(0, 300) : null, apiAccess: test.access as unknown as Prisma.InputJsonValue, isActive: true, disconnectedAt: null });
  const hooks = await ensureWooWebhooks(updated);
  updated = await prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
  return { store: updated, access: test.access, problems: test.problems, webhooks: hooks };
}

/** Re-test an existing connection (the "בדיקת חיבור" button). */
export async function recheckWoo(store: StoreConnection) {
  const creds = wooCredentials(store);
  if (!creds) throw new ApiError("לא הוגדרו פרטי API לחנות", 400, "woo_not_configured");
  try {
    const t = await testWoo(creds);
    const prev = (store.apiAccess ?? {}) as Partial<Access>;
    await saveHealth(store, { apiStatus: t.access.orders ? "ok" : "failed", apiCheckedAt: new Date(), apiError: t.problems.length ? t.problems.join("; ").slice(0, 300) : null, apiAccess: { ...t.access, webhooksWrite: prev.webhooksWrite ?? null } as unknown as Prisma.InputJsonValue });
    return t;
  } catch (e) {
    await saveHealth(store, { apiStatus: "failed", apiCheckedAt: new Date(), apiError: (e as Error).message.slice(0, 300) });
    throw e;
  }
}

/** Create / repair our webhooks; never duplicates. Falls back to manual instructions without write permission. */
export async function ensureWooWebhooks(store: StoreConnection) {
  const creds = wooCredentials(store);
  if (!creds) throw new ApiError("לא הוגדרו פרטי API לחנות", 400, "woo_not_configured");
  const address = webhookUrlFor("woocommerce", store.id);
  const secret = storeSecret(store);
  type Hook = { id: number; topic: string; delivery_url: string; status: string };
  let existing: Hook[] = [];
  try { existing = (await wooRequest<Hook[]>(creds, "/webhooks", { query: { per_page: 100 } })).data ?? []; } catch (e) { if (!(e instanceof WooError && (e.kind === "permission" || e.kind === "auth"))) throw e; }
  const ours = existing.filter((w) => w.delivery_url === address);
  const created: string[] = []; const repaired: string[] = []; const ok: string[] = []; const failed: string[] = [];
  let writeDenied = false;
  for (const topic of WOO_TOPICS) {
    const same = ours.filter((w) => w.topic === topic);
    try {
      if (same.length) {
        const [keep, ...extra] = same;
        // Re-activate (WooCommerce disables a hook after 5 failed deliveries) and make sure it signs with OUR secret.
        await wooRequest(creds, `/webhooks/${keep.id}`, { method: "PUT", body: { status: "active", secret } });
        (keep.status === "active" ? ok : repaired).push(topic);
        for (const x of extra) await wooRequest(creds, `/webhooks/${x.id}`, { method: "DELETE", query: { force: "true" } }).catch(() => undefined);
      } else {
        await wooRequest(creds, "/webhooks", { method: "POST", body: { name: `UltraCRM – ${topic}`, topic, delivery_url: address, secret, status: "active", api_version: "wp_api_v3" } });
        created.push(topic);
      }
    } catch (e) {
      if (e instanceof WooError && (e.kind === "permission" || e.kind === "auth")) { writeDenied = true; break; }
      failed.push(`${topic}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const access = { ...((store.apiAccess ?? {}) as Partial<Access>), webhooksWrite: !writeDenied };
  const status = writeDenied ? "manual_required" : failed.length ? "failed" : store.webhookStatus === "verified" ? "verified" : "configured";
  await saveHealth(store, { webhookStatus: status, webhookError: writeDenied ? "למפתח אין הרשאת כתיבה – יש להגדיר את ה-Webhooks ידנית (או ליצור מפתח Read/Write)" : failed.length ? failed.join("; ").slice(0, 300) : null, apiAccess: access as unknown as Prisma.InputJsonValue });
  return { status, created, repaired, ok, failed, manual: writeDenied ? manualWebhookInstructions(store) : null };
}

/** Exact manual setup (WooCommerce → Settings → Advanced → Webhooks → Add webhook), one per topic. */
export function manualWebhookInstructions(store: StoreConnection) {
  return { deliveryUrl: webhookUrlFor("woocommerce", store.id), secret: storeSecret(store), apiVersion: "WP REST API Integration v3", topics: WOO_TOPICS.map((t) => ({ topic: t, label: WOO_TOPIC_LABEL[t] })) };
}
export const WOO_TOPIC_LABEL: Record<(typeof WOO_TOPICS)[number], string> = {
  "order.created": "Order created", "order.updated": "Order updated", "order.deleted": "Order deleted", "customer.created": "Customer created",
  "customer.updated": "Customer updated", "product.created": "Product created", "product.updated": "Product updated", "product.deleted": "Product deleted",
};

/** Disconnect: stop using the store, forget the API keys (optionally remove our webhooks first). History stays. */
export async function disconnectWoo(store: StoreConnection, opts: { removeWebhooks: boolean }) {
  let removed = 0;
  const creds = wooCredentials(store);
  if (opts.removeWebhooks && creds) {
    const address = webhookUrlFor("woocommerce", store.id);
    const hooks = (await wooRequest<Array<{ id: number; delivery_url: string }>>(creds, "/webhooks", { query: { per_page: 100 } }).catch(() => ({ data: [] as Array<{ id: number; delivery_url: string }> }))).data ?? [];
    for (const h of hooks.filter((x) => x.delivery_url === address)) { await wooRequest(creds, `/webhooks/${h.id}`, { method: "DELETE", query: { force: "true" } }).then(() => removed++, () => undefined); }
  }
  const cfg = openConfig(store.config) as Record<string, unknown>;
  delete cfg.consumerKey; delete cfg.consumerSecret; delete cfg.apiConnectedAt;
  await saveHealth(store, { config: sealStoreConfig(cfg), isActive: false, disconnectedAt: new Date(), apiStatus: "none", webhookStatus: "none", syncState: Prisma.DbNull });
  return { removedWebhooks: removed };
}
