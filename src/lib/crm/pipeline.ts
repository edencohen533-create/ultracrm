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
import { visibleUserIds, type SessionUser } from "@/lib/auth";

// ─── Leads ───────────────────────────────────────────────────────────────────

export const LEAD_STATUSES = ["new", "contacted", "qualified", "unqualified", "converted", "lost"] as const;
export const LEAD_STATUS_LABEL: Record<(typeof LEAD_STATUSES)[number], string> = { new: "חדש", contacted: "נוצר קשר", qualified: "מתאים", unqualified: "לא מתאים", converted: "הומר לעסקה", lost: "אבוד" };

export const leadInputSchema = z.object({
  contactId: z.string().min(1),
  title: z.string().trim().max(160).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.string().max(100).optional(),
  ownerUserId: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(4000).optional(),
});
export const leadPatchSchema = leadInputSchema.partial().omit({ contactId: true });

export const leadFilterSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  ownerUserId: z.string().optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const LEAD_INCLUDE = { contact: { select: { id: true, fullName: true, phoneE164: true, email: true, company: true } }, owner: { select: { id: true, fullName: true } } } satisfies Prisma.LeadInclude;

export async function listLeads(user: SessionUser, f: z.infer<typeof leadFilterSchema>) {
  const ids = await visibleUserIds(user);
  const where: Prisma.LeadWhereInput = {
    businessId: user.businessId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    ...(ids ? { OR: [{ ownerUserId: { in: ids } }, { ownerUserId: null }] } : {}),
    ...(f.q ? { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { contact: { fullName: { contains: f.q, mode: "insensitive" } } }, { contact: { phoneE164: { contains: f.q.replace(/\D/g, "") } } }] } : {}),
  };
  const [total, items, byStatus] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (f.page - 1) * f.limit, take: f.limit, include: LEAD_INCLUDE }),
    prisma.lead.groupBy({ by: ["status"], where: { businessId: user.businessId }, _count: { _all: true } }),
  ]);
  return { items, total, page: f.page, limit: f.limit, byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) };
}

export async function createLead(user: SessionUser, input: z.infer<typeof leadInputSchema>, source: "user" | "import" | "webhook" = "user") {
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true, ownerUserId: true, source: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.ownerUserId) await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  const lead = await prisma.$transaction(async (tx) => {
    const l = await tx.lead.create({
      data: { businessId: user.businessId, contactId: contact.id, title: input.title || null, status: input.status ?? "new", source: input.source ?? contact.source ?? null, ownerUserId: input.ownerUserId === undefined ? null : input.ownerUserId, priority: input.priority ?? 0, notes: input.notes || null },
      include: LEAD_INCLUDE,
    });
    await audit(user.businessId, user.id, "lead", l.id, "lead.created", { contactId: contact.id, ownerUserId: l.ownerUserId }, tx);
    await emitEvent(tx, { businessId: user.businessId, type: "lead.created", contactId: contact.id, actorUserId: user.id, source, dedupeKey: `lead.created:${l.id}`, payload: { leadId: l.id, ownerUserId: l.ownerUserId, source: l.source } });
    return l;
  });
  kickEventProcessing(user.businessId);
  return lead;
}

export async function updateLead(user: SessionUser, id: string, input: z.infer<typeof leadPatchSchema>) {
  const lead = await prisma.lead.findFirst({ where: { id, businessId: user.businessId } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (user.role === "agent" && lead.ownerUserId && lead.ownerUserId !== user.id) throw new ApiError("הליד משויך לנציג אחר", 403, "forbidden");
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
        ...(input.status ? { status: input.status, closedAt: closing ? new Date() : null } : {}),
        ...(input.source !== undefined ? { source: input.source || null } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      },
      include: LEAD_INCLUDE,
    });
    await audit(user.businessId, user.id, "lead", lead.id, "lead.updated", { fields: Object.keys(input), status: input.status }, tx);
    if (input.status && input.status !== lead.status) {
      await emitEvent(tx, { businessId: user.businessId, type: "lead.status_changed", contactId: lead.contactId, actorUserId: user.id, source: "user", dedupeKey: `lead.status_changed:${lead.id}:${input.status}:${Date.now()}`, payload: { leadId: lead.id, from: lead.status, to: input.status } });
    }
    return u;
  });
  kickEventProcessing(user.businessId);
  return updated;
}

