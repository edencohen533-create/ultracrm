/**
 * Store event inbox → worker. A verified webhook (or an import / reconcile page item) is STORED first (dedupe by
 * content: the same delivery twice, or the same version of a resource, is one event), acknowledged, then processed
 * by a worker with bounded retries (backoff; transient errors retry, permanent ones fail and can be reprocessed from
 * the status screen). The business always comes from the verified store connection – never from the payload.
 * Order: an event older than the stored version is marked "stale" and changes nothing.
 * Imports are silent: no abandoned-cart flow, no "contact created" automations, no new-lead path.
 */
import crypto from "node:crypto";
import { Prisma, type StoreConnection, type StoreEvent } from "@/generated/prisma/client";
import { db, prisma, dbSchema } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { normalizePhone } from "@/lib/phone";
import { openConfig } from "@/server/channels/registry";
import { upsertStoreOrder, storeOrderKey } from "@/server/services/store-order-service";
import { wooDate, wooOrderFull, wooCustomer, wooProduct, detectCapabilities } from "./mapping";
import { linkStoreCustomer } from "./customers";
import { wooRequest, WooError, type WooCredentials } from "./client";

export const WOO_OPEN = ["checkout-draft", "pending", "failed"];
const PAID = ["processing", "completed", "on-hold"];
const MAX_ATTEMPTS = 8;

