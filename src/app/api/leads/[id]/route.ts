import { visibleUserIds } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { LEAD_INCLUDE, leadPatchSchema, updateLead } from "@/lib/crm/pipeline";
import { attemptStats, followUpsFor } from "@/lib/crm/lead-ops";
import { getBusinessSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({ where: { id: params.id, businessId: user.businessId, ...ownerScope(ids) }, include: { ...LEAD_INCLUDE, tasks: { where: { status: "open", ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { dueAt: "asc" }, include: { user: { select: { id: true, fullName: true } } } }, deals: { where: ownerScope(ids), select: { id: true, title: true, stage: true, amount: true, currency: true } } } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  const [attempts, followUps, settings] = await Promise.all([attemptStats(user.businessId, [lead.contactId]), followUpsFor(user.businessId, [lead]), getBusinessSettings(user.businessId)]);
  const fu = followUps.get(lead.id); const a = attempts.get(lead.id);
  const transferTo = lead.pendingTransferToUserId ? await prisma.user.findUnique({ where: { id: lead.pendingTransferToUserId }, select: { fullName: true } }) : null;
  const attemptLimit = (await (await import("@/lib/dialer/exhaustion")).effectiveUnansweredLimit(user.businessId, lead.ownerUserId, null)).limit || null;
  return ok({ ...lead, attempts: a?.count ?? 0, attemptLimit, lastAttemptAt: a?.lastAt ?? null, timezone: settings.timezone,
    followUp: fu ? { taskId: fu.taskId, dueAt: fu.dueAt, note: fu.note, overdue: fu.dueAt.getTime() < Date.now() } : null,
    needsSchedule: lead.status === "follow_up" && !fu,
    pendingTransfer: lead.pendingTransferToUserId ? { to: transferTo?.fullName ?? null, at: lead.pendingTransferAt } : null });
}, { perm: "crm.view" });

export const PATCH = withAuth(async ({ req, user, params }) => ok(await updateLead(user, params.id, await parseBody(req, leadPatchSchema))), { perm: "crm.edit" });
