import { withBusiness } from "@/lib/tenant";
import { openConfig } from "@/server/channels/registry";
import { db, prisma } from "@/lib/db";
import { ingestCart, ingestOrder, storeSecret, verifyStoreSignature } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";
type Addr = { phone?: string | null; first_name?: string | null; last_name?: string | null; name?: string | null } | null | undefined;
const nameOf = (...a: Addr[]) => { for (const x of a) { const n = x?.name || [x?.first_name, x?.last_name].filter(Boolean).join(" "); if (n) return n; } return undefined; };

/** Shopify webhooks: checkouts/* (abandoned checkouts), orders/* (purchase, edits, cancellations, refunds – kept as an
 * order snapshot) and fulfillments/* (parcels). HMAC-verified. */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response("too large", { status: 413 });
  const store = await db.storeConnection.findFirst({ where: { id: storeId, platform: "shopify", isActive: true } });
  if (!store) return new Response("unknown store", { status: 404 });
  if (!verifyStoreSignature(storeSecret(store), raw, req.headers.get("x-shopify-hmac-sha256"))) return new Response("bad signature", { status: 401 });
  const topic = req.headers.get("x-shopify-topic") ?? "";
  if (!["checkouts/create", "checkouts/update", "orders/create", "orders/paid", "orders/updated", "orders/cancelled", "fulfillments/create", "fulfillments/update"].includes(topic)) return new Response("unsupported topic", { status: 400 });
  const configuredShop = openConfig(store.config).apiShop;
  if (configuredShop && req.headers.get("x-shopify-shop-domain") !== configuredShop) return new Response("wrong shop", { status: 403 });
  let p: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { p = JSON.parse(raw); } catch { return new Response("invalid JSON", { status: 400 }); }
  if (!p || typeof p !== "object" || Array.isArray(p)) return new Response("invalid payload", { status: 400 });
  if (topic.startsWith("checkouts/") && (!p.token || !p.updated_at || !Number.isFinite(Date.parse(p.updated_at)))) return new Response("checkout token and updated_at required", { status: 400 });
  if (topic.startsWith("orders/") && !p.id) return new Response("order id required", { status: 400 });
  await withBusiness(store.businessId, async () => {
    const phone = p.phone || p.shipping_address?.phone || p.billing_address?.phone || p.customer?.phone || undefined;
    if (topic.startsWith("checkouts/")) {
      if (p.completed_at) return; // completed checkouts arrive as orders
      await ingestCart(store, {
        externalId: String(p.token), activityAt: new Date(p.updated_at).toISOString(), email: p.email ?? p.customer?.email ?? undefined, phone, name: nameOf(p.customer, p.shipping_address, p.billing_address),
        currency: p.currency ?? p.presentment_currency, total: p.total_price !== undefined ? Number(p.total_price) : undefined,
        items: (p.line_items ?? []).map((i: { title?: string; quantity?: number; price?: string | number }) => ({ name: i.title ?? "", quantity: i.quantity ?? 1, price: i.price !== undefined ? Number(i.price) : undefined })),
        checkoutUrl: p.abandoned_checkout_url ?? undefined, acceptsMarketing: typeof p.buyer_accepts_marketing === "boolean" ? p.buyer_accepts_marketing : undefined,
      });
    } else if (topic.startsWith("fulfillments/")) {
      // A parcel of an order (split shipments): its exact line items and delivery status.
      const { mergeShipments, shopifyOrderSnapshot } = await import("@/server/services/store-order-service");
      const [shipment] = shopifyOrderSnapshot({ id: p.order_id, line_items: [], fulfillments: [p] }).shipments ?? [];
      if (p.order_id && shipment) await mergeShipments(store.businessId, "shopify", String(p.order_id), [shipment], store.id);
    } else if (topic.startsWith("orders/")) {
      const { upsertStoreOrder, shopifyOrderSnapshot } = await import("@/server/services/store-order-service");
      await upsertStoreOrder(store.businessId, "shopify", shopifyOrderSnapshot(p), { storeId: store.id });
      if (topic === "orders/paid" || p.financial_status === "paid") await ingestOrder(store, { orderId: String(p.name ?? p.id), externalId: p.checkout_token ? String(p.checkout_token) : undefined, email: p.email ?? p.customer?.email ?? undefined, phone, total: p.total_price !== undefined ? Number(p.total_price) : undefined, currency: p.currency });
    }
    await prisma.storeConnection.update({ where: { id: store.id }, data: { lastVerifiedEventAt: new Date(), webhookStatus: "verified", webhookError: null } });
  });
  return new Response("ok");
}
