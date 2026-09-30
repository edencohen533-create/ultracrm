/**
 * WooCommerce payloads → our records, keeping the order AS SOLD (the catalog is never consulted for a past order).
 *  • Items: variation + SKU + quantity + unit price + line total / tax; bundles & composites (plugin meta) with their
 *    component lines; free lines as gifts; refunded quantities per line from the order's refunds (refund line items
 *    carry `_refunded_item_id`).
 *  • Totals as the store computed them (discount, coupons, tax, shipping, fees, refunded).
 *  • Payment CONFIRMATION (method, gateway transaction id, date_paid) – never presented as a receipt.
 *  • Documents: https links found in order meta (invoice / receipt / label plugins) – kept with the meta key as their
 *    source and flagged unverified; an order page is never called a receipt.
 *  • Shipments: the "Shipment Tracking" plugin meta (no per-item mapping → never proof for an item).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { normalizePhone } from "@/lib/phone";
import { wooOrderSnapshot, type OrderSnapshot, type OrderExtras } from "@/server/services/store-order-service";

const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
export const wooDate = (gmt?: string | null, local?: string | null) => { const v = gmt ? `${gmt.replace(/Z$/, "")}Z` : local; if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const meta = (x: any, key: string) => (Array.isArray(x?.meta_data) ? x.meta_data.find((m: any) => m?.key === key)?.value : undefined);

const DOC_KEY = /(invoice|receipt|kabala|kabbala|heshbonit|חשבונית|קבלה|document|doc_url|pdf|label)/i;
function documentsOf(o: any) {
  const out: Array<{ source: string; kind: string; url: string }> = [];
  const visit = (key: string, v: unknown) => {
    if (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v) && DOC_KEY.test(key)) out.push({ source: key.slice(0, 80), kind: /receipt|kabala|kabbala|קבלה/i.test(key) ? "receipt_link" : /invoice|heshbonit|חשבונית/i.test(key) ? "invoice_link" : /label/i.test(key) ? "shipping_label" : "document", url: v.slice(0, 1000) });
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) visit(`${key}.${k}`, x);
  };
  for (const m of o.meta_data ?? []) if (m?.key) visit(String(m.key), m.value);
  return out.slice(0, 10);
}

/** Refunded quantity per original line item id (from GET /orders/{id}/refunds). */
export function refundedByLine(refunds: any[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of refunds ?? []) for (const li of r.line_items ?? []) {
    const orig = meta(li, "_refunded_item_id"); const q = Math.abs(Number(li.quantity ?? 0));
    if (orig && q) out.set(String(orig), (out.get(String(orig)) ?? 0) + q);
  }
  return out;
}

