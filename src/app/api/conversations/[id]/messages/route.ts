import { organizationRequest } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { auth } from "@/lib/auth-compat";
import { getConversationForUser, buildConversationScope } from "@/server/services/conversation-service";
import { createOutboundMessage, MessageOutcomeUnknownError, MessagePolicyError } from "@/server/services/message-service";

const sendMessageSchema = z.object({
  requestId: z.uuid().optional(),
  body: z.string().trim().max(4096).default(""),
  templateId: z.string().min(1).optional(),
  templateVariables: z.record(z.string(), z.string().trim().min(1).max(1024)).optional(),
}).refine((value) => value.templateId || value.body.length > 0);

export const POST = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!await getConversationForUser(session, id)) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = sendMessageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "תוכן ההודעה אינו תקין" }, { status: 400 });
  try {
    const result = await createOutboundMessage({ conversationId: id, ...parsed.data, requestKey: parsed.data.requestId ? `${session.user.id}:${id}:${parsed.data.requestId}` : undefined, sentByUserId: session.user.id });
    if (result.message.status === "FAILED") return Response.json({ error: "הספק דחה את שליחת ההודעה", messageId: result.message.id }, { status: 502 });
    return Response.json({ messageId: result.message.id, message: result.message });
  } catch (error) {
    if (error instanceof MessagePolicyError || error instanceof MessageOutcomeUnknownError) return Response.json({ error: error.message }, { status: 409 });
    console.error("Message send failed", error instanceof Error ? error.name : "Unknown");
    return Response.json({ error: "לא ניתן לאמת את השליחה. יש לבדוק את השיחה לפני ניסיון נוסף" }, { status: 502 });
  }
});

export const GET = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const cursor = z.object({ before: z.iso.datetime().nullable(), beforeId: z.string().min(1).max(200).nullable() })
    .refine((value) => !!value.before === !!value.beforeId).safeParse({ before: query.get("before"), beforeId: query.get("beforeId") });
  if (!cursor.success) return Response.json({ error: "סמן עימוד לא תקין" }, { status: 400 });
  const before = cursor.data.before ? new Date(cursor.data.before) : null;
  const conversation = await prisma.conversation.findFirst({
    where: { id, ...buildConversationScope(session) },
    select: { providerCredentialId: true, providerCredential: { select: { isActive: true, sendingBlocked: true } }, lastInboundAt: true, messages: {
      take: 101,
      where: before ? { OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: cursor.data.beforeId! } }] } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, direction: true, type: true, body: true, status: true, createdAt: true, attachments: { select: { id: true, url: true, mimeType: true, fileName: true, sizeBytes: true } }, sentByUser: { select: { id: true, fullName: true } } },
    } },
  });
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });
  const senderUnavailable = conversation.providerCredential
    ? (!conversation.providerCredential.isActive || conversation.providerCredential.sendingBlocked ? "המספר השולח מנותק או חסום. יש לבדוק את החיבור בהגדרות" : null)
    : conversation.providerCredentialId === null && await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api" }, select: { id: true } })
      ? "זו שיחת הדגמה. יש לפתוח שיחה דרך מספר WhatsApp מחובר" : null;
  return Response.json({ senderUnavailable, messages: conversation.messages.slice(0, 100).reverse(), hasMore: conversation.messages.length > 100, lastInboundAt: conversation.lastInboundAt }, { headers: { "Cache-Control": "private, no-store" } });
});
