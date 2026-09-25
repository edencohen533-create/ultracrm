import { organizationRequest } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { getMockProvider } from "@/server/providers/provider-registry";
import { simulateInboundSchema } from "@/lib/validation/demo";

export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();

  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (await prisma.providerCredential.findFirst({ where: { isActive: true, provider: { not: "mock" } }, select: { id: true } })) {
    return NextResponse.json({ error: "סימולציה זמינה במצב דמו בלבד" }, { status: 409 });
  }
  const body = await request.json().catch(() => null);
  const parsed = simulateInboundSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const provider = getMockProvider();
  const { conversation, message } = await provider.simulateInbound(parsed.data);

  return NextResponse.json({ conversationId: conversation.id, messageId: message.id });
});
