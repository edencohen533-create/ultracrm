import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { createTicket } from "@/server/ops/support";

export const dynamic = "force-dynamic";
/** Report a problem from inside the app (any signed-in user) – returns the incident code. */
export const POST = withAuth(async ({ req, user }) => ok(await createTicket(user, await req.json()), 201));
/** My business's tickets (own tickets for agents). */
export const GET = withAuth(async ({ user }) => ok({ items: await prisma.supportTicket.findMany({ where: { businessId: user.businessId, ...(user.role === "agent" ? { userId: user.id } : {}) }, orderBy: { createdAt: "desc" }, take: 50, select: { code: true, message: true, status: true, createdAt: true } }) }));
