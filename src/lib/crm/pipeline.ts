import {adAttribution} from "./ad-attribution";
import { hasTouchData, normalizeTouch, recordTouchpoint, touchFromFields, touchSnapshot, type Channel, type TouchInput } from "@/lib/marketing/touchpoints";
/**
 * Leads, deals, tasks and notes of the CRM core.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { assertTenantReferences } from "@/lib/tenant-references";
import { assertCanSeeUser, visibleUserIds, type SessionUser } from "@/lib/auth";
import { assertOwnerAccess, ownerScope, conversationScope } from "./access";
import { attemptStats, canAccessContact, canTransferLeads, followUpsFor, personalListId, transferLeads, waitingToday } from "./lead-ops";
import { getBusinessSettings } from "@/lib/settings";

// ─── Leads ───────────────────────────────────────────────────────────────────

import { LEAD_STATUSES, DEAL_STAGES } from "./labels";
import { listStatuses, resolveStatus } from "./statuses";
export { LEAD_STATUSES, LEAD_STATUS_LABEL, DEAL_STAGES, DEAL_STAGE_LABEL } from "./labels";

export const leadInputSchema = z.object({
  contactId: z.string().min(1),
  title: z.string().trim().max(160).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  /** The business's status (stable id, system or custom). Wins over `status`, which older clients still send. */
  statusId: z.string().min(1).optional(),
  source: z.string().max(100).optional(),
  ownerUserId: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(4000).optional(),
});
export const leadPatchSchema = leadInputSchema.partial().omit({ contactId: true });

export const leadFilterSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  /** A specific status: custom → exactly it; system → its meaning without a custom status. */
  statusId: z.string().optional(),
  /** Only leads whose contact is in this dial list (the list screen reuses the leads workspace). */
  listId: z.string().optional(),
  ownerUserId: z.string().optional(),
  q: z.string().max(100).optional(),
  source: z.string().max(100).optional(),
  product: z.string().max(160).optional(),
  campaign: z.string().max(160).optional(),
  ad: z.string().max(160).optional(),
  createdFrom: z.string().datetime({ offset: true }).optional(),
  createdTo: z.string().datetime({ offset: true }).optional(),
  /** "ממתינים לשיחה היום" category (same ids as the card; ignores the created-date range). */
  waiting: z.enum(["total", "new", "today", "overdue", "schedule"]).optional(),
  sort: z.enum(["createdAt", "name", "status", "owner", "source"]).default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const LEAD_INCLUDE = { contact: { select: { id: true, fullName: true, phoneE164: true, email: true, company: true, customFields: true } }, owner: { select: { id: true, fullName: true } } } satisfies Prisma.LeadInclude;

/** Where-clause for one status id: a custom status is exactly its id; a system status is its meaning without a custom one. */
async function statusFilter(businessId: string, statusId: string): Promise<Prisma.LeadWhereInput> {
  const def = (await listStatuses(businessId, { includeDeleted: true })).find((s) => s.id === statusId);
  if (!def) return { id: "__none__" };
  return def.isSystem ? { status: def.kind, statusDefId: null } : { statusDefId: def.id };
}

