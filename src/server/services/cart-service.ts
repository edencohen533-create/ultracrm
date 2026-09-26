/**
 * Abandoned carts: every source (site script, Shopify webhooks, WooCommerce webhooks) is normalized into
 * ingestCart / ingestOrder. A cart with contact details and no activity for `abandonAfterMinutes` becomes
 * "abandoned" and emits `cart.abandoned` (journeys with the CART_ABANDONED trigger start from it). An order for the
 * cart marks it "converted", or "recovered" when a journey had already messaged the customer about it.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { Prisma, type StoreConnection } from "@/generated/prisma/client";
import { normalizePhone } from "@/lib/phone";
import { contactForIdentifier } from "@/lib/suppression";
import { findOrCreateContactByPhone } from "@/lib/crm/contacts";
import { emitEvent } from "@/lib/events";
import { openConfig, sealConfig } from "@/server/channels/registry";

export const STORE_SECRET_KEYS = ["webhookSecret"] as const;
export const cartItemSchema = z.object({ name: z.string().trim().max(300), quantity: z.coerce.number().min(0).max(100000).default(1), price: z.coerce.number().min(0).max(10_000_000).optional(), url: z.string().max(1000).optional(), image: z.string().max(1000).optional() });
export const cartInputSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional(),
  name: z.string().trim().max(200).optional(),
  currency: z.string().trim().max(10).optional(),
  total: z.coerce.number().min(0).max(100_000_000).optional(),
  items: z.array(cartItemSchema).max(200).optional(),
  checkoutUrl: z.string().trim().max(2000).optional(),
  acceptsMarketing: z.boolean().optional(),
});
export type CartInput = z.infer<typeof cartInputSchema>;
export const orderInputSchema = z.object({ externalId: z.string().trim().max(200).optional(), orderId: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().max(200).optional(), phone: z.string().trim().max(40).optional(), total: z.coerce.number().min(0).max(100_000_000).optional(), currency: z.string().max(10).optional() });
export type OrderInput = z.infer<typeof orderInputSchema>;

export const newPublicKey = () => `st_${crypto.randomBytes(12).toString("base64url")}`;
export const newWebhookSecret = () => crypto.randomBytes(24).toString("base64url");
export function storeSecret(store: Pick<StoreConnection, "config">) { return openConfig(store.config).webhookSecret ?? ""; }
export function sealStoreConfig(cfg: Record<string, unknown>) { return sealConfig(cfg, STORE_SECRET_KEYS) as Prisma.InputJsonValue; }
/** Shopify & WooCommerce both sign the raw body: base64(HMAC-SHA256(secret, body)). */
export function verifyStoreSignature(secret: string, rawBody: string, signature: string | null) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected); const b = Buffer.from(signature.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u.slice(0, 2000) : undefined);

/** Link the cart to a CRM contact: phone → find or create; email only → existing contact with that email. */
async function resolveContact(store: StoreConnection, input: { email?: string; phone?: string; name?: string; acceptsMarketing?: boolean }) {
  const e164 = input.phone ? normalizePhone(input.phone) : null;
  if (e164) {
    const c = await findOrCreateContactByPhone(store.businessId, e164, { fullName: input.name?.trim() || input.email || e164, phoneRaw: input.phone!, source: store.platform === "custom" ? "website" : store.platform });
    const data: Prisma.ContactUpdateInput = {};
    if (input.email && !c.email) data.email = input.email;
    // Marketing consent only when the store says the customer opted in at checkout (never inferred).
    if (input.acceptsMarketing === true && c.consentStatus === "UNKNOWN") { data.consentStatus = "OPTED_IN"; data.consentAt = new Date(); data.consentEvidence = `${store.platform} checkout: accepts marketing`; }
    if (Object.keys(data).length) await prisma.contact.update({ where: { id: c.id }, data }).catch(() => undefined);
    return { contactId: c.id, phoneE164: e164 };
  }
  if (input.email) return { contactId: await contactForIdentifier(store.businessId, input.email), phoneE164: null };
  return { contactId: null, phoneE164: null };
}

