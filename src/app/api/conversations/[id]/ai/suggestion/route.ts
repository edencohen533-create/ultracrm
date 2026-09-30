import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth-compat";
import { audit } from "@/lib/audit";
import { getConversationForUser } from "@/server/services/conversation-service";

export const dynamic = "force-dynamic";

/** The service AI's reply waiting for approval ("הצעות" mode) – only for users who may see the conversation. */
async function pending(businessId: string, conversationId: string) {
  return prisma.aiAction.findFirst({ where: { businessId, kind: "service_reply", status: "proposed", params: { path: ["conversationId"], equals: conversationId } }, orderBy: { createdAt: "desc" } });
}

export const GET = withAuth(async ({ user, params }) => {
  const session = await auth();
  if (!session?.user || !(await getConversationForUser(session, params.id))) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  const a = await pending(user.businessId, params.id);
  const r = (a?.result ?? {}) as { text?: string; handoff?: { reason?: string } };
  return ok(a ? { id: a.id, text: r.text ?? "", handoffReason: r.handoff?.reason ?? null, createdAt: a.createdAt } : null);
}, { perm: "whatsapp.view" });

const schema = z.object({ actionId: z.string().min(1), decision: z.enum(["send", "dismiss"]), text: z.string().trim().min(1).max(3500).optional() });
/** Approve (optionally edited) → sent by the approving agent, once; dismiss → nothing is sent. */
export const POST = withAuth(async ({ req, user, params }) => {
  const session = await auth();
  if (!session?.user || !(await getConversationForUser(session, params.id))) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  const b = await parseBody(req, schema);
  const a = await prisma.aiAction.findFirst({ where: { id: b.actionId, businessId: user.businessId, kind: "service_reply", params: { path: ["conversationId"], equals: params.id } } });
  if (!a) throw new ApiError("ההצעה לא נמצאה", 404, "not_found");
  if (a.status !== "proposed") throw new ApiError("ההצעה כבר טופלה", 409, "already_handled");
  const claimed = await prisma.aiAction.updateMany({ where: { id: a.id, status: "proposed" }, data: { status: b.decision === "send" ? "executing" : "dismissed", approvedById: user.id, approvedAt: new Date() } });
  if (!claimed.count) throw new ApiError("ההצעה כבר טופלה", 409, "already_handled");
  if (b.decision === "dismiss") { await audit(user.businessId, user.id, "conversation", params.id, "ai.suggestion_dismissed", { actionId: a.id }); return ok({ status: "dismissed" }); }
  const original = ((a.result ?? {}) as { text?: string }).text ?? "";
  const text = b.text ?? original;
  const { createOutboundMessage } = await import("@/server/services/message-service");
  const { message } = await createOutboundMessage({ conversationId: params.id, body: text, sentByUserId: user.id, requestKey: `ai:svc-approved:${a.id}` });
  await prisma.aiAction.update({ where: { id: a.id }, data: { status: "executed", executedAt: new Date(), result: { ...((a.result ?? {}) as object), sentText: text, edited: text !== original, messageId: message.id } as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "conversation", params.id, "ai.suggestion_sent", { actionId: a.id, edited: text !== original });
  return ok({ status: "sent", messageId: message.id });
}, { perm: "whatsapp.reply" });