export async function listLeads(user: SessionUser, f: z.infer<typeof leadFilterSchema>) {
  const ids = await visibleUserIds(user);
  const scope = { businessId: user.businessId, ...ownerScope(ids) };
  const metadata: Prisma.LeadWhereInput[] = (["product", "campaign", "ad"] as const).flatMap((key) => f[key] ? [{ contact: { customFields: { path: [key], string_contains: f[key], mode: "insensitive" } } }] : []);
  const where: Prisma.LeadWhereInput = {
    businessId: user.businessId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.statusId ? await statusFilter(user.businessId, f.statusId) : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.ownerUserId ? { ownerUserId: f.ownerUserId === "unassigned" ? null : f.ownerUserId } : {}),
    ...(f.waiting ? { id: { in: (await waitingToday(user, f.ownerUserId || null)).ids[f.waiting] } } : {}),
    ...(!f.waiting && (f.createdFrom || f.createdTo) ? { createdAt: { ...(f.createdFrom ? { gte: new Date(f.createdFrom) } : {}), ...(f.createdTo ? { lt: new Date(f.createdTo) } : {}) } } : {}),
    AND: [ownerScope(ids), ...metadata],
    ...(f.q ? { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { contact: { fullName: { contains: f.q, mode: "insensitive" } } }, { contact: { email: { contains: f.q, mode: "insensitive" } } }, ...(f.q.replace(/\D/g, "").length >= 3 ? [{ contact: { phoneE164: { contains: f.q.replace(/\D/g, "") } } }] : [])] } : {}),
  };
  if (f.listId) where.contact = { ...(where.contact as Prisma.ContactWhereInput | undefined ?? {}), queueLeads: { some: { listId: f.listId } } };
  const order: Prisma.LeadOrderByWithRelationInput = f.sort === "name" ? { contact: { fullName: f.direction } } : f.sort === "owner" ? { owner: { fullName: f.direction } } : { [f.sort]: f.direction };
  const [total, items, byStatus, byOwner, sources, deals, owners] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({ where, orderBy: [order, { id: "asc" }], skip: (f.page - 1) * f.limit, take: f.limit, include: LEAD_INCLUDE }),
    prisma.lead.groupBy({ by: ["status", "statusDefId"], where: scope, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["ownerUserId"], where, _count: { _all: true }, orderBy: { _count: { ownerUserId: "desc" } } }),
    prisma.lead.findMany({ where: { ...scope, source: { not: null } }, distinct: ["source"], select: { source: true }, orderBy: { source: "asc" } }),
    prisma.deal.aggregate({ where: { businessId: user.businessId, status: "won", currency: "ILS", lead: where, ...ownerScope(ids) }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.user.findMany({ where: { businessId: user.businessId, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true } }),
  ]);
  const converted = await prisma.lead.count({ where: { AND: [where, { deals: { some: { status: "won", ...ownerScope(ids) } } }] } });
  const [attempts, followUps, settings] = await Promise.all([attemptStats(user.businessId, items.map((l) => l.contactId)), followUpsFor(user.businessId, items), getBusinessSettings(user.businessId)]);
  const transferTo = await prisma.user.findMany({ where: { id: { in: items.flatMap((l) => (l.pendingTransferToUserId ? [l.pendingTransferToUserId] : [])) } }, select: { id: true, fullName: true } });
  const now = Date.now();
  const limits = await (await import("@/lib/dialer/exhaustion")).limitsForOwners(user.businessId, items.map((l) => l.ownerUserId));
  const hot = await prisma.callbackSignal.findMany({ where: { businessId: user.businessId, contactId: { in: items.map((l) => l.contactId) }, status: "active", expiresAt: { gt: new Date() } }, select: { id: true, contactId: true, requestedAt: true, text: true, messageId: true } });
  const enriched = items.map((l) => {
    const fu = followUps.get(l.id); const a = attempts.get(l.id);
    const h = hot.find((x) => x.contactId === l.contactId);
    return { ...l, availableNow: h ? { signalId: h.id, at: h.requestedAt, text: h.text } : null, attempts: a?.count ?? 0, attemptLimit: limits.get(l.ownerUserId ?? "") || null, lastAttemptAt: a?.lastAt ?? null,
      followUp: fu ? { taskId: fu.taskId, dueAt: fu.dueAt, note: fu.note, overdue: fu.dueAt.getTime() < now } : null,
      needsSchedule: l.status === "follow_up" && !fu,
      pendingTransfer: l.pendingTransferToUserId ? { to: transferTo.find((u) => u.id === l.pendingTransferToUserId)?.fullName ?? null, at: l.pendingTransferAt } : null };
  });
  return { items: enriched, total, page: f.page, limit: f.limit, timezone: settings.timezone, permissions: { canTransfer: await canTransferLeads(user) },
    byStatus: byStatus.reduce<Record<string, number>>((m, s) => { m[s.status] = (m[s.status] ?? 0) + s._count._all; return m; }, {}),
    /** Per status id (custom statuses apart from the system status of the same meaning). */
    byStatusId: await (async () => { const defs = await listStatuses(user.businessId, { includeDeleted: true }); return byStatus.reduce<Record<string, number>>((m, s) => { const id = s.statusDefId ?? defs.find((d) => d.isSystem && d.kind === s.status)?.id ?? s.status; m[id] = (m[id] ?? 0) + s._count._all; return m; }, {}); })(),
    // "לידים לפי נציג" is the owner's table; everyone else gets only their own row.
    byOwner: byOwner.filter((g) => user.role === "owner" || g.ownerUserId === user.id).map((g) => ({ id: g.ownerUserId, name: owners.find((o) => o.id === g.ownerUserId)?.fullName ?? "ללא שיוך", count: g._count._all })),
    sources: sources.map((s) => s.source!).filter(Boolean),
    metrics: { leads: total, deals: deals._count._all, revenue: Number(deals._sum.amount ?? 0), conversion: total ? converted / total * 100 : 0 },
  };
}

