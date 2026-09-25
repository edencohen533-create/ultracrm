import { organizationRequest } from "@/lib/auth-compat";
import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-compat";
import { listConversations, type ConversationListFilter } from "@/server/services/conversation-service";

export const GET = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = z.object({
    status: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]).optional(),
    assignedTo: z.enum(["me", "unassigned", "all"]).optional(),
    providerCredentialId: z.string().min(1).optional(),
    search: z.string().max(300).optional(),
  }).safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "מסנני שיחה לא תקינים" }, { status: 400 });
  const filter: ConversationListFilter = parsed.data;

  const conversations = await listConversations(session, filter);
  return NextResponse.json({ conversations });
});

export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { startConversation, ConversationStartError } = await import("@/server/services/conversation-service");
  const parsed = z.object({ contactId: z.string().min(1), agentId: z.string().min(1).nullable().optional(), providerCredentialId: z.string().min(1).nullable().optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "פרטי שיחה לא תקינים" }, { status: 400 });
  try { return NextResponse.json({ conversation: await startConversation(session, parsed.data.contactId, parsed.data.agentId, parsed.data.providerCredentialId) }, { status: 201 }); }
  catch (error) {
    if (error instanceof ConversationStartError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
});
