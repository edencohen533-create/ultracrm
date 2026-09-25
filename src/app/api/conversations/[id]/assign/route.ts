import { organizationRequest } from "@/lib/auth-compat";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { buildConversationScope, assignConversation } from "@/server/services/conversation-service";

const assignSchema = z.object({ agentId: z.string().nullable() });

export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = assignSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { agentId } = parsed.data;

  const isPrivileged = session.user.role === "owner" || session.user.role === "manager";
  const isSelfAssignment = agentId === session.user.id || agentId === null;
  if (!isPrivileged && !isSelfAssignment) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (agentId && !await prisma.user.findFirst({ where: { id: agentId, isActive: true } })) {
    return NextResponse.json({ error: "הנציג אינו פעיל או לא קיים" }, { status: 400 });
  }
  const conversation = await assignConversation(id, agentId, session.user.id, buildConversationScope(session));
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ conversation });
});