/**
 * Every lead enters here (screen, public API / forms, import, WhatsApp assistant). Intake rules – one identity per person:
 * - an open lead already exists → no second lead: channels / import reuse it (recorded as a repeat inquiry, owner
 *   untouched); the screen gets a clear 409.
 * - an existing customer (bought before) → a new opportunity marked "existing customer", routed to the handling
 *   agent; with no active handler it waits for a manager (review) – never round robin.
 * - a person owned by an active agent → that agent. Another owner only by an explicit choice of a user who may
 *   transfer leads, from the screen – and it is recorded.
 */
/** Where this inquiry came from (API / form fields, import columns, …) – recorded as a touchpoint, never overwriting earlier ones. */
export interface LeadIntake { touch?: TouchInput; channel?: Channel; dataSource?: string; dedupeKey?: string | null; occurredAt?: Date }

export async function createLead(user: SessionUser, input: z.infer<typeof leadInputSchema>, source: "user" | "import" | "webhook" = "user", intake: LeadIntake = {}) {
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true, source: true, customFields: true } });
  if (!contact || !(await canAccessContact(user, contact))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.ownerUserId) await assertCanSeeUser(user, input.ownerUserId);
  if (input.ownerUserId) await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  const { customerFactsOne } = await import("./customer-identity");
  const facts = await customerFactsOne(user.businessId, contact.id);
  if (facts?.openLeads.length) {
    const open = facts.openLeads[0];
    if (source === "user") throw new ApiError(`לאיש הקשר כבר יש ליד פתוח${open.ownerName ? ` אצל ${open.ownerName}` : ""} – אין צורך בליד נוסף`, 409, "open_lead_exists", { leadId: open.id });
    await audit(user.businessId, user.id, "lead", open.id, "lead.repeat_inquiry", { via: source, source: input.source ?? null, requestedOwner: input.ownerUserId ?? null });
    // A repeat inquiry is its own touchpoint (it may come from another ad); the lead's original source stays as it was.
    await recordTouchpoint(prisma, { businessId: user.businessId, contactId: contact.id, leadId: open.id, touch: { ...intake.touch, source: intake.touch?.source ?? input.source }, fallback: intake.channel ?? (source === "import" ? "import" : "api"), dataSource: intake.dataSource ?? source, dedupeKey: intake.dedupeKey ?? null, occurredAt: intake.occurredAt });
    const existing = await prisma.lead.findUniqueOrThrow({ where: { id: open.id }, include: LEAD_INCLUDE });
    return Object.assign(existing, { reused: true as boolean, routedTo: null as string | null });
  }
  let ownerUserId: string | null = input.ownerUserId === undefined ? null : input.ownerUserId;
  let reviewReason: string | null = null;
  let routedTo: string | null = null;
  const handler = facts?.handler ?? null;
  if (handler && handler.id !== ownerUserId) {
    const explicit = ownerUserId !== null && source === "user" && (await canTransferLeads(user));
    if (!explicit) { routedTo = ownerUserId && ownerUserId !== handler.id ? handler.id : null; ownerUserId = handler.id; }
  } else if (!handler && facts?.isCustomer && ownerUserId === null) {
    reviewReason = facts.handlerInactive ? "handler_inactive" : "no_handler";
  }
  const existingCustomer = Boolean(facts?.isCustomer);
  const fallback: Channel = intake.channel ?? (source === "import" ? "import" : source === "webhook" ? "api" : "manual");
  // Explicit intake data wins. Otherwise (screen / assistant) the contact's own submitted ids are used only when the
  // contact has no touchpoint yet (a person who arrived before touchpoints existed) – never inherited by a later inquiry.
  let touch: TouchInput = { ...intake.touch, source: intake.touch?.source ?? input.source ?? contact.source ?? undefined };
  let dataSource = intake.dataSource ?? (source === "user" ? "screen" : source);
  if (!hasTouchData(intake.touch ?? {}) && !(await prisma.leadTouchpoint.findFirst({ where: { businessId: user.businessId, contactId: contact.id }, select: { id: true } }))) {
    const legacy = touchFromFields(contact.customFields);
    if (normalizeTouch(legacy, fallback).basis === "meta_ids") { touch = { ...legacy, ...touch, adId: legacy.adId, adsetId: legacy.adsetId, campaignId: legacy.campaignId }; dataSource = `${dataSource}+contact_fields`; }
  }
  const lead = await prisma.$transaction(async (tx) => {
    const l = await tx.lead.create({
      data: { sourceAttribution: hasTouchData(intake.touch ?? {}) ? touchSnapshot(touch, fallback) : adAttribution(contact.customFields), businessId: user.businessId, contactId: contact.id, title: input.title || null, status: input.status ?? "new", source: input.source ?? contact.source ?? null, ownerUserId, priority: input.priority ?? 0, notes: input.notes || null, existingCustomer, reviewReason },
      include: LEAD_INCLUDE,
    });
    await recordTouchpoint(tx, { businessId: user.businessId, contactId: contact.id, leadId: l.id, touch, fallback, dataSource, dedupeKey: intake.dedupeKey ?? `lead:${l.id}`, occurredAt: intake.occurredAt ?? l.createdAt });
    await audit(user.businessId, user.id, "lead", l.id, "lead.created", { contactId: contact.id, ownerUserId: l.ownerUserId, via: source, existingCustomer, reviewReason, routedToHandler: routedTo, requestedOwner: input.ownerUserId ?? null }, tx);
    await emitEvent(tx, { businessId: user.businessId, type: "lead.created", contactId: contact.id, actorUserId: user.id, source, dedupeKey: `lead.created:${l.id}`, payload: { leadId: l.id, ownerUserId: l.ownerUserId, source: l.source, existingCustomer, reviewReason } });
    return l;
  });
  kickEventProcessing(user.businessId);
  return Object.assign(lead, { reused: false as boolean, routedTo });
}

