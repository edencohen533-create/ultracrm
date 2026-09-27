import crypto from "node:crypto";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { toSession } from "@/lib/auth-compat";
import { startConversation, ConversationStartError } from "@/server/services/conversation-service";
import { createOutboundMessage, MessageOutcomeUnknownError, MessagePolicyError } from "@/server/services/message-service";

export const dynamic = "force-dynamic";
const schema = z.object({
  templateId: z.string().min(1),
  variables: z.record(z.string(), z.string().trim().min(1).max(1024)).default({}),
  mediaUrl: z.string().url().max(2000).optional(),
  /** Client key so a double click sends once. */
  requestId: z.string().uuid().optional(),
});

/**
 * After a call: send an approved WhatsApp template to the call's contact (e.g. "תודה על השיחה, מצורפת ההצעה").
 * Uses the regular outbound path – consent / suppression / template approval are enforced there.
 */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const call = await prisma.call.findFirst({ where: { id: params.id, businessId: user.businessId, ...(user.role === "agent" ? { userId: user.id } : {}) }, select: { id: true, contactId: true } });
  if (!call?.contactId) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  const tpl = await prisma.template.findFirst({ where: { id: b.templateId, businessId: user.businessId, channel: "whatsapp", status: "APPROVED", internal: false }, select: { id: true, name: true } });
  if (!tpl) throw new ApiError("התבנית אינה מאושרת או לא נמצאה", 400, "template_not_approved");
  try {
    const conversation = await startConversation(toSession(user), call.contactId);
    const r = await createOutboundMessage({ conversationId: conversation.id, body: "", sentByUserId: user.id, templateId: tpl.id, templateVariables: b.variables, requestKey: `${user.id}:call-wa:${call.id}:${b.requestId ?? crypto.randomUUID()}`, ...(b.mediaUrl ? { templateMedia: { link: b.mediaUrl } } : {}) });
    if (r.message.status === "FAILED") throw new ApiError("הספק דחה את שליחת ההודעה", 502, "send_failed");
    return ok({ messageId: r.message.id, conversationId: conversation.id, template: tpl.name });
  } catch (e) {
    if (e instanceof ConversationStartError || e instanceof MessagePolicyError || e instanceof MessageOutcomeUnknownError) throw new ApiError(e.message, 409, "not_sent");
    throw e;
  }
}, { module: "messaging" });
