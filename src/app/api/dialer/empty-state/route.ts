import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { campaignsFor, closeQueueAlerts, dueFollowUpsElsewhere, queueAvailability } from "@/lib/dialer/exhaustion";

export const dynamic = "force-dynamic";

/**
 * The dialer's "no leads available" screen for the agent's current session: why (exhausted / waiting with the next
 * time / blocked with the reason), other campaigns the agent may work (server-side permissions, available first)
 * and follow-ups that came due in other campaigns. Read-only – it never starts dialing or switches anything.
 */
export const GET = withAuth(async ({ user }) => {
  const s = await prisma.dialerSession.findFirst({ where: { userId: user.id, status: { in: ["active", "paused"] } }, select: { listId: true } });
  if (!s?.listId) throw new ApiError("אין סשן חיוג פעיל עם קמפיין", 409, "no_session");
  const availability = await queueAvailability(user, s.listId);
  if (availability.state === "available") await closeQueueAlerts(user.businessId, user.id, s.listId);
  const [campaigns, dueElsewhere] = await Promise.all([campaignsFor(user, s.listId), dueFollowUpsElsewhere(user, s.listId)]);
  return ok({ availability, campaigns, dueElsewhere });
}, { module: "telephony" });