export async function updateLead(user: SessionUser, id: string, input: z.infer<typeof leadPatchSchema>) {
  const lead = await prisma.lead.findFirst({ where: { id, businessId: user.businessId } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  await assertOwnerAccess(user, lead.ownerUserId);
  // The chosen status → its meaning (drives every rule below) + the custom status id (null for a system status).
  let statusDefId: string | null | undefined;
  if (input.statusId || input.status) {
    const r = await resolveStatus(user.businessId, { statusId: input.statusId, kind: input.statusId ? null : input.status }, prisma, { allowInactive: input.statusId === lead.statusDefId });
    input = { ...input, status: r.status }; statusDefId = r.statusDefId;
    delete input.statusId;
  }
  // "פולואפ" always has a time: it is set through the follow-up endpoint (date + time), never as a bare status.
  if (input.status === "follow_up" && lead.status !== "follow_up" && !(await followUpsFor(user.businessId, [lead])).get(lead.id)) throw new ApiError("לפולואפ חובה לבחור תאריך ושעה", 400, "follow_up_time_required");
  // A manager moving a lead to an agent is a transfer (tasks, follow-ups, queue and access move with it).
  if (input.ownerUserId && user.role !== "agent" && input.ownerUserId !== lead.ownerUserId) {
    const r = await transferLeads(user, { leadIds: [lead.id], toUserId: input.ownerUserId });
    if (r.notFound.length) throw new ApiError("ליד לא נמצא", 404, "not_found");
    const { ownerUserId: _moved, ...rest } = input; void _moved;
    if (!Object.keys(rest).length) return prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: LEAD_INCLUDE });
    input = rest;
  }
  const leavingFollowUp = lead.status === "follow_up" && input.status && input.status !== "follow_up";
  if (input.ownerUserId) {
    if (user.role === "agent" && input.ownerUserId !== user.id) throw new ApiError("נציג יכול לשייך ליד לעצמו בלבד", 403, "forbidden");
    await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  }
  const closing = input.status && ["unqualified", "converted", "lost"].includes(input.status);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...(input.title !== undefined ? { title: input.title || null } : {}),
        ...(input.status ? { status: input.status, statusDefId: statusDefId ?? null, ...(input.status !== lead.status ? { closedAt: closing ? new Date() : null, closeReason: null } : {}) } : {}),
        ...(input.source !== undefined ? { source: input.source || null } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      },
      include: LEAD_INCLUDE,
    });
    await audit(user.businessId, user.id, "lead", lead.id, "lead.updated", { fields: Object.keys(input), status: input.status }, tx);
    // Leaving "פולואפ" (or closing the lead) cancels its schedule so the dialer will not call it at the old time.
    if (leavingFollowUp || closing) {
      const cancelled = await tx.task.updateMany({ where: { businessId: user.businessId, status: "open", type: "callback", OR: [{ leadId: lead.id }, { contactId: lead.contactId, leadId: null }] }, data: { status: "cancelled" } });
      if (cancelled.count) await tx.listLead.updateMany({ where: { businessId: user.businessId, contactId: lead.contactId, status: "callback" }, data: { status: closing ? "completed" : "pending", nextAttemptAt: null, preferredUserId: null } });
      if (closing && lead.ownerUserId) { const pl = await personalListId(tx, user.businessId, lead.ownerUserId); if (pl) await tx.listLead.updateMany({ where: { listId: pl, contactId: lead.contactId, status: { in: ["pending", "callback"] } }, data: { status: "completed", nextAttemptAt: null } }); }
    }
    if (input.status && (input.status !== lead.status || (statusDefId ?? null) !== lead.statusDefId)) {
      await emitEvent(tx, { businessId: user.businessId, type: "lead.status_changed", contactId: lead.contactId, actorUserId: user.id, source: "user", dedupeKey: `lead.status_changed:${lead.id}:${statusDefId ?? input.status}:${Date.now()}`, payload: { leadId: lead.id, from: lead.status, to: input.status, fromStatusId: lead.statusDefId, toStatusId: statusDefId ?? null } });
    }
    return u;
  });
  kickEventProcessing(user.businessId);
  return updated;
}