export function wooCredentials(store: Pick<StoreConnection, "config">): WooCredentials | null {
  const c = openConfig(store.config) as Record<string, unknown>;
  return c.consumerKey && c.consumerSecret && c.apiSite ? { siteUrl: String(c.apiSite), consumerKey: String(c.consumerKey), consumerSecret: String(c.consumerSecret) } : null;
}

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/* eslint-disable @typescript-eslint/no-explicit-any */
async function store(storeRow: StoreConnection, e: { source: "webhook" | "import" | "reconcile"; topic: string; payload: any; deliveryId?: string | null; raw?: string }) {
  const resourceId = e.payload?.id !== undefined ? String(e.payload.id) : null;
  const modified = wooDate(e.payload?.date_modified_gmt, e.payload?.date_modified);
  const payloadHash = hash(e.raw !== undefined ? `${e.topic}\n${e.raw}` : `${e.topic}\n${resourceId}\n${modified?.toISOString() ?? JSON.stringify(e.payload).length}`);
  try {
    const ev = await prisma.storeEvent.create({ data: { businessId: storeRow.businessId, storeId: storeRow.id, source: e.source, topic: e.topic, resourceId, deliveryId: e.deliveryId ?? null, payloadHash, payload: e.payload as Prisma.InputJsonValue, sourceModifiedAt: modified } });
    return { event: ev, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { event: null, duplicate: true };
    throw err;
  }
}

/** A signed WooCommerce delivery (signature already verified on the raw body by the route). */
export async function ingestWooWebhook(storeRow: StoreConnection, headers: Headers, raw: string) {
  const topic = headers.get("x-wc-webhook-topic") ?? "";
  const payload = JSON.parse(raw);
  const r = await store(storeRow, { source: "webhook", topic: topic || (payload?.line_items ? "order.updated" : "unknown"), payload, deliveryId: headers.get("x-wc-webhook-delivery-id"), raw });
  await prisma.storeConnection.update({ where: { id: storeRow.id }, data: { lastEventAt: new Date(), lastVerifiedEventAt: new Date(), webhookStatus: "verified", webhookError: null } });
  return r;
}

export async function enqueueStoreItem(storeRow: StoreConnection, source: "import" | "reconcile", topic: string, payload: any) {
  return store(storeRow, { source, topic, payload });
}

function mergeCaps(prev: unknown, add: ReturnType<typeof detectCapabilities>) {
  const p = (prev && typeof prev === "object" ? prev : {}) as Record<string, string[]>;
  const out: Record<string, string[]> = {};
  for (const k of ["payment", "shipping", "documents", "bundles"] as const) out[k] = [...new Set([...(p[k] ?? []), ...add[k]])].slice(0, 12);
  return out;
}

async function handleOrder(storeRow: StoreConnection, ev: StoreEvent, o: any): Promise<"done" | "stale"> {
  const creds = wooCredentials(storeRow);
  if (ev.topic.endsWith(".deleted")) {
    const ex = await prisma.storeOrder.findUnique({ where: { businessId_source_externalId: { businessId: storeRow.businessId, source: "woocommerce", externalId: storeOrderKey(storeRow.id, String(o.id)) } } });
    if (ex && ex.status !== "cancelled") await prisma.storeOrder.update({ where: { id: ex.id }, data: { status: "cancelled", changes: [...((ex.changes ?? []) as unknown[]), { at: new Date().toISOString(), kind: "cancelled", name: "ההזמנה נמחקה בחנות" }] as Prisma.InputJsonValue } });
    return "done";
  }
  // Refunded quantities per line come from the refunds endpoint (the order payload carries only refund totals).
  let refunds: any[] | null = null;
  if ((o.refunds ?? []).length && creds) refunds = (await wooRequest<any[]>(creds, `/orders/${o.id}/refunds`, { query: { per_page: 100 } })).data;
  const full = wooOrderFull(o, refunds);
  const b = o.billing ?? {};
  const link = await linkStoreCustomer(storeRow.businessId, storeRow.id, { externalId: full.customerId, email: b.email || null, phoneE164: b.phone ? normalizePhone(b.phone) : null, phoneRaw: b.phone || null, name: [b.first_name, b.last_name].filter(Boolean).join(" ") || null }, { silent: ev.source === "import" });
  const saved = await upsertStoreOrder(storeRow.businessId, "woocommerce", full.snapshot, { storeId: storeRow.id, extras: { ...full.extras, contactId: link.contactId, imported: ev.source === "import" } });
  if (saved.stale) return "stale";
  await prisma.storeConnection.update({ where: { id: storeRow.id }, data: { capabilities: mergeCaps(storeRow.capabilities, detectCapabilities(o)) as Prisma.InputJsonValue } });
  // A paid order makes the person an existing customer (identity only – no messages / dialing).
  if (link.contactId && PAID.includes(o.status)) {
    const { markPurchase } = await import("@/lib/crm/customer-identity");
    await markPurchase(prisma, { businessId: storeRow.businessId, contactId: link.contactId, at: wooDate(o.date_paid_gmt, o.date_paid) ?? wooDate(o.date_created_gmt, o.date_created) ?? undefined, via: ev.source === "import" ? "store_import" : "store_order" });
  }
  // Live events only: the abandoned-cart flow (an unpaid order is a cart; a paid one converts it). Never on import.
  if (ev.source === "webhook") {
    const { ingestCart, ingestOrder } = await import("@/server/services/cart-service");
    const name = [b.first_name, b.last_name].filter(Boolean).join(" ") || undefined;
    if (WOO_OPEN.includes(o.status)) await ingestCart(storeRow, { externalId: `order:${o.id}`, email: b.email || undefined, phone: b.phone || undefined, name, currency: o.currency, total: o.total !== undefined ? Number(o.total) : undefined, items: (o.line_items ?? []).map((i: any) => ({ name: i.name ?? "", quantity: i.quantity ?? 1, price: i.price !== undefined ? Number(i.price) : undefined })), checkoutUrl: o.payment_url || undefined });
    else if (PAID.includes(o.status)) await ingestOrder(storeRow, { orderId: String(o.number ?? o.id), externalId: `order:${o.id}`, email: b.email || undefined, phone: b.phone || undefined, total: o.total !== undefined ? Number(o.total) : undefined, currency: o.currency });
  }
  return "done";
}

async function handleProduct(storeRow: StoreConnection, ev: StoreEvent, p: any): Promise<"done" | "stale"> {
  if (ev.topic.endsWith(".deleted")) { await prisma.storeProduct.updateMany({ where: { storeId: storeRow.id, externalId: String(p.id) }, data: { deleted: true } }); return "done"; }
  const m = wooProduct(p);
  const ex = await prisma.storeProduct.findUnique({ where: { storeId_externalId: { storeId: storeRow.id, externalId: m.externalId } } });
  if (ex?.sourceModifiedAt && m.modifiedAt && m.modifiedAt < ex.sourceModifiedAt) return "stale";
  const data = { parentExternalId: m.parentExternalId, name: m.name, sku: m.sku, type: m.type, status: m.status, price: m.price !== null ? new Prisma.Decimal(m.price) : null, components: (m.components ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull, deleted: false, sourceModifiedAt: m.modifiedAt };
  await prisma.storeProduct.upsert({ where: { storeId_externalId: { storeId: storeRow.id, externalId: m.externalId } }, create: { businessId: storeRow.businessId, storeId: storeRow.id, externalId: m.externalId, ...data }, update: data });
  return "done";
}

async function handleCustomer(storeRow: StoreConnection, ev: StoreEvent, c: any): Promise<"done" | "stale"> {
  if (ev.topic.endsWith(".deleted")) return "done"; // the person's CRM history stays
  const m = wooCustomer(c);
  await linkStoreCustomer(storeRow.businessId, storeRow.id, m, { silent: ev.source === "import" });
  return "done";
}

export async function handleStoreEvent(storeRow: StoreConnection, ev: StoreEvent): Promise<"done" | "stale"> {
  const p = ev.payload as any;
  if (ev.topic.startsWith("order.")) return handleOrder(storeRow, ev, p);
  if (ev.topic.startsWith("product.")) return handleProduct(storeRow, ev, p);
  if (ev.topic.startsWith("customer.")) return handleCustomer(storeRow, ev, p);
  return "done";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Worker: claim due events (SKIP LOCKED – parallel workers never take the same event), process, retry with backoff. */
export async function processStoreEvents(opts: { limit?: number; deadline?: number; storeId?: string } = {}) {
  const deadline = opts.deadline ?? Date.now() + 20_000;
  const out = { done: 0, stale: 0, failed: 0, retried: 0 };
  while (Date.now() < deadline) {
    const T = Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."store_events"`);
    const claimed = await db.$queryRaw<Array<{ id: string; business_id: string }>>(Prisma.sql`
      UPDATE ${T} SET status = 'processing', attempts = attempts + 1 WHERE id IN (
        SELECT id FROM ${T} WHERE status = 'pending' AND next_attempt_at <= now() ${opts.storeId ? Prisma.sql`AND store_id = ${opts.storeId}` : Prisma.empty}
        ORDER BY source_modified_at ASC NULLS LAST, received_at ASC LIMIT ${Math.min(opts.limit ?? 25, 100)} FOR UPDATE SKIP LOCKED)
      RETURNING id, business_id`);
    if (!claimed.length) break;
    for (const c of claimed) {
      await withBusiness(c.business_id, async () => {
        const ev = await prisma.storeEvent.findUniqueOrThrow({ where: { id: c.id } });
        const storeRow = await prisma.storeConnection.findUnique({ where: { id: ev.storeId } });
        if (!storeRow) { await prisma.storeEvent.update({ where: { id: ev.id }, data: { status: "failed", error: "החנות לא נמצאה" } }); return; }
        try {
          const r = await handleStoreEvent(storeRow, ev);
          await prisma.storeEvent.update({ where: { id: ev.id }, data: { status: r, processedAt: new Date(), error: null } });
          out[r === "stale" ? "stale" : "done"]++;
        } catch (e) {
          const transient = !(e instanceof WooError) || e.transient;
          const last = ev.attempts >= MAX_ATTEMPTS || !transient;
          const wait = e instanceof WooError && e.retryAfterMs ? e.retryAfterMs : Math.min(60, 2 ** ev.attempts) * 60_000;
          await prisma.storeEvent.update({ where: { id: ev.id }, data: { status: last ? "failed" : "pending", nextAttemptAt: new Date(Date.now() + wait), error: String((e as Error).message).slice(0, 500) } });
          if (last) { out.failed++; console.error("[store-events] failed", { eventId: ev.id, topic: ev.topic }); } else out.retried++;
        }
      });
    }
  }
  return out;
}

/** "עבד מחדש": failed events of one store go back to the queue. */
export async function reprocessFailed(storeId: string) {
  return (await prisma.storeEvent.updateMany({ where: { storeId, status: "failed" }, data: { status: "pending", nextAttemptAt: new Date(), attempts: 0 } })).count;
}
