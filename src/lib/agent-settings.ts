import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { assertCanSeeUser, visibleUserIds, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { getBusinessSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { agentSettingsSchema, DEFAULT_AGENT_SETTINGS, type AgentSettings } from "./agent-settings-schema";

export async function getAgentSettings(businessId: string, userId: string, tx: Prisma.TransactionClient = prisma): Promise<AgentSettings | null> {
  const u = await tx.user.findFirst({ where: { id: userId, businessId }, select: { crmSettings: true } });
  return u?.crmSettings ? agentSettingsSchema.parse(u.crmSettings) : null;
}
export async function settingsOverview(user: SessionUser, targetId = user.id) {
  await assertCanSeeUser(user, targetId);
  const target = await prisma.user.findFirst({ where: { id: targetId, businessId: user.businessId, isActive: true }, select: { id: true, fullName: true, crmSettings: true } });
  if (!target) throw new ApiError("נציג לא נמצא", 404, "not_found");
  const ids = await visibleUserIds(user);
  const [agents, numbers, business] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
    prisma.phoneNumber.findMany({ where: { businessId: user.businessId, isActive: true, outboundPaused: false, OR: [{ assignedUserId: null }, { assignedUserId: targetId }] }, select: { id: true, e164: true, label: true }, orderBy: { createdAt: "asc" } }),
    getBusinessSettings(user.businessId),
  ]);
  return { limits: { maxAttempts: business.maxAttempts, retryIntervalMinutes: business.retryIntervalMinutes }, target: { id: target.id, fullName: target.fullName }, agents, numbers, settings: target.crmSettings ? agentSettingsSchema.parse(target.crmSettings) : DEFAULT_AGENT_SETTINGS, configured: Boolean(target.crmSettings) };
}
export async function saveAgentSettings(user: SessionUser, targetId: string, raw: unknown) {
  const settings = agentSettingsSchema.parse(raw);
  await assertCanSeeUser(user, targetId);
  return prisma.$transaction(async tx => {
    const target = await tx.user.findFirst({ where: { id: targetId, businessId: user.businessId, isActive: true } });
    if (!target) throw new ApiError("נציג לא נמצא", 404, "not_found");
    const numbers = await tx.phoneNumber.findMany({ where: { id: { in: settings.numbers.map(n => n.id) }, businessId: user.businessId, isActive: true, outboundPaused: false, OR: [{ assignedUserId: null }, { assignedUserId: targetId }] }, select: { id: true } });
    if (numbers.length !== settings.numbers.length) throw new ApiError("אחד המספרים אינו זמין לנציג. הסר או החלף אותו", 400, "invalid_number");
    await tx.user.update({ where: { id: targetId }, data: { crmSettings: settings as Prisma.InputJsonValue } });
    await audit(user.businessId, user.id, "user", targetId, "crm.settings_updated", { before: target.crmSettings, after: settings }, tx);
    return settings;
  });
}
/** Team scope for voluntary follow-up handoffs, without granting general CRM access. */
export async function followUpPeers(user: SessionUser) {
  const ids = user.role === "agent" ? null : await visibleUserIds(user);
  return prisma.user.findMany({ where: { businessId: user.businessId, isActive: true,
    ...(user.role === "agent" ? { OR: [{ id: user.id }, ...(user.teamId ? [{ teamId: user.teamId }] : [])] } : ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } });
}
