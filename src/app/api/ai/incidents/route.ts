import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { INCIDENT_STATUS } from "@/server/ai/diagnostics";
import { canManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
/** Diagnosis history. Managers: all (incl. escalations); agents: their own. */
export const GET = withAuth(async ({ user }) => {
  const { ai } = await getAiSettings(user.businessId);
  const rows = await prisma.aiIncident.findMany({ where: { businessId: user.businessId, ...(canManage(user, ai) ? {} : { requestedById: user.id }) }, orderBy: { createdAt: "desc" }, take: 100, include: { actions: { select: { id: true, kind: true, summary: true, status: true, requiresApproval: true, error: true } } } });
  const users = await prisma.user.findMany({ where: { businessId: user.businessId, id: { in: rows.map((r) => r.requestedById).filter(Boolean) as string[] } }, select: { id: true, fullName: true } });
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  return ok({ items: rows.map((r) => ({ id: r.id, module: r.module, question: r.question, status: r.status, statusLabel: INCIDENT_STATUS[r.status as keyof typeof INCIDENT_STATUS] ?? r.status, findings: r.findings, verification: r.verification, createdAt: r.createdAt, requestedBy: r.requestedById ? name.get(r.requestedById) ?? null : null, actions: r.actions })) });
});
