/**
 * Dial-list administration: active / inactive, moving leads between lists, deleting a list.
 *
 *  • Inactive list: supplies no leads – `claimNextLead` refuses it and automatic distribution (AI allocations,
 *    new-lead routing) no longer queues into it. Reserved (not in-call) rows are released; calls in progress are
 *    never touched and finish normally. Reactivating restores the queue as it was (rows keep their state).
 *  • Move: selected rows or all rows go from list A to list B of the same business. A row keeps its id, status,
 *    attempts, handling agent (preferredUserId), schedule and DNC state, so call / task history stays linked.
 *    A contact already in B is merged (never duplicated): B's row keeps the stronger state, history is re-pointed,
 *    A's row is removed. Rows in a live call are skipped (reported) – they are never moved mid-call.
 *  • Delete: refused while a call on the list is in progress; open dialer sessions on it are ended, queue alerts
 *    and AI allocations that point to it are cleared; queue rows are removed. Contacts, leads, calls, tasks and
 *    notes stay (their list reference becomes empty). System lists (personal follow-ups, existing customers) are
 *    kept – they are recreated automatically and other flows rely on them.
 */
import { prisma, type Db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import type { Prisma } from "@/generated/prisma/client";

/** May leads be queued / claimed from this list right now? */
export async function isListOpen(db: Db, listId: string) {
  const l = await db.dialList.findUnique({ where: { id: listId }, select: { isActive: true, archivedAt: true } });
  return Boolean(l?.isActive && !l.archivedAt);
}

function systemKind(filterJson: unknown) {
  const f = (filterJson ?? {}) as Record<string, unknown>;
  return f.system === "customers" ? "customers" : typeof f.leadOwnerUserId === "string" ? "personal" : null;
}

async function listOf(user: SessionUser, id: string) {
  const l = await prisma.dialList.findFirst({ where: { id, businessId: user.businessId } });
  if (!l) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  return l;
}

export async function setListActive(user: SessionUser, id: string, active: boolean) {
  const list = await listOf(user, id);
  if (list.archivedAt && active) throw new ApiError("הרשימה בארכיון – יש לשחזר אותה קודם", 409, "archived");
  const released = await prisma.$transaction(async (tx) => {
    await tx.dialList.update({ where: { id: list.id }, data: { isActive: active } });
    if (active) return 0;
    // Future work that depends on the list stops: reserved rows are released (in_call rows are left to finish).
    const r = await tx.listLead.updateMany({ where: { listId: list.id, status: "locked" }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
    await tx.dialerQueueAlert.updateMany({ where: { businessId: user.businessId, listId: list.id, closedAt: null }, data: { closedAt: new Date() } }).catch(() => undefined);
    return r.count;
  });
  await audit(user.businessId, user.id, "dial_list", list.id, active ? "list.activated" : "list.deactivated", { name: list.name, releasedReservations: released });
  const inCall = active ? 0 : await prisma.listLead.count({ where: { listId: list.id, status: "in_call" } });
  return { isActive: active, releasedReservations: released, callsInProgress: inCall };
}

const STRONGER: Record<string, number> = { dnc: 100, exhausted: 60, completed: 50, callback: 40, pending: 30, skipped: 20, removed: 10 };

export async function moveListLeads(user: SessionUser, fromId: string, input: { toListId: string; leadIds?: string[]; all?: boolean }) {
  if (fromId === input.toListId) throw new ApiError("יש לבחור רשימת יעד אחרת", 400, "same_list");
  if (!input.all && !input.leadIds?.length) throw new ApiError("לא נבחרו לידים", 400, "nothing_selected");
  const [from, to] = await Promise.all([listOf(user, fromId), listOf(user, input.toListId)]);
  if (to.archivedAt) throw new ApiError("רשימת היעד בארכיון", 409, "archived");
  const where: Prisma.ListLeadWhereInput = { listId: from.id, ...(input.all ? {} : { id: { in: input.leadIds } }) };
  const rows = await prisma.listLead.findMany({ where, select: { id: true, contactId: true, status: true } });
  const result = { moved: 0, merged: 0, skippedInCall: 0 };
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await prisma.$transaction(async (tx) => {
      for (const r of chunk) {
        // Re-read under the transaction: a row that started a call meanwhile stays where it is.
        const row = await tx.listLead.findFirst({ where: { id: r.id, listId: from.id } });
        if (!row) continue;
        if (row.status === "in_call") { result.skippedInCall++; continue; }
        const existing = await tx.listLead.findUnique({ where: { listId_contactId: { listId: to.id, contactId: row.contactId } } });
        if (!existing) {
          await tx.listLead.update({ where: { id: row.id }, data: { listId: to.id, ...(row.status === "locked" ? { status: "pending" } : {}), lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
          result.moved++;
          continue;
        }
        // Merge into the row already in the target list: keep the stronger state, never lose DNC / attempts / owner.
        const rowStatus = row.status === "locked" ? "pending" : row.status;
        const keepSource = existing.status !== "in_call" && existing.status !== "locked" && (STRONGER[rowStatus] ?? 0) > (STRONGER[existing.status] ?? 0);
        await tx.listLead.update({ where: { id: existing.id }, data: {
          ...(keepSource ? { status: rowStatus, nextAttemptAt: row.nextAttemptAt, lastOutcome: row.lastOutcome } : {}),
          attempts: Math.max(existing.attempts, row.attempts),
          lastAttemptAt: [existing.lastAttemptAt, row.lastAttemptAt].filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null,
          preferredUserId: existing.preferredUserId ?? row.preferredUserId,
          priority: Math.max(existing.priority, row.priority),
        } });
        await tx.call.updateMany({ where: { leadId: row.id }, data: { leadId: existing.id } });
        await tx.task.updateMany({ where: { listLeadId: row.id }, data: { listLeadId: existing.id } });
        await tx.listLead.delete({ where: { id: row.id } });
        result.merged++;
      }
    });
  }
  await audit(user.businessId, user.id, "dial_list", from.id, "list.leads_moved", { toListId: to.id, toList: to.name, ...result, selection: input.all ? "all" : "selected" });
  return result;
}

export async function listDeletionInfo(user: SessionUser, id: string) {
  const list = await listOf(user, id);
  const [leads, inCall, sessions] = await Promise.all([
    prisma.listLead.count({ where: { listId: list.id, status: { not: "removed" } } }),
    prisma.listLead.count({ where: { listId: list.id, status: "in_call" } }),
    prisma.dialerSession.count({ where: { listId: list.id, endedAt: null } }),
  ]);
  return { name: list.name, leads, callsInProgress: inCall, openSessions: sessions, system: systemKind(list.filterJson) };
}

export async function deleteList(user: SessionUser, id: string, confirmName: string) {
  const list = await listOf(user, id);
  if (systemKind(list.filterJson)) throw new ApiError("זו רשימת מערכת (פולואפים אישיים / לקוחות קיימים) ולא ניתן למחוק אותה. אפשר להשבית אותה", 409, "system_list");
  if (confirmName.trim() !== list.name.trim()) throw new ApiError("לאישור המחיקה יש להקליד את שם הרשימה", 400, "confirm_required");
  const info = await listDeletionInfo(user, id);
  const liveCall = await prisma.call.count({ where: { listId: list.id, endedAt: null } });
  if (info.callsInProgress || liveCall) throw new ApiError("יש שיחה פעילה ברשימה – ניתן למחוק אחרי שהיא תסתיים", 409, "list_busy");
  await prisma.$transaction(async (tx) => {
    // Stop anything that would keep using the list, then remove it. History rows keep existing (list reference → null).
    await tx.dialList.update({ where: { id: list.id }, data: { isActive: false } });
    await tx.dialerSession.updateMany({ where: { listId: list.id, endedAt: null }, data: { endedAt: new Date(), status: "ended" } });
    await tx.dialerQueueAlert.deleteMany({ where: { businessId: user.businessId, listId: list.id } });
    await tx.assignmentOverride.updateMany({ where: { businessId: user.businessId, listId: list.id }, data: { listId: null } });
    await tx.listLead.deleteMany({ where: { listId: list.id } });
    await tx.dialList.delete({ where: { id: list.id } });
  });
  await audit(user.businessId, user.id, "dial_list", list.id, "list.deleted", { name: list.name, leads: info.leads, endedSessions: info.openSessions });
  return { deleted: true, leads: info.leads, endedSessions: info.openSessions };
}
