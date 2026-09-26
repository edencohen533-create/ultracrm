import { z } from "zod";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { cartInputSchema, ingestCart, ingestOrder, orderInputSchema } from "@/server/services/cart-service";

export const dynamic = "force-dynamic";
const cors = (origin: string | null) => ({ "Access-Control-Allow-Origin": origin ?? "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" });
export async function OPTIONS(req: Request) { return new Response(null, { status: 204, headers: cors(req.headers.get("origin")) }); }

/** Browser events from the site script (public, no session). Only the store's own origin is accepted when a domain is set. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const origin = req.headers.get("origin");
  const { key } = await params;
  const raw = await req.text();
  if (raw.length > 64_000) return new Response(null, { status: 413, headers: cors(origin) });
  const store = await withoutBusiness(() => prisma.storeConnection.findUnique({ where: { publicKey: key } }));
  if (!store || !store.isActive) return new Response(null, { status: 404, headers: cors(origin) });
  if (store.domain && origin) {
    const host = (() => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ""; } })();
    const d = store.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (host !== d && !host.endsWith(`.${d}`)) return new Response(null, { status: 403, headers: cors(origin) });
  }
  let body: unknown; try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers: cors(origin) }); }
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
