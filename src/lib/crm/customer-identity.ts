/**
 * One identity per person inside a business, and one answer to "is this an existing customer and who handles them".
 *
 * Existing customer = the facts, not a tag: a won deal, a store order (converted / recovered cart) or a payment the
 * payment provider confirmed. `contacts.customer_since` is kept in step as a cache (markPurchase) but never decides.
 *
 * Handling agent (who may work the person): the owner of an open lead; otherwise the contact's owner when that user is
 * an active agent; otherwise the seller of the last won deal when still active. A customer whose handler is gone has no
 * handler → a person decides (review), nobody picks them up by round robin or a campaign.
 *
 * Every query here is scoped by business id; the same phone in another business is another person.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema, type Db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { OPEN_LEAD_STATUSES } from "./labels";

const T = (t: string) => Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."${t}"`);

/** SQL: the contact (`contactCol` in business `businessCol`) has bought. Same definition as `customerFacts`. */
export function isCustomerSql(contactCol: Prisma.Sql, businessCol: Prisma.Sql) {
  return Prisma.sql`(EXISTS (SELECT 1 FROM ${T("deals")} cd WHERE cd.business_id = ${businessCol} AND cd.contact_id = ${contactCol} AND cd.status = 'won')
    OR EXISTS (SELECT 1 FROM ${T("carts")} cc WHERE cc.business_id = ${businessCol} AND cc.contact_id = ${contactCol} AND cc.status IN ('converted', 'recovered'))
    OR EXISTS (SELECT 1 FROM ${T("payment_requests")} cp WHERE cp.business_id = ${businessCol} AND cp.contact_id = ${contactCol} AND cp.status = 'succeeded'))`;
}

/** SQL: the handling agent of a contact that has no open lead (NULL = none). `c` = the contacts row alias. */
export function handlerSql(c: string) {
  const C = Prisma.raw(c);
  return Prisma.sql`COALESCE(
    (SELECT hu.id FROM ${T("users")} hu WHERE hu.id = ${C}.owner_user_id AND hu.business_id = ${C}.business_id AND hu.is_active AND hu.role = 'agent'),
    (SELECT hd.owner_user_id FROM ${T("deals")} hd JOIN ${T("users")} su ON su.id = hd.owner_user_id AND su.is_active
      WHERE hd.business_id = ${C}.business_id AND hd.contact_id = ${C}.id AND hd.status = 'won' ORDER BY hd.closed_at DESC NULLS LAST LIMIT 1))`;
}

export interface CustomerFacts {
  contactId: string;
  isCustomer: boolean;
  purchases: number;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  /** Active user handling the person (see header), with name. */
  handler: { id: string; fullName: string } | null;
  /** A customer / owned person whose handler is no longer active – needs a person's decision. */
  handlerInactive: { id: string; fullName: string } | null;
  openLeads: Array<{ id: string; status: string; ownerUserId: string | null; ownerName: string | null; reviewReason: string | null }>;
}