/** Convert a lead into a deal (lead → converted, deal linked). */
export async function convertLead(user: SessionUser, id: string, deal: { title?: string; amount?: number; currency?: string }) {
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "leads" WHERE id = ${id} AND business_id = ${user.businessId} FOR UPDATE`;
    const lead = await tx.lead.findFirst({ where: { id, businessId: user.businessId }, include: { contact: { select: { fullName: true } } } });
    if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
    await assertOwnerAccess(user, lead.ownerUserId);
    if (lead.status === "converted" && lead.dealId) return tx.deal.findUniqueOrThrow({ where: { id: lead.dealId }, include: DEAL_INCLUDE });
    const d = await tx.deal.create({ data: { businessId: user.businessId, contactId: lead.contactId, leadId: lead.id, title: deal.title || lead.title || `עסקה – ${lead.contact.fullName}`, amount: deal.amount ?? 0, currency: deal.currency ?? "ILS", ownerUserId: lead.ownerUserId ?? user.id }, include: DEAL_INCLUDE });
    await tx.lead.update({ where: { id: lead.id }, data: { status: "converted", dealId: d.id, closedAt: new Date() } });
    await audit(user.businessId, user.id, "lead", lead.id, "lead.converted", { dealId: d.id }, tx);
    await emitEvent(tx, { businessId: user.businessId, type: "deal.created", contactId: lead.contactId, actorUserId: user.id, source: "user", dedupeKey: `deal.created:${d.id}`, payload: { dealId: d.id, leadId: lead.id } });
    return d;
  });
  kickEventProcessing(user.businessId);
  return created;
}

// ─── Deals ───────────────────────────────────────────────────────────────────


export const dealInputSchema = z.object({
  contactId: z.string().min(1),
  leadId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  amount: z.coerce.number().min(0).max(1e9).optional(),
  currency: z.string().length(3).optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  ownerUserId: z.string().nullable().optional(),
  expectedCloseAt: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(4000).optional(),
});
export const dealPatchSchema = dealInputSchema.partial().omit({ contactId: true });
export const dealFilterSchema = z.object({
  status: z.enum(["open", "won", "lost"]).optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  ownerUserId: z.string().optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const DEAL_INCLUDE = { contact: { select: { id: true, fullName: true, phoneE164: true, company: true } }, owner: { select: { id: true, fullName: true } } } satisfies Prisma.DealInclude;

function stageToStatus(stage: (typeof DEAL_STAGES)[number]) {
  return stage === "won" ? "won" : stage === "lost" ? "lost" : "open";
}

export async function listDeals(user: SessionUser, f: z.infer<typeof dealFilterSchema>) {
  const ids = await visibleUserIds(user);
  const where: Prisma.DealWhereInput = {
    businessId: user.businessId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.stage ? { stage: f.stage } : {}),
    ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    AND: [ownerScope(ids)],
    ...(f.q ? { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { contact: { fullName: { contains: f.q, mode: "insensitive" } } }] } : {}),
  };
  const [total, items, sums] = await Promise.all([
    prisma.deal.count({ where }),
    prisma.deal.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (f.page - 1) * f.limit, take: f.limit, include: DEAL_INCLUDE }),
    prisma.deal.groupBy({ by: ["stage"], where: { businessId: user.businessId, ...ownerScope(ids) }, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  return { items, total, page: f.page, limit: f.limit, byStage: Object.fromEntries(sums.map((s) => [s.stage, { count: s._count._all, amount: Number(s._sum.amount ?? 0) }])) };
}

export async function createDeal(user: SessionUser, input: z.infer<typeof dealInputSchema>) {
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (!contact || !(await canAccessContact(user, contact))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.ownerUserId) await assertCanSeeUser(user, input.ownerUserId);
  if (input.leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: input.leadId, businessId: user.businessId, contactId: contact.id } });
    if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
    await assertOwnerAccess(user, lead.ownerUserId);
  }
  if (input.ownerUserId) await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  const stage = input.stage ?? "new";
  const deal = await prisma.$transaction(async (tx) => {
    if (input.leadId) {
      await tx.$queryRaw`SELECT id FROM "leads" WHERE id = ${input.leadId} AND business_id = ${user.businessId} FOR UPDATE`;
      const lead = await tx.lead.findFirst({ where: { id: input.leadId, contactId: contact.id, businessId: user.businessId } });
      if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
      await assertOwnerAccess(user, lead.ownerUserId);
      if (lead.dealId) throw new ApiError("הליד כבר הומר לעסקה", 409, "already_converted");
    }
    const d = await tx.deal.create({
      data: { businessId: user.businessId, contactId: contact.id, leadId: input.leadId ?? null, title: input.title, amount: input.amount ?? 0, currency: input.currency ?? "ILS", stage, status: stageToStatus(stage), closedAt: stage === "won" || stage === "lost" ? new Date() : null, ownerUserId: input.ownerUserId === undefined ? user.id : input.ownerUserId, expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null, notes: input.notes || null },
      include: DEAL_INCLUDE,
    });
    if (input.leadId) await tx.lead.update({ where: { id: input.leadId }, data: { status: "converted", dealId: d.id, closedAt: new Date() } });
    if (stage === "won") await (await import("./customer-identity")).markPurchase(tx, { businessId: user.businessId, contactId: contact.id, actorUserId: user.id, via: "deal_created_won" });
    await audit(user.businessId, user.id, "deal", d.id, "deal.created", { contactId: contact.id, amount: d.amount.toString() }, tx);
    await emitEvent(tx, { businessId: user.businessId, type: stage === "won" ? "deal.won" : "deal.created", contactId: contact.id, actorUserId: user.id, source: "user", dedupeKey: `deal.created:${d.id}`, payload: { dealId: d.id, amount: Number(d.amount), stage } });
    return d;
  });
  kickEventProcessing(user.businessId);
  return deal;
}

export async function updateDeal(user: SessionUser, id: string, input: z.infer<typeof dealPatchSchema>) {
  const deal = await prisma.deal.findFirst({ where: { id, businessId: user.businessId } });
  if (!deal) throw new ApiError("עסקה לא נמצאה", 404, "not_found");
  await assertOwnerAccess(user, deal.ownerUserId);
  if (input.ownerUserId) await assertCanSeeUser(user, input.ownerUserId);
  if (input.ownerUserId) await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  const stage = input.stage;
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.deal.update({
      where: { id: deal.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(stage ? { stage, status: stageToStatus(stage), closedAt: stage === "won" || stage === "lost" ? new Date() : null } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.expectedCloseAt !== undefined ? { expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      },
      include: DEAL_INCLUDE,
    });
    await audit(user.businessId, user.id, "deal", deal.id, "deal.updated", { fields: Object.keys(input), stage }, tx);
    if (stage === "won" && deal.stage !== "won") {
      await (await import("./customer-identity")).markPurchase(tx, { businessId: user.businessId, contactId: deal.contactId, actorUserId: user.id, via: "deal_won" });
      await emitEvent(tx, { businessId: user.businessId, type: "deal.won", contactId: deal.contactId, actorUserId: user.id, source: "user", dedupeKey: `deal.won:${deal.id}`, payload: { dealId: deal.id, amount: Number(u.amount) } });
    }
    // A won deal moved back to an open stage (e.g. cancelled before payment) – knowledge learned from it is re-examined.
    if (stage && deal.stage === "won" && stage !== "won" && stage !== "lost") {
      await emitEvent(tx, { businessId: user.businessId, type: "deal.reopened", contactId: deal.contactId, actorUserId: user.id, source: "user", dedupeKey: `deal.reopened:${deal.id}:${Date.now()}`, payload: { dealId: deal.id, to: stage } });
    }
    if (stage === "lost" && deal.stage !== "lost") {
      await emitEvent(tx, { businessId: user.businessId, type: "deal.lost", contactId: deal.contactId, actorUserId: user.id, source: "user", dedupeKey: `deal.lost:${deal.id}`, payload: { dealId: deal.id, leadId: deal.leadId } });
    }
    return u;
  });
  kickEventProcessing(user.businessId);
  return updated;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const TASK_INCLUDE = {
  contact: { select: { id: true, fullName: true, phoneE164: true } },
  user: { select: { id: true, fullName: true } },
  createdBy: { select: { id: true, fullName: true } },
  listLead: { select: { id: true, listId: true, status: true } },
  lead: { select: { id: true, status: true, title: true } },
  deal: { select: { id: true, title: true } },
} satisfies Prisma.TaskInclude;

export const taskInputSchema = z.object({
  contactId: z.string().min(1),
  title: z.string().trim().max(200).optional(),
  note: z.string().max(4000).optional(),
  type: z.enum(["callback", "follow_up", "todo"]).optional(),
  dueAt: z.string().datetime({ offset: true }),
  /** Assignee (the messaging UI calls it assignedToId). */
  userId: z.string().min(1).optional(),
  assignedToId: z.string().min(1).optional(),
  conversationId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  requestKey: z.string().min(8).max(100).optional(),
});
export const taskPatchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  note: z.string().max(4000).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["open", "done", "cancelled"]).optional(),
  userId: z.string().min(1).optional(),
  assignedToId: z.string().min(1).optional(),
  version: z.number().int().min(0).optional(),
});
export const taskFilterSchema = z.object({
  status: z.enum(["open", "done", "cancelled", "all"]).default("open"),
  userId: z.string().optional(),
  contactId: z.string().optional(),
  conversationId: z.string().optional(),
  type: z.enum(["callback", "follow_up", "todo"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function taskVisibility(user: SessionUser): Promise<Prisma.TaskWhereInput> {
  const ids = await visibleUserIds(user);
  return ids ? { userId: { in: ids } } : {};
}

export async function listTasks(user: SessionUser, f: z.infer<typeof taskFilterSchema>) {
  const ids = await visibleUserIds(user);
  const conversation = f.conversationId ? await prisma.conversation.findFirst({ where: { id: f.conversationId, ...conversationScope(user) }, select: { contactId: true } }) : null;
  if (f.conversationId && !conversation) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const where: Prisma.TaskWhereInput = {
    businessId: user.businessId,
    ...(f.status !== "all" ? { status: f.status } : {}),
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(conversation ? { AND: [{ contactId: conversation.contactId }, { OR: [{ conversationId: f.conversationId }, { conversationId: null }] }] } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.userId ? { userId: ids && !ids.includes(f.userId) ? "__none__" : f.userId } : ids ? { userId: { in: ids } } : {}),
  };
  const [total, items, assignees] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({ where, orderBy: [{ dueAt: "asc" }, { id: "asc" }], skip: (f.page - 1) * f.limit, take: f.limit, include: TASK_INCLUDE }),
    prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
  ]);
  return { items, total, page: f.page, limit: f.limit, assignees, now: new Date().toISOString() };
}

export async function createTask(user: SessionUser, input: z.infer<typeof taskInputSchema>) {
  const assignee = input.userId ?? input.assignedToId ?? user.id;
  if (user.role === "agent" && assignee !== user.id) throw new ApiError("נציג יכול לשייך משימה לעצמו בלבד", 403, "forbidden");
  await assertCanSeeUser(user, assignee);
  await assertTenantReferences(user.businessId, { userIds: [assignee] });
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.conversationId && !(await prisma.conversation.findFirst({ where: { id: input.conversationId, contactId: contact.id, ...conversationScope(user) }, select: { id: true } }))) throw new ApiError("השיחה אינה שייכת לאיש הקשר", 404, "not_found");
  if (!input.conversationId && !(await canAccessContact(user, contact))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const relatedOwnerScope = ownerScope(await visibleUserIds(user));
  if (input.leadId && !(await prisma.lead.findFirst({ where: { id: input.leadId, contactId: contact.id, businessId: user.businessId, ...relatedOwnerScope }, select: { id: true } }))) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (input.dealId && !(await prisma.deal.findFirst({ where: { id: input.dealId, contactId: contact.id, businessId: user.businessId, ...relatedOwnerScope }, select: { id: true } }))) throw new ApiError("עסקה לא נמצאה", 404, "not_found");
  if (input.requestKey) {
    const previous = await prisma.task.findUnique({ where: { businessId_requestKey: { businessId: user.businessId, requestKey: input.requestKey } }, include: TASK_INCLUDE });
    if (previous) {
      await assertCanSeeUser(user, previous.userId);
      if (previous.contactId !== contact.id) throw new ApiError("מפתח הבקשה כבר משויך למשימה אחרת", 409, "conflict");
      return previous;
    }
  }
  const task = await prisma.$transaction(async (tx) => {
    const t = await tx.task.create({
      data: { businessId: user.businessId, userId: assignee, createdById: user.id, contactId: contact.id, conversationId: input.conversationId ?? null, leadId: input.leadId ?? null, dealId: input.dealId ?? null, type: input.type ?? "todo", title: input.title || null, note: input.note || null, dueAt: new Date(input.dueAt), requestKey: input.requestKey ?? null },
      include: TASK_INCLUDE,
    });
    await audit(user.businessId, user.id, "task", t.id, "task.created", { contactId: contact.id, userId: assignee }, tx, input.conversationId ?? null);
    await emitEvent(tx, { businessId: user.businessId, type: "task.created", contactId: contact.id, actorUserId: user.id, source: "user", dedupeKey: `task.created:${t.id}`, payload: { taskId: t.id, userId: assignee } });
    return t;
  });
  kickEventProcessing(user.businessId);
  return task;
}

export async function updateTask(user: SessionUser, id: string, input: z.infer<typeof taskPatchSchema>) {
  const t = await prisma.task.findFirst({ where: { id, businessId: user.businessId } });
  if (!t) throw new ApiError("משימה לא נמצאה", 404, "not_found");
  const ids = await visibleUserIds(user);
  if (ids && !ids.includes(t.userId)) throw new ApiError("אין הרשאה לצפות בנתוני משתמש זה", 403, "forbidden");
  const assignee = input.userId ?? input.assignedToId;
  if (assignee) {
    if (user.role === "agent" && assignee !== user.id) throw new ApiError("נציג יכול לשייך משימה לעצמו בלבד", 403, "forbidden");
    await assertCanSeeUser(user, assignee);
    await assertTenantReferences(user.businessId, { userIds: [assignee] });
  }
  const r = await prisma.task.updateMany({
    where: { id: t.id, ...(input.version !== undefined ? { version: input.version } : {}) },
    data: {
      ...(input.status ? { status: input.status, doneAt: input.status === "done" ? new Date() : null } : {}),
      ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.title !== undefined ? { title: input.title || null } : {}),
      ...(assignee ? { userId: assignee } : {}),
      version: { increment: 1 },
    },
  });
  if (!r.count) throw new ApiError("המשימה שונתה על ידי משתמש אחר. יש לרענן לפני שמירה", 409, "version_conflict");
  // Dialer callbacks: keep the queue item in sync.
  if (input.dueAt && t.listLeadId) await prisma.listLead.updateMany({ where: { id: t.listLeadId, status: "callback" }, data: { nextAttemptAt: new Date(input.dueAt) } });
  if (input.status && input.status !== "open" && t.listLeadId) {
    await prisma.listLead.updateMany({ where: { id: t.listLeadId, status: "callback" }, data: { status: input.status === "done" ? "completed" : "pending", preferredUserId: null, nextAttemptAt: null } });
  }
  await audit(user.businessId, user.id, "task", t.id, "task.updated", { fields: Object.keys(input) }, prisma, t.conversationId);
  return prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: TASK_INCLUDE });
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export const noteInputSchema = z.object({
  contactId: z.string().min(1),
  body: z.string().trim().min(1).max(4000),
  conversationId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
});

export async function createNote(user: SessionUser, input: z.infer<typeof noteInputSchema>) {
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (!contact || !(await canAccessContact(user, contact))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.conversationId && !await prisma.conversation.findFirst({ where: { id: input.conversationId, contactId: contact.id, ...conversationScope(user) }, select: { id: true } })) throw new ApiError("שיחה לא נמצאה או שאין הרשאה", 404, "not_found");
  if (input.dealId) {
    const deal = await prisma.deal.findFirst({ where: { id: input.dealId, contactId: contact.id, businessId: user.businessId }, select: { ownerUserId: true } });
    if (!deal) throw new ApiError("עסקה לא נמצאה", 404, "not_found");
    await assertOwnerAccess(user, deal.ownerUserId);
  }
  const note = await prisma.note.create({ data: { businessId: user.businessId, contactId: contact.id, conversationId: input.conversationId ?? null, dealId: input.dealId ?? null, authorId: user.id, body: input.body }, include: { author: { select: { id: true, fullName: true } } } });
  await prisma.contact.update({ where: { id: contact.id }, data: { lastActivityAt: new Date() } });
  await audit(user.businessId, user.id, "note", note.id, "note.created", { contactId: contact.id }, prisma, input.conversationId ?? null);
  return note;
}
