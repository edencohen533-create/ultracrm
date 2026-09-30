/**
 * Lead statuses – one source of truth for the CRM, the dialer wrap-up and automations.
 *
 *  • Every status has a stable id and a meaning (`kind` = the LeadStatus enum). What the system does (follow-up needs a
 *    time, sale opens a won deal, closed statuses leave the queues) always follows the kind – never the label.
 *  • The 7 system statuses (one per kind) are created per business, can be renamed / reordered, never deleted.
 *  • Custom statuses carry a kind; a lead in one has `status = kind` + `statusDefId = id` (DB trigger keeps them in step).
 *  • Deleting a custom status needs a replacement of the same meaning when leads or automations use it; the row is
 *    soft-deleted so calls / audits that point at it stay valid.
 *  • Changing the structure (add / rename / reorder / reactivate / delete) is for the business owner only.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { LeadStatus } from "@/generated/prisma/enums";
import type { SessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { DEFAULT_LEAD_STATUSES, type LeadStatusKey } from "@/lib/lead-statuses";

type Db = Prisma.TransactionClient | typeof prisma;
export const STATUS_KINDS = DEFAULT_LEAD_STATUSES.map((s) => s.key) as LeadStatusKey[];
export interface StatusRow { id: string; kind: LeadStatusKey; label: string; sortOrder: number; isSystem: boolean; active: boolean }

const pick = { id: true, kind: true, label: true, sortOrder: true, isSystem: true, active: true } as const;

/** Businesses created after the migration get their system statuses on first use (idempotent). */
export async function ensureSystemStatuses(businessId: string, db: Db = prisma) {
  const have = await db.leadStatusDef.count({ where: { businessId, isSystem: true } });
  if (have >= STATUS_KINDS.length) return;
  await db.leadStatusDef.createMany({
    data: DEFAULT_LEAD_STATUSES.map((s, i) => ({ id: `lsd${crypto.randomUUID().replaceAll("-", "")}`, businessId, kind: s.key, label: s.label, sortOrder: i, isSystem: true, active: true })),
    skipDuplicates: true,
  });
}

/** Statuses of a business in display order (deleted ones only on request – e.g. to label history). */
export async function listStatuses(businessId: string, opts: { includeDeleted?: boolean } = {}, db: Db = prisma): Promise<StatusRow[]> {
  await ensureSystemStatuses(businessId, db);
  const rows = await db.leadStatusDef.findMany({ where: { businessId, ...(opts.includeDeleted ? {} : { deletedAt: null }) }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: pick });
  return rows as StatusRow[];
}

/**
 * A status chosen by id (or, for older clients, by kind → the system status). Returns what to write on the lead:
 * `status` (the meaning) and `statusDefId` (null for a system status).
 */
export async function resolveStatus(businessId: string, ref: { statusId?: string | null; kind?: string | null }, db: Db = prisma, opts: { allowInactive?: boolean } = {}) {
  await ensureSystemStatuses(businessId, db);
  const def = ref.statusId
    ? await db.leadStatusDef.findFirst({ where: { id: ref.statusId, businessId, deletedAt: null }, select: pick })
    : ref.kind ? await db.leadStatusDef.findFirst({ where: { businessId, isSystem: true, kind: ref.kind as LeadStatus }, select: pick }) : null;
  if (!def) throw new ApiError("סטטוס לא קיים", 400, "invalid_status");
  if (!def.active && !opts.allowInactive) throw new ApiError("הסטטוס אינו פעיל", 400, "status_inactive");
  return { def: def as StatusRow, status: def.kind as LeadStatusKey, statusDefId: def.isSystem ? null : def.id };
}

function assertOwner(user: SessionUser) {
  if (user.role !== "owner") throw new ApiError("שינוי מבנה הסטטוסים זמין לבעל העסק בלבד", 403, "owner_only");
}

export const createStatusSchema = z.object({ label: z.string().trim().min(1).max(40), kind: z.enum(STATUS_KINDS as [LeadStatusKey, ...LeadStatusKey[]]) });
export async function createStatus(user: SessionUser, input: z.infer<typeof createStatusSchema>) {
  assertOwner(user);
  await ensureSystemStatuses(user.businessId);
  if (await prisma.leadStatusDef.findFirst({ where: { businessId: user.businessId, deletedAt: null, label: { equals: input.label, mode: "insensitive" } }, select: { id: true } })) throw new ApiError("כבר קיים סטטוס בשם הזה", 409, "duplicate_label");
  const last = await prisma.leadStatusDef.aggregate({ where: { businessId: user.businessId, deletedAt: null }, _max: { sortOrder: true } });
  const row = await prisma.leadStatusDef.create({ data: { businessId: user.businessId, kind: input.kind, label: input.label, sortOrder: (last._max.sortOrder ?? 0) + 1, isSystem: false, active: true, createdById: user.id }, select: pick });
  await audit(user.businessId, user.id, "lead_status", row.id, "lead_status.created", { label: row.label, kind: row.kind });
  return row as StatusRow;
}

