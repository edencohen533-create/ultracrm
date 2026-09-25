import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { buildConversationScope } from "@/server/services/conversation-service";
import { createOutboundMessage, MessagePolicyError } from "@/server/services/message-service";
import { MAX_UPLOAD_BYTES, mediaType } from "@/lib/media";

export const maxDuration = 60;
export const POST = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!await prisma.conversation.findFirst({ where: { id, ...buildConversationScope(session) }, select: { id: true } })) return Response.json({ error: "Not found" }, { status: 404 });
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES + 65536) return Response.json({ error: "מותר להעלות קובץ עד 4MB" }, { status: 413 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const body = form?.get("caption") ?? "";
  if (!(file instanceof File) || !file.size || file.size > MAX_UPLOAD_BYTES || !mediaType(file.type) || typeof body !== "string" || body.length > 1024) {
    return Response.json({ error: "יש לבחור תמונה, סרטון MP4, קובץ שמע, PDF או TXT עד 4MB" }, { status: 400 });
  }
  if (mediaType(file.type) === "AUDIO" && body.trim()) return Response.json({ error: "לקובץ שמע אין כיתוב בוואטסאפ. יש למחוק את הטקסט או לשלוח אותו בנפרד" }, { status: 400 });
  const requestId = form?.get("requestId");
  if (requestId && (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId))) return Response.json({ error: "מזהה בקשה שגוי" }, { status: 400 });
  try {
    const result = await createOutboundMessage({ conversationId: id, body, type: mediaType(file.type), sentByUserId: session.user.id, requestKey: requestId ? `${session.user.id}:${id}:${requestId}` : undefined,
      media: { file: Buffer.from(await file.arrayBuffer()), mimeType: file.type, fileName: file.name.slice(0, 200) },
    });
    if (result.message.status === "FAILED") return Response.json({ error: "הספק דחה את שליחת הקובץ" }, { status: 502 });
    return Response.json({ message: result.message });
  } catch (error) {
    return Response.json({ error: error instanceof MessagePolicyError ? error.message : "לא ניתן לאמת את השליחה. יש לבדוק את השיחה לפני ניסיון נוסף" }, { status: error instanceof MessagePolicyError ? 409 : 502 });
  }
});
