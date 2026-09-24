import { organizationRequest } from "@/lib/auth-compat";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildConversationScope } from "@/server/services/conversation-service";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth-compat";
import { AutomationTrigger } from "@/generated/prisma/client";
import { evaluateTrigger } from "@/server/services/automation-service";
import { writeAuditLog } from "@/lib/audit";

const tagSchema = z.object({ tagId: z.string() });

export const POST = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;
  const parsed = tagSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (!await prisma.conversation.findFirst({ where: { id: conversationId, ...buildConversationScope(session) }, select: { id: true } })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { tagId } = parsed.data;

  if (!await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } })) return NextResponse.json({ error: "Tag not found" }, { status: 404 });
  const added = await prisma.conversationTag.createMany({ data: [{ conversationId, tagId }], skipDuplicates: true });
  if (!added.count) return NextResponse.json({ ok: true });

  await writeAuditLog({
    actorUserId: session.user.id,
    action: "conversation.tag_added",
    entityType: "Conversation",
    entityId: conversationId,
    conversationId,
    metadata: { tagId },
  });

  await evaluateTrigger(AutomationTrigger.TAG_ADDED, { conversationId, tagId });

  return NextResponse.json({ ok: true });
});

export const DELETE = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;
  const parsed = tagSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (!await prisma.conversation.findFirst({ where: { id: conversationId, ...buildConversationScope(session) }, select: { id: true } })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.conversationTag.deleteMany({ where: { conversationId, tagId: parsed.data.tagId } });
  return NextResponse.json({ ok: true });
});
