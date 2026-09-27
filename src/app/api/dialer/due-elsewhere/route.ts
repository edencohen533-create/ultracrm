import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { dueFollowUpsElsewhere } from "@/lib/dialer/exhaustion";

export const dynamic = "force-dynamic";
/** Follow-ups of this agent whose time came in a campaign OTHER than the current session's (notice + link back only). */
export const GET = withAuth(async ({ user }) => {
  const s = await prisma.dialerSession.findFirst({ where: { userId: user.id, status: { in: ["active", "paused"] } }, select: { listId: true } });
  return ok({ items: s?.listId ? await dueFollowUpsElsewhere(user, s.listId) : [] });
}, { module: "telephony" });
