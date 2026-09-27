import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { aiConnected, canManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";

/** "עוזר AI" overview: connection state (never the key), what this user may do, pending approvals. */
export const GET = withAuth(async ({ user }) => {
  const { ai, businessName } = await getAiSettings(user.businessId);
  const manage = canManage(user, ai);
  const [pending, whatsapp, knowledge] = await Promise.all([
    prisma.aiAction.count({ where: { businessId: user.businessId, status: "proposed", ...(manage ? {} : { requestedById: user.id }) } }),
    prisma.providerCredential.findMany({ where: { businessId: user.businessId, channel: "whatsapp" }, select: { id: true, label: true, displayPhoneNumber: true, status: true, isActive: true, provider: true } }),
    manage ? prisma.knowledgeSource.groupBy({ by: ["status"], where: { businessId: user.businessId }, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  return ok({
    connected: aiConnected(), businessName, role: user.role, canManage: manage,
    canChat: user.role !== "agent" || ai.agentsCanChat,
    pendingApprovals: pending,
    service: { enabled: ai.service.enabled, channels: whatsapp.map((c) => ({ id: c.id, label: c.label ?? c.displayPhoneNumber ?? c.provider, status: c.status, active: c.isActive, simulated: c.provider === "mock", enabled: ai.service.credentialIds.includes(c.id) })) },
    knowledge: Object.fromEntries(knowledge.map((k) => [k.status, k._count._all])),
  });
});
