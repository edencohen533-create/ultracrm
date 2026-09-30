/**
 * Order snapshots ("store_orders"): what the order recorded AT PURCHASE TIME – line items (bundles with their
 * components as sold, gifts / benefits), later changes, refunds, split shipments and the receipt an invoicing source
 * sends. Fed by the Shopify / WooCommerce webhooks and by the public order API (any other system: ERP, invoicing,
 * courier). Every write is scoped to the store's / API key's business; the customer is linked by phone (same business).
 *
 * Changes are derived by comparing with the previous snapshot (item added / removed / quantity changed, cancelled,
 * refunded) and kept with their time – the current catalog is never consulted.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { contactForIdentifier } from "@/lib/suppression";

const kind = z.enum(["product", "bundle", "component", "gift", "benefit"]);
export const orderItemSchema = z.object({
  key: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  sku: z.string().trim().max(120).optional(),
  quantity: z.number().min(0).max(100000),
  refundedQuantity: z.number().min(0).max(100000).optional(),
  price: z.number().min(0).max(10_000_000).optional(),
  kind: kind.default("product"),
  parentKey: z.string().trim().max(200).optional(),
  /** Composition of a bundle as it was sold (when components are not sent as separate lines). */
  components: z.array(z.object({ name: z.string().trim().min(1).max(300), sku: z.string().trim().max(120).optional(), quantity: z.number().min(0).max(100000) })).max(100).optional(),
});
export const shipmentSchema = z.object({
  key: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "shipped", "delivered", "returned", "failed"]),
  carrier: z.string().trim().max(120).optional(),
  tracking: z.string().trim().max(200).optional(),
  shippedAt: z.string().datetime().optional(),
  deliveredAt: z.string().datetime().optional(),
  /** Items in this parcel; empty = the source did not say which items (never read as "everything"). */
  items: z.array(z.object({ key: z.string().trim().max(200).optional(), name: z.string().trim().min(1).max(300), quantity: z.number().min(0).max(100000) })).max(500).default([]),
});
export const receiptSchema = z.object({
  number: z.string().trim().max(120).optional(),
  issuedAt: z.string().datetime().optional(),
  total: z.number().min(0).max(100_000_000).optional(),
  url: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "https only").optional(),
  items: z.array(z.object({ name: z.string().trim().min(1).max(300), sku: z.string().trim().max(120).optional(), quantity: z.number().min(0).max(100000), price: z.number().min(0).max(10_000_000).optional() })).max(500),
});
export const orderSnapshotSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  orderNumber: z.string().trim().min(1).max(120),
  status: z.enum(["pending", "paid", "processing", "completed", "on_hold", "cancelled", "refunded", "partially_refunded"]),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().toLowerCase().max(200).optional(),
  currency: z.string().trim().max(10).optional(),
  total: z.number().min(0).max(100_000_000).optional(),
  placedAt: z.string().datetime().optional(),
  items: z.array(orderItemSchema).max(500).optional(),
  shipments: z.array(shipmentSchema).max(100).optional(),
  receipt: receiptSchema.nullable().optional(),
});
export type OrderSnapshot = z.infer<typeof orderSnapshotSchema>;
export type OrderItem = z.infer<typeof orderItemSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export interface OrderChange { at: string; kind: "created" | "item_added" | "item_removed" | "quantity_changed" | "cancelled" | "refunded"; name?: string; from?: number; to?: number }

function diff(prev: OrderItem[], next: OrderItem[], at: string): OrderChange[] {
  const out: OrderChange[] = [];
  const before = new Map(prev.map((i) => [i.key, i]));
  for (const i of next) {
    const p = before.get(i.key);
    if (!p) out.push({ at, kind: "item_added", name: i.name, to: i.quantity });
    else if (p.quantity !== i.quantity) out.push({ at, kind: "quantity_changed", name: i.name, from: p.quantity, to: i.quantity });
    before.delete(i.key);
  }
  for (const p of before.values()) out.push({ at, kind: "item_removed", name: p.name, from: p.quantity });
  return out;
}

