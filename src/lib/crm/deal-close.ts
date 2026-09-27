/**
 * "עסקה נסגרה": one popup records the won deal, what was bought and for how long, writes a summary note, marks the
 * contact as an existing customer and moves them in the dialer to "לקוחות קיימים – חידושים".
 * Renewals: every product may have an end date. The customer's queue row in that list is due at the earliest open
 * end date, so starting the existing-customers dialer calls exactly the customers whose product has ended.
 * A later purchase closes the renewals that were due by then (renewalHandledAt) and moves the row to the next end date.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { zonedDateTime } from "@/lib/business-day";
import { ownerScope } from "./access";
import { OPEN_LEAD_STATUSES } from "./labels";

type Db = Prisma.TransactionClient;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const closeDealSchema = z.object({
  contactId: z.string().min(1),
  leadId: z.string().optional(),
  title: z.string().trim().max(200).optional(),
  /** Total value; defaults to the sum of the items. */
  amount: z.number().min(0).max(1e10).optional(),
  currency: z.string().trim().length(3).default("ILS"),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(100000).default(1),
    unitPrice: z.number().min(0).max(1e10).default(0),
    startsAt: date,
    endsAt: date.nullable().optional(),
  })).max(50).default([]),
  note: z.string().trim().max(2000).optional(),
});

export const CUSTOMERS_LIST_NAME = "לקוחות קיימים – חידושים";

/** The business's existing-customers dial list (created on first use; not a dynamic list – rows are managed here). */
export async function customersListId(db: Db, businessId: string) {
  const found = await db.dialList.findFirst({ where: { businessId, filterJson: { path: ["system"], equals: "customers" } }, select: { id: true } });
  if (found) return found.id;
  return (await db.dialList.create({ data: { businessId, name: CUSTOMERS_LIST_NAME, description: "לקוחות שסגרו עסקה. החייגן מחייג רק ללקוחות שהמוצר שלהם הסתיים (לפי תאריך הסיום).", filterJson: { system: "customers" }, isDynamic: false } })).id;
}

/** Queue row of a customer: due at the earliest un-renewed end date; no end date → kept but never auto-dialed. */
export async function syncCustomerRow(db: Db, businessId: string, contactId: string, preferredUserId: string | null) {
  const listId = await customersListId(db, businessId);
  const next = await db.dealItem.findFirst({ where: { businessId, contactId, renewalHandledAt: null, endsAt: { not: null } }, orderBy: { endsAt: "asc" }, select: { endsAt: true } });
  const existing = await db.listLead.findUnique({ where: { listId_contactId: { listId, contactId } }, select: { id: true, status: true } });
  const data = next?.endsAt
    ? { status: "pending" as const, nextAttemptAt: next.endsAt, attempts: 0, followUpAttempts: null, preferredUserId, lastOutcome: null }
    : { status: "completed" as const, nextAttemptAt: null, preferredUserId };
  if (!existing) await db.listLead.create({ data: { businessId, listId, contactId, ...data } });
  else if (!["locked", "in_call", "dnc"].includes(existing.status)) await db.listLead.update({ where: { id: existing.id }, data });
  return { listId, renewalAt: next?.endsAt ?? null };
}

