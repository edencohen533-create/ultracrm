/**
 * "תיק לקוח" shown next to a WhatsApp conversation: the lead (owner, status, source, product, campaign, ad) and, for a
 * customer, what was bought and when (won deals + their products, store orders) plus open opportunities – both when
 * both exist. Documents exchanged in the customer's conversations are listed as files (streamed by the existing,
 * scope-checked attachment route).
 *
 * Only facts stored in the CRM are returned – a missing value is `null`, never guessed. Visibility is the same as the
 * contact card: CRM data needs `crm.view` and access to the contact; leads / deals follow the owner scope.
 */
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ownerScope, conversationScope } from "@/lib/crm/access";
import { canAccessContact } from "@/lib/crm/lead-ops";
import { OPEN_LEAD_STATUSES } from "@/lib/crm/labels";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const DOCUMENT = (mime: string) => !/^(image|audio|video)\//.test(mime);

export interface CustomerFile {
  contact: { id: string; name: string; phone: string; email: string | null; product: string | null; campaign: string | null; ad: string | null; source: string | null; owner: string | null };
  /** No CRM permission / contact belongs to someone else: only the identity above is shown. */
  restricted: null | "no_crm" | "not_yours";
  leads: Array<{ id: string; status: string; open: boolean; source: string | null; owner: string | null; createdAt: string; adId: string | null; campaignId: string | null }>;
  /** Leads of this contact the viewer may not see (owned by another agent). */
  hiddenLeads: number;
  purchases: Array<{ id: string; title: string; amount: number; currency: string; closedAt: string | null; owner: string | null; items: Array<{ name: string; quantity: number; unitPrice: number; startsAt: string; endsAt: string | null }> }>;
  opportunities: Array<{ id: string; title: string; amount: number; currency: string; stage: string; owner: string | null; expectedCloseAt: string | null }>;
  orders: Array<{ id: string; orderId: string | null; total: number | null; currency: string | null; at: string | null; store: string; items: Array<{ name: string; quantity: number | null; price: number | null }>; status?: string; shipments?: string[]; receiptUrl?: string | null }>;
  /** Checked complaints (e.g. missing item) – claim, order checked, finding, next step, sources. */
  cases: Array<{ id: string; kind: string; finding: string; status: string; summary: string; orderNumber: string | null; createdAt: string; sources: Array<{ type: string; id: string; label: string; at?: string }> }>;
  documents: Array<{ id: string; fileName: string | null; mimeType: string; url: string; createdAt: string }>;
}

