import { withBusiness } from "@/lib/tenant";
import { db } from "@/lib/db";
import { ingestCart, ingestOrder, storeSecret, verifyStoreSignature } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";
const OPEN = ["checkout-draft", "pending", "failed"];
const PAID = ["processing", "completed", "on-hold"];

/** WooCommerce webhooks (order.created / order.updated). Unpaid orders are carts; paid orders convert them. HMAC-verified. */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  const store = await db.storeConnection.findFirst({ where: { id: storeId, platform: "woocommerce", isActive: true } });
  if (!store) return new Response("unknown store", { status: 404 });
  // WooCommerce "pings" a new webhook with a form body (webhook_id=…) and no signature – acknowledge it.
  if (raw.startsWith("webhook_id=")) return new Response("ok");
  if (!verifyStoreSignature(storeSecret(store), raw, req.headers.get("x-wc-webhook-signature"))) return new Response("bad signature", { status: 401 });
  const o = JSON.parse(raw) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!o?.id) return new Response("ok");
  await withBusiness(store.businessId, async () => {
    const b = o.billing ?? {};
    const name = [b.first_name, b.last_name].filter(Boolean).join(" ") || undefined;
    if (OPEN.includes(o.status)) {
      await ingestCart(store, {
        externalId: `order:${o.id}`, email: b.email || undefined, phone: b.phone || undefined, name, currency: o.currency, total: o.total !== undefined ? Number(o.total) : undefined,
        items: (o.line_items ?? []).map((i: { name?: string; quantity?: number; price?: number | string }) => ({ name: i.name ?? "", quantity: i.quantity ?? 1, price: i.price !== undefined ? Number(i.price) : undefined })),
        checkoutUrl: o.payment_url || undefined,
      });
    } else if (PAID.includes(o.status)) {
      await ingestOrder(store, { orderId: String(o.number ?? o.id), externalId: `order:${o.id}`, email: b.email || undefined, phone: b.phone || undefined, total: o.total !== undefined ? Number(o.total) : undefined, currency: o.currency });
    }
  });
  return new Response("ok");
}
