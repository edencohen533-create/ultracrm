import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
/** The user's own chat history (never other users' chats – also not for managers). */
export const GET = withAuth(async ({ user }) => ok({ items: await prisma.aiConversation.findMany({ where: { businessId: user.businessId, userId: user.id }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, title: true, updatedAt: true } }) }));