export async function customerFile(user: SessionUser, contactId: string, opts: { crmView: boolean }): Promise<CustomerFile | null> {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId }, select: { id: true, fullName: true, phoneE164: true, email: true, source: true, customFields: true, ownerUserId: true, owner: { select: { fullName: true } } } });
  if (!c) return null;
  const cf = (c.customFields && typeof c.customFields === "object" ? c.customFields : {}) as Record<string, unknown>;
  const base: CustomerFile = {
    contact: { id: c.id, name: c.fullName, phone: c.phoneE164, email: c.email, product: str(cf.product), campaign: str(cf.campaign), ad: str(cf.ad), source: c.source, owner: c.owner?.fullName ?? null },
    restricted: null, leads: [], hiddenLeads: 0, purchases: [], opportunities: [], orders: [], cases: [], documents: [],
  };
  // Documents from the conversations this user can open with this contact (never other contacts' threads).
  const docs = await prisma.messageAttachment.findMany({
    where: { message: { conversation: { contactId: c.id, businessId: user.businessId, ...conversationScope(user) } } },
    orderBy: { createdAt: "desc" }, take: 50, select: { id: true, fileName: true, mimeType: true, url: true, createdAt: true },
  });
  base.documents = docs.filter((d) => DOCUMENT(d.mimeType) && d.url.startsWith("/api/attachments/")).map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }));
  if (!opts.crmView) return { ...base, restricted: "no_crm", contact: { ...base.contact, product: null, campaign: null, ad: null, source: null, owner: null } };
  if (!(await canAccessContact(user, c))) return { ...base, restricted: "not_yours", contact: { ...base.contact, product: null, campaign: null, ad: null, source: null, owner: null } };

  const scope = ownerScope(await visibleUserIds(user));
  const [leads, allLeads, deals, carts] = await Promise.all([
    prisma.lead.findMany({ where: { businessId: user.businessId, contactId: c.id, ...scope }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, source: true, createdAt: true, sourceAttribution: true, owner: { select: { fullName: true } } } }),
    prisma.lead.count({ where: { businessId: user.businessId, contactId: c.id } }),
    prisma.deal.findMany({ where: { businessId: user.businessId, contactId: c.id, ...scope }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, amount: true, currency: true, stage: true, status: true, closedAt: true, expectedCloseAt: true, owner: { select: { fullName: true } }, items: { orderBy: { startsAt: "asc" }, select: { name: true, quantity: true, unitPrice: true, startsAt: true, endsAt: true } } } }),
    prisma.cart.findMany({ where: { businessId: user.businessId, contactId: c.id, status: { in: ["converted", "recovered"] } }, orderBy: { convertedAt: "desc" }, take: 20, select: { id: true, orderId: true, orderTotal: true, total: true, currency: true, convertedAt: true, items: true, store: { select: { name: true } } } }),
  ]);
  const attr = (v: unknown, k: string) => (v && typeof v === "object" ? str((v as Record<string, unknown>)[k]) : null);
  base.leads = leads.map((l) => ({ id: l.id, status: l.status, open: (OPEN_LEAD_STATUSES as readonly string[]).includes(l.status), source: l.source, owner: l.owner?.fullName ?? null, createdAt: l.createdAt.toISOString(), adId: attr(l.sourceAttribution, "adId"), campaignId: attr(l.sourceAttribution, "campaignId") }));
  base.hiddenLeads = Math.max(0, allLeads - leads.length);
  base.purchases = deals.filter((d) => d.status === "won").map((d) => ({ id: d.id, title: d.title, amount: Number(d.amount), currency: d.currency, closedAt: d.closedAt?.toISOString() ?? null, owner: d.owner?.fullName ?? null, items: d.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: Number(i.unitPrice), startsAt: i.startsAt.toISOString(), endsAt: i.endsAt?.toISOString() ?? null })) }));
  base.opportunities = deals.filter((d) => d.status === "open").map((d) => ({ id: d.id, title: d.title, amount: Number(d.amount), currency: d.currency, stage: d.stage, owner: d.owner?.fullName ?? null, expectedCloseAt: d.expectedCloseAt?.toISOString() ?? null }));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  base.orders = carts.map((o) => ({
    id: o.id, orderId: o.orderId, total: o.orderTotal != null ? Number(o.orderTotal) : o.total != null ? Number(o.total) : null, currency: o.currency, at: o.convertedAt?.toISOString() ?? null, store: o.store.name,
    items: (Array.isArray(o.items) ? o.items : []).map((i) => { const r = (i ?? {}) as Record<string, unknown>; return { name: str(r.name) ?? "—", quantity: num(r.quantity), price: num(r.price) }; }),
  }));
  // Orders as sold (store / order API snapshots) replace the cart view of the same order.
  const [storeOrders, cases] = await Promise.all([
    prisma.storeOrder.findMany({ where: { businessId: user.businessId, contactId: c.id }, orderBy: { placedAt: "desc" }, take: 20 }),
    prisma.serviceCase.findMany({ where: { businessId: user.businessId, contactId: c.id }, orderBy: { createdAt: "desc" }, take: 20, include: { order: { select: { orderNumber: true } } } }),
  ]);
  if (storeOrders.length) {
    const { describeOrder } = await import("@/server/ai/missing-items");
    const snap = new Set(storeOrders.map((o) => o.orderNumber));
    base.orders = [
      ...storeOrders.map((o) => {
        const items = describeOrder({ items: o.items as never });
        const ships = ((o.shipments ?? []) as Array<{ status: string; carrier?: string; tracking?: string; items?: Array<{ name: string; quantity: number }> }>).map((s) => `${s.carrier ?? "משלוח"} ${s.tracking ?? ""} – ${s.status}${s.items?.length ? ` (${s.items.map((i) => `${i.quantity} ${i.name}`).join(", ")})` : ""}`.replace(/\s+/g, " "));
        return { id: o.id, orderId: o.orderNumber, total: o.total != null ? Number(o.total) : null, currency: o.currency, at: o.placedAt?.toISOString() ?? null, store: o.source, status: o.status, items: items.map((line) => ({ name: line, quantity: null, price: null })), shipments: ships, receiptUrl: ((o.receipt ?? null) as { url?: string } | null)?.url ?? null };
      }),
      ...base.orders.filter((o) => !o.orderId || !snap.has(o.orderId)),
    ];
  }
  base.cases = cases.map((k) => ({ id: k.id, kind: k.kind, finding: k.finding, status: k.status, summary: k.summary, orderNumber: k.order?.orderNumber ?? null, createdAt: k.createdAt.toISOString(), sources: (k.sources ?? []) as never }));
  return base;
}
