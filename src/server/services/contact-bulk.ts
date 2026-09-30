/**
 * Bulk actions on contacts ("קהלים ואנשי קשר" and a distribution list's recipients).
 *
 *  • Selection: explicit ids (the current page / picked rows) OR "all filtered results" – the server re-runs the same
 *    filter (never trusts a client list) inside the user's data scope, and refuses when the count changed from what
 *    the user confirmed (someone added / removed contacts meanwhile).
 *  • "הסרה מרשימה" – only for a static list (members). The contact stays in the CRM; future sends of active campaigns
 *    that reached them ONLY through this list are skipped (sends already made stay recorded).
 *  • "מחיקת איש קשר" – owner only. Soft delete: personal details scrubbed, the row stays so sends / calls / messages /
 *    deals / reports keep their history; list memberships, queued sends, dial-queue rows, open tasks end; open leads
 *    close. Suppressions and do-not-contact are rows by phone / email – they stay, so a re-import is still blocked.
 *    A contact in a live call is never deleted (reported as a failure, the rest continue).
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { contactFilterSchema, contactWhere } from "@/lib/crm/contacts";
import { contactScope } from "@/lib/crm/access";

const MAX = 20_000;
export const BULK_MAX = MAX;
export const selectionSchema = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) }),
  // No max here: too many is refused below with a clear message (not a generic validation error).
  z.object({ filter: contactFilterSchema, expectedCount: z.number().int().min(1) }),
]);
export type Selection = z.infer<typeof selectionSchema>;

/** Resolve a selection to contact ids the user may act on (data scope + business), with the same list filter as the screen. */
export async function resolveSelection(user: SessionUser, sel: Selection) {
  const scope = contactScope(await visibleUserIds(user));
  if ("ids" in sel) {
    const rows = await prisma.contact.findMany({ where: { AND: [{ id: { in: sel.ids } }, scope] }, select: { id: true } });
    if (rows.length !== new Set(sel.ids).size) throw new ApiError("חלק מאנשי הקשר אינם זמינים לך או כבר נמחקו – רעננו ונסו שוב", 409, "selection_changed");
    return rows.map((r) => r.id);
  }
  let where: Prisma.ContactWhereInput = { AND: [contactWhere(user.businessId, sel.filter), scope] };
  if (sel.filter.segmentId) {
    const { listAudienceWhere } = await import("./audience-service");
    const list = await prisma.distributionList.findUnique({ where: { id: sel.filter.segmentId }, select: { id: true, segment: true } });
    if (!list) throw new ApiError("הרשימה לא נמצאה", 404, "not_found");
    where = { AND: [where, await listAudienceWhere(prisma as unknown as Prisma.TransactionClient, list, new Date())] };
  }
  const count = await prisma.contact.count({ where });
  if (count !== sel.expectedCount) throw new ApiError(`מספר התוצאות השתנה (${count} במקום ${sel.expectedCount}) – יש לאשר שוב`, 409, "selection_changed", { count });
  if (count > MAX) throw new ApiError(`אפשר לפעול על עד ${MAX.toLocaleString("he-IL")} אנשי קשר בפעולה אחת`, 400, "too_many");
  return (await prisma.contact.findMany({ where, select: { id: true } })).map((r) => r.id);
}

const canEditLists = (user: SessionUser) => import("@/lib/access/engine").then(async ({ effectiveAccess, can }) => { const a = await effectiveAccess(user.businessId, user.id); return ["crm.edit", "whatsapp.campaign_draft", "sms.draft", "email.draft"].some((p) => can(a, p as never)); });

/** Future sends of active campaigns for these contacts that came only through `viaListId` → skipped (history kept). */
async function skipFutureSends(tx: Prisma.TransactionClient, businessId: string, contactIds: string[], reason: string, viaListId?: string) {
  if (!contactIds.length) return 0;
  const campaigns = await tx.campaign.findMany({ where: { businessId, status: { in: ["RUNNING", "SCHEDULED", "PAUSED"] } }, select: { id: true, listIds: true, listId: true, excludedListIds: true } });
  let skipped = 0;
  for (const c of campaigns) {
    const lists = [...new Set([...(Array.isArray(c.listIds) ? (c.listIds as string[]) : []), ...(c.listId ? [c.listId] : [])])];
    if (viaListId && !lists.includes(viaListId)) continue;
    let ids = contactIds;
    if (viaListId) {
      // Still reached through another list of the same campaign → keep them.
      const others = lists.filter((l) => l !== viaListId);
      if (others.length) {
        const { listAudienceWhere } = await import("./audience-service");
        const defs = await tx.distributionList.findMany({ where: { id: { in: others } }, select: { id: true, segment: true } });
        const wheres = await Promise.all(defs.map((d) => listAudienceWhere(tx, d, new Date())));
        const still = new Set((await tx.contact.findMany({ where: { id: { in: ids }, OR: wheres }, select: { id: true } })).map((r) => r.id));
        ids = ids.filter((id) => !still.has(id));
      }
    }
    if (!ids.length) continue;
    const r = await tx.campaignRecipient.updateMany({ where: { campaignId: c.id, contactId: { in: ids }, status: "QUEUED" }, data: { status: "SKIPPED", error: reason, completedAt: new Date() } });
    skipped += r.count;
  }
  return skipped;
}