export async function ingestCart(store: StoreConnection, raw: CartInput) {
  const input = cartInputSchema.parse(raw);
  const email = input.email || undefined;
  const existing = await prisma.cart.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: input.externalId } } });
  if (existing && (existing.status === "converted" || existing.status === "recovered")) return existing; // late update after purchase
  const who = (email || input.phone) ? await resolveContact(store, { email, phone: input.phone, name: input.name, acceptsMarketing: input.acceptsMarketing }) : { contactId: existing?.contactId ?? null, phoneE164: existing?.phoneE164 ?? null };
  const data = {
    email: email ?? existing?.email ?? null, phoneE164: who.phoneE164 ?? existing?.phoneE164 ?? null, contactId: who.contactId ?? existing?.contactId ?? null,
    customerName: input.name ?? existing?.customerName ?? null, currency: input.currency ?? existing?.currency ?? null,
    total: input.total !== undefined ? new Prisma.Decimal(input.total) : existing?.total ?? null,
    items: (input.items ?? (existing?.items as Prisma.InputJsonValue | undefined) ?? []) as Prisma.InputJsonValue,
    checkoutUrl: safeUrl(input.checkoutUrl) ?? existing?.checkoutUrl ?? null,
    acceptsMarketing: input.acceptsMarketing ?? existing?.acceptsMarketing ?? null,
    lastActivityAt: new Date(),
    // Activity after abandonment re-opens the cart (the customer came back).
    status: "open", abandonedAt: null,
  };
  const cart = await prisma.cart.upsert({ where: { storeId_externalId: { storeId: store.id, externalId: input.externalId } }, create: { businessId: store.businessId, storeId: store.id, externalId: input.externalId, ...data }, update: data });
  await prisma.storeConnection.update({ where: { id: store.id }, data: { lastEventAt: new Date() } });
  return cart;
}

export async function ingestOrder(store: StoreConnection, raw: OrderInput) {
  const input = orderInputSchema.parse(raw);
  const email = input.email?.includes("@") ? input.email : undefined;
  const e164 = input.phone ? normalizePhone(input.phone) : null;
  // The order's own cart first; otherwise the customer's most recent open/abandoned cart in the last 14 days.
  const cart = (input.externalId ? await prisma.cart.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: input.externalId } } }) : null)
    ?? (email || e164 ? await prisma.cart.findFirst({ where: { storeId: store.id, status: { in: ["open", "abandoned"] }, updatedAt: { gte: new Date(Date.now() - 14 * 86400_000) }, OR: [...(email ? [{ email }] : []), ...(e164 ? [{ phoneE164: e164 }] : [])] }, orderBy: { lastActivityAt: "desc" } }) : null);
  await prisma.storeConnection.update({ where: { id: store.id }, data: { lastEventAt: new Date() } });
  if (!cart || cart.status === "converted" || cart.status === "recovered") return cart;
  const recovered = cart.status === "abandoned" && Boolean(cart.recoveryMessageAt);
  return prisma.cart.update({ where: { id: cart.id }, data: { status: recovered ? "recovered" : "converted", convertedAt: new Date(), orderId: input.orderId, orderTotal: input.total !== undefined ? new Prisma.Decimal(input.total) : cart.total } });
}

/** Cron: open carts with contact details and no activity for the store's threshold → abandoned (+ event). */
export async function processAbandonedCarts(businessId: string) {
  const stores = await prisma.storeConnection.findMany({ where: { businessId, isActive: true }, select: { id: true, abandonAfterMinutes: true } });
  let marked = 0;
  for (const s of stores) {
    const due = await prisma.cart.findMany({ where: { storeId: s.id, status: "open", lastActivityAt: { lte: new Date(Date.now() - s.abandonAfterMinutes * 60_000) }, OR: [{ contactId: { not: null } }, { email: { not: null } }] }, take: 200, select: { id: true, contactId: true, lastActivityAt: true } });
    for (const c of due) {
      const r = await prisma.cart.updateMany({ where: { id: c.id, status: "open", lastActivityAt: c.lastActivityAt }, data: { status: "abandoned", abandonedAt: new Date() } });
      if (!r.count) continue;
      marked++;
      if (c.contactId) await emitEvent(prisma, { businessId, type: "cart.abandoned", contactId: c.contactId, source: "system", dedupeKey: `cart.abandoned:${c.id}:${c.lastActivityAt.getTime()}`, payload: { cartId: c.id } });
    }
  }
  return { processed: marked };
}

/** Merge values for recovery messages: {{cart_url}}, {{cart_total}}, {{cart_items}} (and {cart_url} etc. in WhatsApp variables). */
export async function cartMergeValues(cartId: string) {
  const c = await prisma.cart.findUnique({ where: { id: cartId }, select: { checkoutUrl: true, total: true, currency: true, items: true, status: true } });
  if (!c) return null;
  const items = (Array.isArray(c.items) ? c.items : []) as Array<{ name?: string; quantity?: number }>;
  return { status: c.status, values: { cart_url: c.checkoutUrl ?? "", cart_total: c.total ? `${Number(c.total).toLocaleString("he-IL")} ${c.currency ?? ""}`.trim() : "", cart_items: items.slice(0, 5).map((i) => `${i.name ?? ""}${i.quantity && i.quantity > 1 ? ` ×${i.quantity}` : ""}`).filter(Boolean).join(", ") } };
}
