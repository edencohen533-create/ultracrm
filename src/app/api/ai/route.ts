import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { aiConnected, canManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/** "מרכז ה־AI" overview: connection state (never the key), what this user may do, pending approvals. */
export const GET = withAuth(async ({ user }) => {
  const { ai, businessName } = await getAiSettings(user.businessId);
  const manage = canManage(user, ai);
  const [pending, whatsapp, knowledge] = await Promise.all([
    prisma.aiAction.count({ where: { businessId: user.businessId, status: "proposed", ...(manage ? {} : { requestedById: user.id }) } }),
    prisma.providerCredential.findMany({ where: { businessId: user.businessId, channel: "whatsapp" }, select: { id: true, label: true, displayPhoneNumber: true, status: true, isActive: true, provider: true } }),
    manage ? prisma.knowledgeSource.groupBy({ by: ["status"], where: { businessId: user.businessId }, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  // The sales coach works on calls → the business needs telephony, and the coach screens are for managers.
  const { businessCanUse } = await import("@/lib/access/engine");
  const salesCoach = user.role !== "agent" && await businessCanUse(user.businessId, "telephony" as never).catch(() => false);
  return ok({
    connected: aiConnected(), businessName, role: user.role, canManage: manage, salesCoach,
    canChat: user.role !== "agent" || ai.agentsCanChat,
    pendingApprovals: pending,
    service: { enabled: ai.service.enabled, channels: whatsapp.map((c) => ({ id: c.id, label: c.label ?? c.displayPhoneNumber ?? c.provider, status: c.status, active: c.isActive, simulated: c.provider === "mock", enabled: ai.service.credentialIds.includes(c.id) })) },
    knowledge: Object.fromEntries(knowledge.map((k) => [k.status, k._count._all])),
  });
});