/** "הסרה מרשימה" (static list only). */
export async function removeFromList(user: SessionUser, listId: string, sel: Selection) {
  if (!(await canEditLists(user))) throw new ApiError("אין לך הרשאה לערוך רשימות", 403, "forbidden");
  const list = await prisma.distributionList.findUnique({ where: { id: listId }, select: { id: true, name: true, segment: true } });
  if (!list) throw new ApiError("הרשימה לא נמצאה", 404, "not_found");
  if (list.segment !== null) throw new ApiError("זו רשימה דינמית (לפי תנאים) – כדי להוציא ממנה אנשי קשר יש לשנות את התנאים או להחריג קהל", 409, "dynamic_list");
  const ids = await resolveSelection(user, sel);
  return prisma.$transaction(async (tx) => {
    const r = await tx.distributionListMember.deleteMany({ where: { listId, contactId: { in: ids } } });
    const skipped = await skipFutureSends(tx, user.businessId, ids, `הוסר מהרשימה "${list.name}"`, listId);
    await audit(user.businessId, user.id, "distribution_list", listId, "list.members_removed", { count: r.count, futureSendsSkipped: skipped }, tx);
    return { removed: r.count, futureSendsSkipped: skipped };
  });
}

/** What deleting would do – shown before confirming. */
export async function deletionImpact(user: SessionUser, sel: Selection) {
  if (user.role !== "owner") throw new ApiError("מחיקת אנשי קשר זמינה לבעל העסק בלבד", 403, "owner_only");
  const ids = await resolveSelection(user, sel);
  const [sends, calls, messages, deals, openLeads, queued, inCall, suppressed, dnc] = await Promise.all([
    prisma.campaignRecipient.count({ where: { contactId: { in: ids }, status: { in: ["SENT", "FAILED", "UNKNOWN"] } } }),
    prisma.call.count({ where: { contactId: { in: ids } } }),
    prisma.message.count({ where: { conversation: { contactId: { in: ids } } } }),
    prisma.deal.count({ where: { contactId: { in: ids } } }),
    prisma.lead.count({ where: { contactId: { in: ids }, status: { in: ["new", "contacted", "follow_up", "qualified"] } } }),
    prisma.campaignRecipient.count({ where: { contactId: { in: ids }, status: "QUEUED" } }),
    prisma.listLead.count({ where: { contactId: { in: ids }, status: "in_call" } }),
    prisma.suppression.count({ where: { contactId: { in: ids }, revokedAt: null } }),
    prisma.contact.findMany({ where: { id: { in: ids } }, select: { phoneE164: true } }).then((cs) => prisma.dncEntry.count({ where: { businessId: user.businessId, phoneE164: { in: cs.map((c) => c.phoneE164) } } })),
  ]);
  return { contacts: ids.length, history: { sends, calls, messages, deals }, openLeads, queuedSends: queued, inCall, keptBlocks: suppressed + dnc };
}

/** Owner: soft-delete the selected contacts. Returns what was deleted and what failed (with the reason). */
export async function deleteContacts(user: SessionUser, sel: Selection & { confirm: string }) {
  if (user.role !== "owner") throw new ApiError("מחיקת אנשי קשר זמינה לבעל העסק בלבד", 403, "owner_only");
  const ids = await resolveSelection(user, sel);
  if (sel.confirm !== String(ids.length)) throw new ApiError("לאישור יש להקליד את מספר אנשי הקשר שיימחקו", 400, "confirm_required");
  const failed: Array<{ id: string; reason: string }> = [];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await prisma.$transaction(async (tx) => {
      const live = new Set([
        ...(await tx.listLead.findMany({ where: { contactId: { in: chunk }, status: "in_call" }, select: { contactId: true } })).map((r) => r.contactId),
        ...(await tx.call.findMany({ where: { contactId: { in: chunk }, endedAt: null }, select: { contactId: true } })).map((r) => r.contactId!),
      ]);
      for (const id of live) failed.push({ id, reason: "בשיחה פעילה – נסו שוב אחרי שהשיחה תסתיים" });
      const ok = chunk.filter((id) => !live.has(id));
      if (!ok.length) return;
      const now = new Date();
      await tx.distributionListMember.deleteMany({ where: { contactId: { in: ok } } });
      await skipFutureSends(tx, user.businessId, ok, "איש הקשר נמחק");
      await tx.listLead.updateMany({ where: { contactId: { in: ok }, status: { notIn: ["in_call"] } }, data: { status: "removed", lockedByUserId: null, lockToken: null, lockExpiresAt: null, nextAttemptAt: null } });
      await tx.task.updateMany({ where: { contactId: { in: ok }, status: "open" }, data: { status: "cancelled" } });
      await tx.lead.updateMany({ where: { contactId: { in: ok }, status: { in: ["new", "contacted", "follow_up", "qualified"] } }, data: { status: "lost", closedAt: now, closeReason: "איש הקשר נמחק" } });
      for (const id of ok) {
        // Scrub personal details; the phone becomes a non-dialable token (unique per business) so the number can be
        // imported again as a new contact – and still be blocked by its suppression / do-not-contact rows.
        await tx.contact.update({ where: { id }, data: { deletedAt: now, fullName: "איש קשר שנמחק", email: null, company: null, city: null, notes: null, phoneE164: `deleted:${id}`, phoneRaw: "", customFields: {}, ownerUserId: null } });
      }
      await tx.contactPhone.deleteMany({ where: { contactId: { in: ok } } }).catch(() => undefined);
      await tx.contactEmail.deleteMany({ where: { contactId: { in: ok } } }).catch(() => undefined);
      await audit(user.businessId, user.id, "contact", ok[0], "contacts.deleted", { count: ok.length, ids: ok }, tx);
      deleted += ok.length;
    });
  }
  return { deleted, failed };
}