/** Convert a lead into a deal (lead → converted, deal linked). */
export async function convertLead(user: SessionUser, id: string, deal: { title?: string; amount?: number; currency?: string }) {
  const lead = await prisma.lead.findFirst({ where: { id, businessId: user.businessId }, include: { contact: { select: { fullName: true } } } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (lead.status === "converted" && lead.dealId) return prisma.deal.findUniqueOrThrow({ where: { id: lead.dealId }, include: DEAL_INCLUDE });
  const created = await prisma.$transaction(async (tx) => {
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

export const DEAL_STAGES = ["new", "proposal", "negotiation", "won", "lost"] as const;
export const DEAL_STAGE_LABEL: Record<(typeof DEAL_STAGES)[number], string> = { new: "חדשה", proposal: "הצעה", negotiation: "משא ומתן", won: "נסגרה", lost: "אבודה" };

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
    ...(ids ? { OR: [{ ownerUserId: { in: ids } }, { ownerUserId: null }] } : {}),
    ...(f.q ? { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { contact: { fullName: { contains: f.q, mode: "insensitive" } } }] } : {}),
  };
  const [total, items, sums] = await Promise.all([
    prisma.deal.count({ where }),
    prisma.deal.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (f.page - 1) * f.limit, take: f.limit, include: DEAL_INCLUDE }),
    prisma.deal.groupBy({ by: ["stage"], where: { businessId: user.businessId }, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  return { items, total, page: f.page, limit: f.limit, byStage: Object.fromEntries(sums.map((s) => [s.stage, { count: s._count._all, amount: Number(s._sum.amount ?? 0) }])) };
}

export async function createDeal(user: SessionUser, input: z.infer<typeof dealInputSchema>) {
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: input.leadId, businessId: user.businessId, contactId: contact.id } });
    if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  }
  if (input.ownerUserId) await assertTenantReferences(user.businessId, { userIds: [input.ownerUserId] });
  const stage = input.stage ?? "new";
  const deal = await prisma.$transaction(async (tx) => {
    const d = await tx.deal.create({
      data: { businessId: user.businessId, contactId: contact.id, leadId: input.leadId ?? null, title: input.title, amount: input.amount ?? 0, currency: input.currency ?? "ILS", stage, status: stageToStatus(stage), closedAt: stage === "won" || stage === "lost" ? new Date() : null, ownerUserId: input.ownerUserId === undefined ? user.id : input.ownerUserId, expectedCloseAt: input.expectedCloseAt ? new Date(input.expectedCloseAt) : null, notes: input.notes || null },
      include: DEAL_INCLUDE,
    });
    if (input.leadId) await tx.lead.update({ where: { id: input.leadId }, data: { status: "converted", dealId: d.id, closedAt: new Date() } });
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
  if (user.role === "agent" && deal.ownerUserId && deal.ownerUserId !== user.id) throw new ApiError("העסקה משויכת לנציג אחר", 403, "forbidden");
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
      await emitEvent(tx, { businessId: user.businessId, type: "deal.won", contactId: deal.contactId, actorUserId: user.id, source: "user", dedupeKey: `deal.won:${deal.id}`, payload: { dealId: deal.id, amount: Number(u.amount) } });
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
  const where: Prisma.TaskWhereInput = {
    businessId: user.businessId,
    ...(f.status !== "all" ? { status: f.status } : {}),
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(f.conversationId ? { OR: [{ conversationId: f.conversationId }, { conversationId: null }] } : {}),
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
  await assertTenantReferences(user.businessId, { userIds: [assignee] });
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (input.conversationId && !(await prisma.conversation.findFirst({ where: { id: input.conversationId, contactId: contact.id }, select: { id: true } }))) throw new ApiError("השיחה אינה שייכת לאיש הקשר", 404, "not_found");
  if (input.leadId && !(await prisma.lead.findFirst({ where: { id: input.leadId, contactId: contact.id }, select: { id: true } }))) throw new ApiError("ליד לא נמצא", 404, "not_found");
  if (input.dealId && !(await prisma.deal.findFirst({ where: { id: input.dealId, contactId: contact.id }, select: { id: true } }))) throw new ApiError("עסקה לא נמצאה", 404, "not_found");
  if (input.requestKey) {
    const previous = await prisma.task.findUnique({ where: { businessId_requestKey: { businessId: user.businessId, requestKey: input.requestKey } }, include: TASK_INCLUDE });
    if (previous) {
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
  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId }, select: { id: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const note = await prisma.note.create({ data: { businessId: user.businessId, contactId: contact.id, conversationId: input.conversationId ?? null, dealId: input.dealId ?? null, authorId: user.id, body: input.body }, include: { author: { select: { id: true, fullName: true } } } });
  await prisma.contact.update({ where: { id: contact.id }, data: { lastActivityAt: new Date() } });
  await audit(user.businessId, user.id, "note", note.id, "note.created", { contactId: contact.id }, prisma, input.conversationId ?? null);
  return note;
}
