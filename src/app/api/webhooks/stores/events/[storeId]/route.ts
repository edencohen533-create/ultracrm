import { after } from "next/server";
import { z } from "zod";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { cartInputSchema, orderInputSchema, storeSecret, verifyStoreSignature } from "@/server/services/cart-service";
import { enqueueStoreItem, processStoreEvents } from "@/server/services/woo/events";

export const dynamic = "force-dynamic";
const schema = z.discriminatedUnion("type", [
  cartInputSchema.extend({ type: z.literal("cart"), activityAt: z.string().datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 60_000) }),
  orderInputSchema.extend({ type: z.literal("order"), externalId: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("probe") }),
]);
/** Server-only protocol. The secret never belongs in a browser. Timestamp is signed to bound replay. */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  if (raw.length > 128_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const store = await db.storeConnection.findFirst({ where: { id: storeId, platform: { in: ["custom", "woocommerce"] }, isActive: true } });
  if (!store) return Response.json({ error: "Unknown active store" }, { status: 404 });
  const eventId = req.headers.get("x-ultracrm-event-id") ?? "";
  if (!/^[\w:.-]{8,160}$/.test(eventId)) return Response.json({ error: "A stable x-ultracrm-event-id is required" }, { status: 400 });
  const timestamp = req.headers.get("x-ultracrm-timestamp") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 || !verifyStoreSignature(storeSecret(store), `${timestamp}.${eventId}.${raw}`, req.headers.get("x-ultracrm-signature"))) {
    return Response.json({ error: "Invalid signature or expired timestamp" }, { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid event", fields: parsed.error.flatten().fieldErrors }, { status: 400 });
  return withBusiness(store.businessId, async () => {
    if (parsed.data.type === "probe") return Response.json({ ok: true, storeId, message: "Signature verified. Send a cart and paid order to verify the full flow." });
    const result = await enqueueStoreItem(store, "webhook", `ucrm.${parsed.data.type}`, { ...parsed.data, id: eventId });
    await prisma.storeConnection.update({ where: { id: store.id }, data: { lastVerifiedEventAt: new Date(), webhookStatus: "verified", webhookError: null } });
    after(() => processStoreEvents({ storeId, limit: 25 }).then(() => undefined));
    return Response.json({ accepted: true, duplicate: result.duplicate, eventId: result.event?.id ?? null, status: "queued" }, { status: 202 });
  });
}