export function wooOrderFull(o: any, refunds?: any[] | null): { snapshot: OrderSnapshot; extras: OrderExtras; customerId: string | null } {
  const base = wooOrderSnapshot(o);
  const refunded = refunds ? refundedByLine(refunds) : null;
  const byId = new Map<string, any>((o.line_items ?? []).map((i: any) => [String(i.id), i]));
  base.items = (base.items ?? []).map((it) => {
    const src = byId.get(it.key);
    const variant = (src?.meta_data ?? []).filter((m: any) => m?.display_key && !String(m.key).startsWith("_")).map((m: any) => `${m.display_key}: ${m.display_value ?? m.value}`).join(", ").slice(0, 300) || undefined;
    return { ...it, productId: src?.product_id ? String(src.product_id) : undefined, variationId: src?.variation_id ? String(src.variation_id) : undefined, variant, total: num(src?.total), tax: num(src?.total_tax), ...(refunded?.get(it.key) ? { refundedQuantity: refunded.get(it.key) } : {}) };
  });
  const refundedTotal = (o.refunds ?? []).reduce((s: number, r: any) => s + Math.abs(Number(r.total ?? 0)), 0);
  if (refundedTotal > 0 && base.status !== "refunded" && base.status !== "cancelled") base.status = "partially_refunded";
  const b = o.billing ?? {}; const sh = o.shipping ?? {};
  const extras: OrderExtras = {
    totals: { subtotal: (o.line_items ?? []).reduce((s: number, i: any) => s + Number(i.subtotal ?? 0), 0), discount: num(o.discount_total), discountTax: num(o.discount_tax), tax: num(o.total_tax), shipping: num(o.shipping_total), fees: (o.fee_lines ?? []).reduce((s: number, f: any) => s + Number(f.total ?? 0), 0), total: num(o.total), refunded: refundedTotal || undefined, coupons: (o.coupon_lines ?? []).map((c: any) => ({ code: c.code, discount: num(c.discount) })), shippingLines: (o.shipping_lines ?? []).map((l: any) => ({ method: l.method_title, total: num(l.total) })) },
    payment: o.date_paid_gmt || o.transaction_id || o.payment_method ? { method: o.payment_method || null, title: o.payment_method_title || null, transactionId: o.transaction_id || null, paidAt: wooDate(o.date_paid_gmt, o.date_paid)?.toISOString() ?? null, note: "אישור תשלום מהחנות – אינו קבלה" } : null,
    addresses: { billing: { name: [b.first_name, b.last_name].filter(Boolean).join(" ") || null, city: b.city || null, phone: b.phone || null, email: b.email || null }, shipping: { name: [sh.first_name, sh.last_name].filter(Boolean).join(" ") || null, city: sh.city || null, method: (o.shipping_lines ?? [])[0]?.method_title ?? null } },
    documents: documentsOf(o),
    sourceModifiedAt: wooDate(o.date_modified_gmt, o.date_modified),
  };
  return { snapshot: base, extras, customerId: o.customer_id ? String(o.customer_id) : null };
}

/** What the store actually has, from real orders (shown on the status screen – nothing assumed). */
export function detectCapabilities(o: any) {
  const keys = new Set<string>((o.meta_data ?? []).map((m: any) => String(m?.key ?? "")));
  for (const i of o.line_items ?? []) for (const m of i.meta_data ?? []) keys.add(String(m?.key ?? ""));
  return {
    payment: o.payment_method ? [`${o.payment_method}${o.payment_method_title ? ` (${o.payment_method_title})` : ""}`] : [],
    shipping: [...keys].filter((k) => /tracking|shipment|hfd|cargo|lionwheel|ups|dhl/i.test(k)).slice(0, 5),
    documents: documentsOf(o).map((d) => `${d.source} → ${d.kind}`),
    bundles: [...keys].filter((k) => /_bundled_by|_bundle_cart_key|_composite_parent|_composite_cart_key|_woosb/i.test(k)).slice(0, 5),
  };
}

export function wooCustomer(c: any) {
  const b = c.billing ?? {};
  const rawPhone = b.phone || "";
  return { externalId: String(c.id), email: (c.email || b.email || "").toLowerCase() || null, phoneE164: rawPhone ? normalizePhone(rawPhone) : null, phoneRaw: rawPhone || null, name: [c.first_name || b.first_name, c.last_name || b.last_name].filter(Boolean).join(" ") || null, modifiedAt: wooDate(c.date_modified_gmt, c.date_modified) };
}

export function wooProduct(p: any) {
  const components = Array.isArray(p.bundled_items) ? p.bundled_items.map((b: any) => ({ productId: b.product_id ? String(b.product_id) : null, quantity: Number(b.quantity_default ?? b.quantity_min ?? 1) })) : Array.isArray(p.composite_components) ? p.composite_components.map((c: any) => ({ title: c.title ?? null })) : null;
  return { externalId: String(p.id), parentExternalId: p.parent_id ? String(p.parent_id) : null, name: String(p.name ?? "").slice(0, 300) || "מוצר", sku: p.sku || null, type: p.type || null, status: p.status || null, price: num(p.price) ?? null, components, modifiedAt: wooDate(p.date_modified_gmt, p.date_modified) };
}