export const updateStatusesSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), label: z.string().trim().min(1).max(40), active: z.boolean().optional() })).min(1).max(200) });
/** Rename / reorder (array order) / reactivate. Deactivating is not offered – a status is removed by deleting it. */
export async function updateStatuses(user: SessionUser, input: z.infer<typeof updateStatusesSchema>) {
  assertOwner(user);
  const current = await listStatuses(user.businessId);
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const it of input.items) if (!byId.has(it.id)) throw new ApiError("סטטוס לא קיים", 400, "invalid_status");
  const labels = input.items.map((i) => i.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new ApiError("לשני סטטוסים אותו שם", 409, "duplicate_label");
  if (input.items.some((i) => i.active === false && byId.get(i.id)!.active)) throw new ApiError("אי אפשר להשבית סטטוס – אפשר למחוק סטטוס שנוסף", 400, "deactivate_not_supported");
  const changes: Array<Record<string, unknown>> = [];
  await prisma.$transaction(async (tx) => {
    // Statuses left out of the list keep their place after the ones sent.
    const order = [...input.items.map((i) => i.id), ...current.filter((s) => !input.items.some((i) => i.id === s.id)).map((s) => s.id)];
    for (const [i, id] of order.entries()) {
      const was = byId.get(id)!; const it = input.items.find((x) => x.id === id);
      const data: Prisma.LeadStatusDefUpdateInput = { sortOrder: i };
      if (it && it.label !== was.label) { data.label = it.label; changes.push({ id, from: was.label, to: it.label }); }
      if (it?.active === true && !was.active) { data.active = true; changes.push({ id, reactivated: true }); }
      await tx.leadStatusDef.update({ where: { id }, data });
    }
    await audit(user.businessId, user.id, "lead_status", user.businessId, "lead_status.updated", { changes, order }, tx);
  });
  return listStatuses(user.businessId);
}

/** What deleting a status would touch: leads in it (open / closed) and automations triggered by it. */
export async function deletionImpact(businessId: string, id: string, db: Db = prisma) {
  const def = await db.leadStatusDef.findFirst({ where: { id, businessId, deletedAt: null }, select: pick });
  if (!def) throw new ApiError("סטטוס לא קיים", 404, "not_found");
  const [leads, openLeads, sequences] = await Promise.all([
    db.lead.count({ where: { businessId, statusDefId: id } }),
    db.lead.count({ where: { businessId, statusDefId: id, closedAt: null } }),
    db.marketingSequence.findMany({ where: { businessId, trigger: "LEAD_STATUS_CHANGED", triggerConfig: { path: ["leadStatus"], equals: id } }, select: { id: true, name: true, isActive: true } }),
  ]);
  const replacements = (await listStatuses(businessId, {}, db)).filter((s) => s.id !== id && s.kind === def.kind && s.active);
  return { status: def as StatusRow, deletable: !def.isSystem, leads, openLeads, automations: sequences, needsReplacement: leads > 0 || sequences.length > 0, replacements };
}

export const deleteStatusSchema = z.object({ replacementId: z.string().min(1).optional() });
/**
 * Delete a custom status. Leads and automations that use it move to a replacement of the SAME meaning (so no
 * follow-up / sale / close side effect happens by accident); every moved lead gets a history entry; the row is
 * soft-deleted so old calls and audits keep a valid reference.
 */
export async function deleteStatus(user: SessionUser, id: string, input: z.infer<typeof deleteStatusSchema>) {
  assertOwner(user);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-status:" + user.businessId}, 0))`);
    const impact = await deletionImpact(user.businessId, id, tx);
    if (!impact.deletable) throw new ApiError("זה סטטוס מערכת – אפשר לשנות את שמו, לא למחוק אותו", 409, "system_status");
    let replacement: StatusRow | null = null;
    if (impact.needsReplacement) {
      if (!input.replacementId) throw new ApiError("הסטטוס בשימוש – יש לבחור סטטוס חלופי", 409, "replacement_required", { leads: impact.leads, automations: impact.automations.length });
      replacement = impact.replacements.find((r) => r.id === input.replacementId) ?? null;
      if (!replacement) throw new ApiError("הסטטוס החלופי חייב להיות פעיל ובאותה משמעות", 400, "invalid_replacement");
    }
    let moved = 0;
    if (replacement && impact.leads) {
      const leads = await tx.lead.findMany({ where: { businessId: user.businessId, statusDefId: id }, select: { id: true } });
      // Same meaning → only the id changes (the trigger allows it; status stays).
      const r = await tx.lead.updateMany({ where: { businessId: user.businessId, statusDefId: id }, data: { statusDefId: replacement.isSystem ? null : replacement.id } });
      moved = r.count;
      await tx.auditLog.createMany({ data: leads.map((l) => ({ businessId: user.businessId, actorId: user.id, entityType: "lead", entityId: l.id, action: "lead.status_replaced", payload: { from: impact.status.label, to: replacement!.label, reason: "status_deleted" } })) });
    }
    const repoint = replacement ? (replacement.isSystem ? replacement.kind : replacement.id) : null;
    for (const seq of impact.automations) {
      const cfg = ((await tx.marketingSequence.findUniqueOrThrow({ where: { id: seq.id }, select: { triggerConfig: true } })).triggerConfig ?? {}) as Record<string, unknown>;
      await tx.marketingSequence.update({ where: { id: seq.id }, data: { triggerConfig: { ...cfg, leadStatus: repoint } as Prisma.InputJsonValue } });
    }
    await tx.leadStatusDef.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    await audit(user.businessId, user.id, "lead_status", id, "lead_status.deleted", { label: impact.status.label, kind: impact.status.kind, replacement: replacement ? { id: replacement.id, label: replacement.label } : null, leadsMoved: moved, automationsMoved: impact.automations.map((a) => a.id) }, tx);
    return { deleted: id, leadsMoved: moved, automationsMoved: impact.automations.length, replacement };
  });
}
