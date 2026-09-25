import { requireBusinessId } from "@/lib/tenant";
import { organizationRequest } from "@/lib/auth-compat";
import { z } from "zod";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { buildConversationScope } from "@/server/services/conversation-service";

export const POST = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = z.object({ body: z.string().trim().min(1).max(4096) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "יש להזין הערה באורך עד 4,096 תווים" }, { status: 400 });
  try {
    const note = await prisma.$transaction(async (tx) => {
      // Lock the conversation before checking ownership; transfer cannot race the write.
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({ where: { id, ...buildConversationScope(session) }, select: { contactId: true } });
      if (!conversation) return null;
      const note = await tx.note.create({ data: { businessId: requireBusinessId(), body: parsed.data.body, conversationId: id, contactId: conversation.contactId, authorId: session.user.id }, include: { author: { select: { id: true, fullName: true } } } });
      await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session.user.id, action: "note.created", entityType: "Note", entityId: note.id, conversationId: id, payload: {} } });
      return note;
    });
    return note ? Response.json({ note }, { status: 201 }) : Response.json({ error: "Not found" }, { status: 404 });
  } catch { return Response.json({ error: "לא ניתן לשמור את ההערה כרגע" }, { status: 500 }); }
});
