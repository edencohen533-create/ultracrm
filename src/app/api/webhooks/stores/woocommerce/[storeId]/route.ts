import { after } from "next/server";
import { withBusiness } from "@/lib/tenant";
import { db } from "@/lib/db";
import { storeSecret, verifyStoreSignature } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";

/**
 * WooCommerce deliveries (orders, customers, products – created / updated / deleted). The signature
 * (X-WC-Webhook-Signature = base64 HMAC-SHA256 of the RAW body with our secret) is checked before anything is read;
 * the business comes from the verified store connection, never from the payload. The event is STORED (deduped),
 * acknowledged at once, and processed after the response (the every-minute job is the safety net, with retries).
 */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  const store = await db.storeConnection.findFirst({ where: { id: storeId, platform: "woocommerce", isActive: true } });
  if (!store) return new Response("unknown store", { status: 404 });
  // WooCommerce "pings" a new webhook with a form body (webhook_id=…) and no signature – acknowledge only.
  if (raw.startsWith("webhook_id=")) return new Response("ok");
  if (!verifyStoreSignature(storeSecret(store), raw, req.headers.get("x-wc-webhook-signature"))) return new Response("bad signature", { status: 401 });
  try { JSON.parse(raw); } catch { return new Response("bad payload", { status: 400 }); }
  const { ingestWooWebhook, processStoreEvents } = await import("@/server/services/woo/events");
  const r = await withBusiness(store.businessId, () => ingestWooWebhook(store, req.headers, raw));
  if (!r.duplicate) {
    const work = () => withBusiness(store.businessId, () => processStoreEvents({ storeId: store.id, limit: 10, deadline: Date.now() + 20_000 })).then(() => undefined, (e: Error) => console.error("[woo webhook] processing", { storeId, error: e.message }));
    // After the response in a real request; outside one (direct calls / tests) process now.
    try { after(work); } catch { await work(); }
  }
  return new Response(r.duplicate ? "duplicate" : "ok");
}
