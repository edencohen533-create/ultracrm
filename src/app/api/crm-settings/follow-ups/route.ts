import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getAgentSettings, followUpPeers } from "@/lib/agent-settings";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
async function scope(user: SessionUser) {
  if (!(await getAgentSettings(user.businessId, user.id))?.takeFollowUps) throw new ApiError("יש לשמור תחילה את האפשרות לקחת פולו־אפים בהגדרות שלך", 403, "forbidden");
  const peers = await followUpPeers(user);
  const where = { businessId: user.businessId, status: "callback" as const, preferredUserId: { in: peers.filter(p => p.id !== user.id).map(p => p.id) },
    list: { isActive: true, isPaused: false, archivedAt: null, OR: [{ agents: { none: {} } }, { agents: { some: { userId: user.id } } }] } };
  return { where, peers };
}
export const GET = withAuth(async ({ user, req }) => {
  if (req.nextUrl.searchParams.get("peers") === "1") return ok({ peers: await followUpPeers(user), allowed: Boolean((await getAgentSettings(user.businessId, user.id))?.assignFollowUps) });
  const { where, peers } = await scope(user);
  const rows = await prisma.listLead.findMany({ where, include: { contact: { select: { fullName: true } } }, orderBy: { nextAttemptAt: "asc" }, take: 100 });
  return ok(rows.map(r => ({ id: r.id, name: r.contact.fullName, owner: peers.find(p => p.id === r.preferredUserId)?.fullName ?? "", due: r.nextAttemptAt })));
}, { module: "telephony" });
export const POST = withAuth(async ({ req, user }) => {
  const { id } = await parseBody(req, z.object({ id: z.string().min(1) }));
  const { where } = await scope(user);
  await prisma.$transaction(async tx => {
    const updated = await tx.listLead.updateMany({ where: { ...where, id }, data: { preferredUserId: user.id } });
    if (!updated.count) throw new ApiError("הפולו־אפ אינו זמין ללקיחה", 409, "follow_up_unavailable");
    await tx.task.updateMany({ where: { businessId: user.businessId, listLeadId: id, status: "open", type: "callback" }, data: { userId: user.id } });
    await audit(user.businessId, user.id, "lead", id, "follow_up.taken", {}, tx);
  });
  return ok({ id });
}, { module: "telephony" });
