import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { toSession } from "@/lib/auth-compat";
import { ApiError } from "@/lib/response";
import type { Prisma } from "@/generated/prisma/client";
import { buildConversationScope } from "@/server/services/conversation-service";

/** Shared by list, detail, timeline and mutation paths; null owners are in the shared pool. */
export function ownerScope(ids: string[] | null) {
  return ids ? { OR: [{ ownerUserId: { in: ids } }, { ownerUserId: null }] } : {};
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