/** Insert or update one order (same business, same source + external id). Returns the row. */
export async function upsertStoreOrder(businessId: string, source: "shopify" | "woocommerce" | "api", input: OrderSnapshot, opts: { storeId?: string | null; at?: Date } = {}) {
  const at = (opts.at ?? new Date()).toISOString();
  const e164 = input.phone ? normalizePhone(input.phone) : null;
  const contactId = (e164 ? await contactForIdentifier(businessId, e164) : null) ?? (input.email ? await contactForIdentifier(businessId, input.email) : null);
  const existing = await prisma.storeOrder.findUnique({ where: { businessId_source_externalId: { businessId, source, externalId: input.externalId } } });
  const prevItems = (existing?.items ?? []) as unknown as OrderItem[];
  const changes = ((existing?.changes ?? []) as unknown as OrderChange[]).slice();
  if (!existing) changes.push({ at, kind: "created" });
  else if (input.items) changes.push(...diff(prevItems, input.items, at));
  if (existing && existing.status !== input.status && (input.status === "cancelled" || input.status === "refunded")) changes.push({ at, kind: input.status });
  const data = {
    orderNumber: input.orderNumber, status: input.status,
    phoneE164: e164 ?? existing?.phoneE164 ?? null, email: input.email ?? existing?.email ?? null,
    contactId: contactId ?? existing?.contactId ?? null,
    currency: input.currency ?? existing?.currency ?? null,
    total: input.total !== undefined ? new Prisma.Decimal(input.total) : existing?.total ?? null,
    placedAt: input.placedAt ? new Date(input.placedAt) : existing?.placedAt ?? new Date(at),
    ...(input.items ? { items: input.items as unknown as Prisma.InputJsonValue } : {}),
    ...(input.shipments ? { shipments: input.shipments as unknown as Prisma.InputJsonValue } : {}),
    ...(input.receipt !== undefined ? { receipt: (input.receipt ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull } : {}),
    changes: changes.slice(-200) as unknown as Prisma.InputJsonValue,
  };
  return existing
    ? prisma.storeOrder.update({ where: { id: existing.id }, data })
    : prisma.storeOrder.create({ data: { businessId, source, externalId: input.externalId, storeId: opts.storeId ?? null, ...data } });
}

/** Merge shipments into an existing order (courier / fulfillment events that arrive on their own). */
export async function mergeShipments(businessId: string, source: "shopify" | "woocommerce" | "api", externalId: string, shipments: Shipment[]) {
  const o = await prisma.storeOrder.findUnique({ where: { businessId_source_externalId: { businessId, source, externalId } } });
  if (!o) return null;
  const byKey = new Map(((o.shipments ?? []) as unknown as Shipment[]).map((s) => [s.key, s]));
  for (const s of shipments) byKey.set(s.key, { ...byKey.get(s.key), ...s });
  return prisma.storeOrder.update({ where: { id: o.id }, data: { shipments: [...byKey.values()] as unknown as Prisma.InputJsonValue } });
}

// ─── Platform payloads → snapshot ────────────────────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const iso = (v: unknown) => { if (!v) return undefined; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); };
const meta = (i: any, key: string) => (Array.isArray(i?.meta_data) ? i.meta_data.find((m: any) => m?.key === key)?.value : undefined);

const WOO_STATUS: Record<string, OrderSnapshot["status"]> = { pending: "pending", processing: "processing", "on-hold": "on_hold", completed: "completed", cancelled: "cancelled", refunded: "refunded", failed: "cancelled" };
/**
 * WooCommerce order → snapshot. Bundles: "Product Bundles" / "Composite Products" meta (_bundled_by / _bundle_cart_key,
 * _composite_parent / _composite_cart_key) – a child line is a component of its parent line, as sold. Free gifts:
 * gift-plugin meta, or a zero-priced line that is not a component. Refunds: order-level only (Woo does not send
 * refunded quantities per line in the webhook). Shipments: the "Shipment Tracking" meta – without item mapping.
 */
export function wooOrderSnapshot(o: any): OrderSnapshot {
  const lines: any[] = o.line_items ?? [];
  const parentByCartKey = new Map<string, string>();
  for (const i of lines) { const k = meta(i, "_bundle_cart_key") ?? meta(i, "_composite_cart_key"); if (k) parentByCartKey.set(String(k), String(i.id)); }
  const items: OrderItem[] = lines.map((i) => {
    const parentCartKey = meta(i, "_bundled_by") ?? meta(i, "_composite_parent");
    const parentKey = parentCartKey ? parentByCartKey.get(String(parentCartKey)) : undefined;
    const isParent = Boolean(meta(i, "_bundled_items") ?? meta(i, "_composite_children"));
    const giftMeta = (i.meta_data ?? []).some((m: any) => /free_gift|_wfg_|_gift/i.test(String(m?.key ?? "")));
    const zero = num(i.total) === 0 && num(i.price) === 0;
    return { key: String(i.id), name: String(i.name ?? "").slice(0, 300) || "פריט", sku: i.sku ? String(i.sku) : undefined, quantity: Number(i.quantity ?? 0), price: num(i.price),
      kind: parentKey ? "component" : isParent ? "bundle" : giftMeta || zero ? "gift" : "product", parentKey };
  });
  const tracking = meta(o, "_wc_shipment_tracking_items");
  const shipments: Shipment[] = Array.isArray(tracking) ? tracking.map((t: any, n: number) => ({ key: String(t.tracking_id ?? n), status: "shipped" as const, carrier: t.tracking_provider || t.custom_tracking_provider || undefined, tracking: t.tracking_number || undefined, shippedAt: t.date_shipped ? iso(Number(t.date_shipped) * 1000) : undefined, items: [] })) : [];
  const b = o.billing ?? {};
  return { externalId: String(o.id), orderNumber: String(o.number ?? o.id), status: WOO_STATUS[o.status] ?? "processing", phone: b.phone || undefined, email: b.email || undefined, currency: o.currency, total: num(o.total), placedAt: iso(o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created), items, shipments };
}

/**
 * Shopify order → snapshot. Quantities after edits (current_quantity), refunded quantities per line (refunds),
 * native bundles (sales_line_item_groups → a bundle line + its component lines), free / fully discounted lines as
 * gifts, fulfillments as shipments with their exact line items (split shipments) and delivery status.
 */
export function shopifyOrderSnapshot(p: any): OrderSnapshot {
  const refunded = new Map<string, number>();
  for (const r of p.refunds ?? []) for (const rl of r.refund_line_items ?? []) refunded.set(String(rl.line_item_id), (refunded.get(String(rl.line_item_id)) ?? 0) + Number(rl.quantity ?? 0));
  const groups: any[] = p.sales_line_item_groups ?? [];
  const items: OrderItem[] = groups.map((g) => ({ key: `group:${g.id}`, name: String(g.title ?? "מארז"), quantity: Number(g.quantity ?? 1), kind: "bundle" as const }));
  for (const i of p.line_items ?? []) {
    const price = num(i.price) ?? 0;
    const discounted = (i.discount_allocations ?? []).reduce((s: number, d: any) => s + Number(d.amount ?? 0), 0);
    const qty = Number(i.current_quantity ?? i.quantity ?? 0);
    const free = price === 0 || (qty > 0 && discounted >= price * Number(i.quantity ?? qty) - 0.001);
    const group = i.sales_line_item_group_id ? `group:${i.sales_line_item_group_id}` : undefined;
    items.push({ key: String(i.id), name: [i.title, i.variant_title].filter(Boolean).join(" – ").slice(0, 300) || "פריט", sku: i.sku || undefined, quantity: qty, refundedQuantity: refunded.get(String(i.id)), price, kind: group ? "component" : free ? (price === 0 ? "gift" : "benefit") : "product", parentKey: group });
  }
  const DELIVERY: Record<string, Shipment["status"]> = { delivered: "delivered", failure: "failed", in_transit: "shipped", out_for_delivery: "shipped", confirmed: "shipped", label_printed: "pending", label_purchased: "pending", attempted_delivery: "shipped", ready_for_pickup: "shipped" };
  const shipments: Shipment[] = (p.fulfillments ?? []).filter((f: any) => f.status !== "cancelled").map((f: any) => ({
    key: String(f.id), status: (f.shipment_status && DELIVERY[f.shipment_status]) ?? (f.status === "success" ? "shipped" : "pending"), carrier: f.tracking_company || undefined, tracking: f.tracking_number || undefined,
    shippedAt: iso(f.created_at), deliveredAt: f.shipment_status === "delivered" ? iso(f.updated_at) : undefined,
    items: (f.line_items ?? []).map((l: any) => ({ key: String(l.id), name: String(l.title ?? l.name ?? "פריט"), quantity: Number(l.quantity ?? 0) })),
  }));
  const status: OrderSnapshot["status"] = p.cancelled_at ? "cancelled" : p.financial_status === "refunded" ? "refunded" : p.financial_status === "partially_refunded" ? "partially_refunded" : p.fulfillment_status === "fulfilled" ? "completed" : p.financial_status === "paid" ? "paid" : "processing";
  const phone = p.phone || p.shipping_address?.phone || p.billing_address?.phone || p.customer?.phone || undefined;
  return { externalId: String(p.id), orderNumber: String(p.name ?? p.order_number ?? p.id), status, phone, email: p.email ?? p.customer?.email ?? undefined, currency: p.currency, total: num(p.current_total_price ?? p.total_price), placedAt: iso(p.created_at), items, shipments };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