/** Facts for several contacts of one business (batched – safe for lists). */
export async function customerFacts(businessId: string, contactIds: string[], db: Db = prisma): Promise<Map<string, CustomerFacts>> {
  const ids = [...new Set(contactIds)].filter(Boolean);
  const out = new Map<string, CustomerFacts>();
  if (!ids.length) return out;
  const [contacts, deals, carts, payments, leads] = await Promise.all([
    db.contact.findMany({ where: { businessId, id: { in: ids } }, select: { id: true, owner: { select: { id: true, fullName: true, isActive: true, role: true } } } }),
    db.deal.findMany({ where: { businessId, contactId: { in: ids }, status: "won" }, orderBy: { closedAt: "desc" }, select: { contactId: true, closedAt: true, createdAt: true, owner: { select: { id: true, fullName: true, isActive: true } } } }),
    db.cart.findMany({ where: { businessId, contactId: { in: ids }, status: { in: ["converted", "recovered"] } }, select: { contactId: true, convertedAt: true, updatedAt: true } }),
    db.paymentRequest.findMany({ where: { businessId, contactId: { in: ids }, status: "succeeded" }, select: { contactId: true, confirmedAt: true } }),
    db.lead.findMany({ where: { businessId, contactId: { in: ids }, status: { in: [...OPEN_LEAD_STATUSES] } }, orderBy: { createdAt: "asc" }, select: { id: true, contactId: true, status: true, ownerUserId: true, reviewReason: true, owner: { select: { fullName: true, isActive: true } } } }),
  ]);
  for (const c of contacts) {
    const dates: Date[] = [];
    const myDeals = deals.filter((d) => d.contactId === c.id);
    for (const d of myDeals) dates.push(d.closedAt ?? d.createdAt);
    for (const x of carts) if (x.contactId === c.id) dates.push(x.convertedAt ?? x.updatedAt);
    for (const p of payments) if (p.contactId === c.id && p.confirmedAt) dates.push(p.confirmedAt);
    const paymentsCount = payments.filter((p) => p.contactId === c.id).length;
    const purchases = myDeals.length + carts.filter((x) => x.contactId === c.id).length + paymentsCount;
    dates.sort((a, b) => a.getTime() - b.getTime());
    const open = leads.filter((l) => l.contactId === c.id);
    const openOwner = open.find((l) => l.ownerUserId && l.owner?.isActive);
    const ownerAgent = c.owner && c.owner.isActive && c.owner.role === "agent" ? c.owner : null;
    const seller = myDeals.find((d) => d.owner)?.owner ?? null;
    const handler = openOwner ? { id: openOwner.ownerUserId!, fullName: openOwner.owner!.fullName }
      : ownerAgent ? { id: ownerAgent.id, fullName: ownerAgent.fullName }
      : seller?.isActive ? { id: seller.id, fullName: seller.fullName } : null;
    const gone = !handler ? (c.owner && !c.owner.isActive && c.owner.role === "agent" ? c.owner : seller && !seller.isActive ? seller : null) : null;
    out.set(c.id, {
      contactId: c.id, isCustomer: purchases > 0, purchases,
      firstPurchaseAt: dates[0] ?? null, lastPurchaseAt: dates[dates.length - 1] ?? null,
      handler, handlerInactive: gone ? { id: gone.id, fullName: gone.fullName } : null,
      openLeads: open.map((l) => ({ id: l.id, status: l.status, ownerUserId: l.ownerUserId, ownerName: l.owner?.fullName ?? null, reviewReason: l.reviewReason })),
    });
  }
  return out;
}

export async function customerFactsOne(businessId: string, contactId: string, db: Db = prisma) {
  return (await customerFacts(businessId, [contactId], db)).get(contactId) ?? null;
}

/**
 * A purchase was recorded (any path: closing screen, call result "sale", a deal moved to won, a store order).
 * Marks the customer (cache) and takes them out of acquisition campaigns' pending rows – they belong to renewals now.
 * Rows in a live claim / call are left alone; the dial eligibility check stops them.
 */
export async function markPurchase(db: Db, input: { businessId: string; contactId: string; at?: Date; actorUserId?: string | null; via: string }) {
  const at = input.at ?? new Date();
  await db.contact.updateMany({ where: { id: input.contactId, businessId: input.businessId, OR: [{ customerSince: null }, { customerSince: { gt: at } }] }, data: { customerSince: at } });
  const left = await db.listLead.updateMany({
    where: { businessId: input.businessId, contactId: input.contactId, status: { in: ["pending", "callback"] }, list: { audience: "new_prospects" } },
    data: { status: "completed", nextAttemptAt: null, preferredUserId: null, lastSkipReason: "existing_customer" },
  });
  await audit(input.businessId, input.actorUserId ?? null, "contact", input.contactId, "contact.purchase_recorded", { via: input.via, acquisitionRowsClosed: left.count }, db);
  return { acquisitionRowsClosed: left.count };
}

/** Hebrew line for the UI / errors: "לקוח קיים · 2 רכישות · אחרונה 12.09.2026 · מטפל: דנה". */
export function customerLine(f: CustomerFacts, tz = "Asia/Jerusalem") {
  const d = f.lastPurchaseAt ? new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(f.lastPurchaseAt) : null;
  return [`לקוח קיים`, f.purchases === 1 ? "רכישה אחת" : `${f.purchases} רכישות`, d ? `אחרונה ${d}` : null, f.handler ? `מטפל: ${f.handler.fullName}` : f.handlerInactive ? `הנציג המטפל (${f.handlerInactive.fullName}) אינו פעיל` : null].filter(Boolean).join(" · ");
}
