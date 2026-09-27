import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { actionView } from "@/server/ai/actions";
import { canManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
/** Pending approvals + recent action log (audit: who asked, who approved, result). Agents: their own only. */
export const GET = withAuth(async ({ req, user }) => {
  const { ai } = await getAiSettings(user.businessId);
  const mine = !canManage(user, ai);
  const status = req.nextUrl.searchParams.get("status");
  const rows = await prisma.aiAction.findMany({ where: { businessId: user.businessId, ...(mine ? { requestedById: user.id } : {}), ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
  const users = await prisma.user.findMany({ where: { businessId: user.businessId, id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.approvedById]).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  return ok({ items: rows.map((r) => ({ ...actionView(r), channel: r.channel, requestedBy: r.requestedById ? name.get(r.requestedById) ?? null : "מערכת", approvedBy: r.approvedById ? name.get(r.approvedById) ?? null : null })) });
});
