import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { toSession } from "@/lib/auth-compat";
import { conversationScope } from "@/lib/crm/access";
import { canAccessContact } from "@/lib/crm/lead-ops";
import { normalizePhone } from "@/lib/phone";
import { suppressionSummary } from "@/lib/suppression";
import { can, effectiveAccess } from "@/lib/access/engine";

export const dynamic = "force-dynamic";

/**
 * "WhatsApp" next to "חייג" in contacts: the contact's own WhatsApp thread inside the system – the latest one this
 * user may open, or a new (empty) one. Opening sends nothing; sending is still checked per message (24h window,
 * consent, do-not-contact). Refused, with the reason, when there is no valid number or the contact is fully blocked.
 */
export const POST = withAuth(async ({ user, params }) => {
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, ownerUserId: true, phoneE164: true, isBlocked: true } });
  if (!c || !(await canAccessContact(user, c))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (!c.phoneE164 || !normalizePhone(c.phoneE164)) throw new ApiError("אין לאיש הקשר מספר טלפון תקין לוואטסאפ", 400, "invalid_phone");
  const block = await suppressionSummary(user.businessId, c.id);
  if (c.isBlocked || block.fullyBlocked) throw new ApiError("איש הקשר חסום לכל פנייה – לא ניתן לפתוח שיחת וואטסאפ", 403, "blocked");
  const existing = await prisma.conversation.findFirst({ where: { contactId: c.id, channel: "whatsapp", ...conversationScope(user) }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
  if (existing) return ok({ conversationId: existing.id, created: false });
  const access = await effectiveAccess(user.businessId, user.id);
  if (!can(access, "whatsapp.reply")) throw new ApiError("אין שיחת וואטסאפ קיימת ואין לך הרשאה לפתוח שיחה חדשה", 403, "forbidden");
  const { startConversation, ConversationStartError } = await import("@/server/services/conversation-service");
  try {
    const conv = await startConversation(toSession(user), c.id);
    return ok({ conversationId: conv.id, created: true });
  } catch (e) {
    if (e instanceof ConversationStartError) throw new ApiError(e.message, 409, "conversation_unavailable");
    throw e;
  }
}, { perm: "whatsapp.view" });