const fmtDate = (d: Date, tz: string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
const money = (n: number, cur: string) => `${cur === "ILS" ? "₪" : `${cur} `}${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;

export async function closeDeal(user: SessionUser, input: z.infer<typeof closeDealSchema>) {
  const ids = await visibleUserIds(user);
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, fullName: true, ownerUserId: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const lead = input.leadId
    ? await prisma.lead.findFirst({ where: { id: input.leadId, contactId: contact.id, businessId: user.businessId, ...ownerScope(ids) } })
    : await prisma.lead.findFirst({ where: { contactId: contact.id, businessId: user.businessId, status: { in: [...OPEN_LEAD_STATUSES] }, ...ownerScope(ids) }, orderBy: { createdAt: "desc" } });
  if (input.leadId && !lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (!lead) { const { canAccessContact } = await import("./lead-ops"); if (!(await canAccessContact(user, contact))) throw new ApiError("איש קשר לא נמצא", 404, "not_found"); }
  const { timezone: tz } = await getBusinessSettings(user.businessId);
  const items = input.items.map((i) => {
    const startsAt = zonedDateTime(tz, i.startsAt, "00:00"); const endsAt = i.endsAt ? zonedDateTime(tz, i.endsAt, "09:00") : null;
    if (!startsAt) throw new ApiError("תאריך התחלה לא תקין", 400, "invalid_date");
    if (endsAt && endsAt <= startsAt) throw new ApiError(`תאריך הסיום של "${i.name}" חייב להיות אחרי תאריך ההתחלה`, 400, "invalid_date");
    return { ...i, startsAt, endsAt };
  });
  const sum = items.reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const amount = input.amount ?? sum;
  const ownerId = lead?.ownerUserId ?? contact.ownerUserId ?? user.id;
  const title = input.title || (items.length ? items.map((i) => i.name).join(", ").slice(0, 190) : `עסקה – ${contact.fullName}`);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({ data: { businessId: user.businessId, contactId: contact.id, leadId: lead?.id ?? null, title, amount, currency: input.currency, stage: "won", status: "won", closedAt: now, ownerUserId: ownerId } });
    if (items.length) await tx.dealItem.createMany({ data: items.map((i) => ({ businessId: user.businessId, dealId: deal.id, contactId: contact.id, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, startsAt: i.startsAt, endsAt: i.endsAt })) });
    // A new purchase settles every renewal that was already due (the customer renewed / bought again).
    await tx.dealItem.updateMany({ where: { businessId: user.businessId, contactId: contact.id, dealId: { not: deal.id }, renewalHandledAt: null, endsAt: { lte: new Date(now.getTime() + 14 * 86400_000) } }, data: { renewalHandledAt: now } });
    if (lead) {
      await tx.lead.update({ where: { id: lead.id }, data: { status: "converted", dealId: deal.id, closedAt: now } });
      await tx.task.updateMany({ where: { businessId: user.businessId, status: "open", type: "callback", OR: [{ leadId: lead.id }, { contactId: contact.id, leadId: null }] }, data: { status: "done", doneAt: now } });
      if (lead.status !== "converted") await emitEvent(tx, { businessId: user.businessId, type: "lead.status_changed", contactId: contact.id, actorUserId: user.id, source: "user", dedupeKey: `lead.status_changed:${lead.id}:converted:${now.getTime()}`, payload: { leadId: lead.id, from: lead.status, to: "converted" } });
    }
    await tx.contact.updateMany({ where: { id: contact.id, customerSince: null }, data: { customerSince: now } });
    // Out of every other dial list – the customer now lives in the existing-customers list.
    const listId = await customersListId(tx, user.businessId);
    await tx.listLead.updateMany({ where: { businessId: user.businessId, contactId: contact.id, listId: { not: listId }, status: { in: ["pending", "callback"] } }, data: { status: "completed", nextAttemptAt: null, preferredUserId: null } });
    const row = await syncCustomerRow(tx, user.businessId, contact.id, ownerId);
    const lines = [`✅ עסקה נסגרה: ${title} · ${money(amount, input.currency)}`, ...items.map((i) => `• ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}${i.unitPrice ? ` – ${money(i.unitPrice * i.quantity, input.currency)}` : ""} · מ-${fmtDate(i.startsAt, tz)}${i.endsAt ? ` עד ${fmtDate(i.endsAt, tz)}` : ""}`), ...(row.renewalAt ? [`🔁 שיחת חידוש מתוזמנת ל-${fmtDate(row.renewalAt, tz)}`] : []), ...(input.note ? [input.note] : [])];
    const note = await tx.note.create({ data: { businessId: user.businessId, contactId: contact.id, dealId: deal.id, authorId: user.id, body: lines.join("\n") } });
    await audit(user.businessId, user.id, "deal", deal.id, "deal.closed", { contactId: contact.id, leadId: lead?.id ?? null, amount, items: items.length, renewalAt: row.renewalAt?.toISOString() ?? null }, tx);
    await emitEvent(tx, { businessId: user.businessId, type: "deal.won", contactId: contact.id, actorUserId: user.id, source: "user", dedupeKey: `deal.won:${deal.id}`, payload: { dealId: deal.id, amount, currency: input.currency, title, items: items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, startsAt: i.startsAt, endsAt: i.endsAt })) } });
    return { dealId: deal.id, amount, title, noteId: note.id, renewalAt: row.renewalAt, customersListId: row.listId, leadId: lead?.id ?? null };
  });
  kickEventProcessing(user.businessId);
  return result;
}
