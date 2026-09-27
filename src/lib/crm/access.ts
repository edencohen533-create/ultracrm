import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { toSession } from "@/lib/auth-compat";
import { ApiError } from "@/lib/response";
import type { Prisma } from "@/generated/prisma/client";
import { buildConversationScope } from "@/server/services/conversation-service";

/** May these ids see unassigned (owner = null) records? Agents only when settings → הרשאות allow it. */
export function sharesPool(ids: (string[] & { sharedPool?: boolean }) | null) {
  return !ids || ids.sharedPool !== false;
}

/** Shared by list, detail, timeline and mutation paths; null owners are in the shared pool (when allowed). */
export function ownerScope(ids: (string[] & { sharedPool?: boolean }) | null) {
  if (!ids) return {};
  return sharesPool(ids) ? { OR: [{ ownerUserId: { in: ids } }, { ownerUserId: null }] } : { ownerUserId: { in: ids } };
}

/** Contacts a non-owner may list: owned by them, holding one of their leads, or (if allowed) in the unassigned pool. */
export function contactScope(ids: (string[] & { sharedPool?: boolean }) | null): Prisma.ContactWhereInput {
  if (!ids) return {};
  return { OR: [{ ownerUserId: { in: ids } }, { leads: { some: { ownerUserId: { in: ids } } } }, ...(sharesPool(ids) ? [{ ownerUserId: null }] : [])] };
}

export async function assertOwnerAccess(user: SessionUser, ownerUserId: string | null) {
  const ids = await visibleUserIds(user);
  if (ownerUserId && ids && !ids.includes(ownerUserId)) throw new ApiError("אין הרשאה לנתוני נציג זה", 403, "forbidden");
}

export function conversationScope(user: SessionUser): Prisma.ConversationWhereInput {
  return { businessId: user.businessId, ...buildConversationScope(toSession(user)) };
}

export function noteScope(user: SessionUser, ids: string[] | null): Prisma.NoteWhereInput {
  return { AND: [
    { OR: [{ conversationId: null }, { conversation: conversationScope(user) }] },
    { OR: [{ dealId: null }, { deal: { businessId: user.businessId, ...ownerScope(ids) } }] },
  ] };
}
