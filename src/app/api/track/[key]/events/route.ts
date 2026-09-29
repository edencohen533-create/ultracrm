import { z } from "zod";
import { withBusiness } from "@/lib/tenant";
import { db } from "@/lib/db";
import { cartInputSchema, ingestCart, ingestOrder, orderInputSchema } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";
const cors = (origin: string | null) => ({ "Access-Control-Allow-Origin": origin ?? "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" });
export async function OPTIONS(req: Request) { return new Response(null, { status: 204, headers: cors(req.headers.get("origin")) }); }

/** Best-effort per-instance limits: this endpoint is public by design (its key sits in the site snippet). */
const hits = new Map<string, number[]>();
function limited(key: string, limit: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return arr.length > limit;
}
const bareDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
const onDomain = (url: string, d: string) => { try { const h = new URL(url).hostname.toLowerCase(); return h === d || h.endsWith(`.${d}`); } catch { return false; } };

/**
 * Browser events from the site script (public, no session). It is unsigned, so it is treated as untrusted:
 * with a domain set, the request must come from it (a missing Origin is refused); marketing consent is never taken
 * from it (only from the store's signed webhooks); the cart link must be on the store's domain; and it is rate limited.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const origin = req.headers.get("origin");
  const { key } = await params;
  const raw = await req.text();
  if (raw.length > 64_000) return new Response(null, { status: 413, headers: cors(origin) });
  const store = await db.storeConnection.findUnique({ where: { publicKey: key } });
  if (!store || !store.isActive) return new Response(null, { status: 404, headers: cors(origin) });
  const d = store.domain ? bareDomain(store.domain) : null;
  if (d && (!origin || !onDomain(origin, d))) return new Response(null, { status: 403, headers: cors(origin) });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (limited(`k:${store.id}`, 600) || limited(`i:${store.id}:${ip}`, 60)) return new Response(null, { status: 429, headers: cors(origin) });
  let body: unknown; try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers: cors(origin) }); }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    delete b.acceptsMarketing;
    if (typeof b.checkoutUrl === "string" && (!d || !onDomain(b.checkoutUrl, d))) delete b.checkoutUrl;
  }
  const type = z.object({ type: z.enum(["cart", "order"]) }).safeParse(body);
  if (!type.success) return new Response(null, { status: 400, headers: cors(origin) });
  try {
    await withBusiness(store.businessId, async () => {
      if (type.data.type === "cart") { const c = cartInputSchema.safeParse(body); if (c.success) await ingestCart(store, c.data); }
      else { const o = orderInputSchema.safeParse(body); if (o.success) await ingestOrder(store, o.data); }
    });
  } catch (e) { console.warn("[track] ingest failed", (e as Error).message.slice(0, 200)); }
  return new Response(null, { status: 204, headers: cors(origin) });
}
