import { withBusiness } from "@/lib/tenant";
import { db } from "@/lib/db";
import { ingestCart, ingestOrder, storeSecret, verifyStoreSignature } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";
type Addr = { phone?: string | null; first_name?: string | null; last_name?: string | null; name?: string | null } | null | undefined;
const nameOf = (...a: Addr[]) => { for (const x of a) { const n = x?.name || [x?.first_name, x?.last_name].filter(Boolean).join(" "); if (n) return n; } return undefined; };

/** Shopify webhooks: checkouts/create, checkouts/update (abandoned checkouts) and orders/create (purchase). HMAC-verified. */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  const store = await db.storeConnection.findFirst({ where: { id: storeId, platform: "shopify", isActive: true } });
  if (!store) return new Response("unknown store", { status: 404 });
  if (!verifyStoreSignature(storeSecret(store), raw, req.headers.get("x-shopify-hmac-sha256"))) return new Response("bad signature", { status: 401 });
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const p = JSON.parse(raw) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  await withBusiness(store.businessId, async () => {
    const phone = p.phone || p.shipping_address?.phone || p.billing_address?.phone || p.customer?.phone || undefined;
    if (topic.startsWith("checkouts/")) {
      if (p.completed_at) return; // completed checkouts arrive as orders
      await ingestCart(store, {
        externalId: String(p.token ?? p.id), email: p.email ?? p.customer?.email ?? undefined, phone, name: nameOf(p.customer, p.shipping_address, p.billing_address),
        currency: p.currency ?? p.presentment_currency, total: p.total_price !== undefined ? Number(p.total_price) : undefined,
        items: (p.line_items ?? []).map((i: { title?: string; quantity?: number; price?: string | number }) => ({ name: i.title ?? "", quantity: i.quantity ?? 1, price: i.price !== undefined ? Number(i.price) : undefined })),
        checkoutUrl: p.abandoned_checkout_url ?? undefined, acceptsMarketing: typeof p.buyer_accepts_marketing === "boolean" ? p.buyer_accepts_marketing : undefined,
      });
    } else if (topic.startsWith("orders/")) {
      await ingestOrder(store, { orderId: String(p.name ?? p.id), externalId: p.checkout_token ? String(p.checkout_token) : undefined, email: p.email ?? p.customer?.email ?? undefined, phone, total: p.total_price !== undefined ? Number(p.total_price) : undefined, currency: p.currency });
    }
  });
  return new Response("ok");
}
