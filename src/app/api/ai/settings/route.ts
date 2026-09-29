import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";
import { aiConnected, assertCanManage, getAiSettings, mergeAi } from "@/server/ai/settings";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const { ai } = await getAiSettings(user.businessId);
  assertCanManage(user, ai);
  const [users, channels, templates] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, isActive: true }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, role: true } }),
    prisma.providerCredential.findMany({ where: { businessId: user.businessId, channel: "whatsapp" }, select: { id: true, label: true, displayPhoneNumber: true, status: true, isActive: true, provider: true } }),
    prisma.aiAction.count({ where: { businessId: user.businessId, channel: "whatsapp_service", status: "executed", createdAt: { gt: new Date(Date.now() - 86400_000) } } }),
  ]);
  const since = new Date(Date.now() - 30 * 86400_000);
  const usage = await prisma.aiMessage.count({ where: { businessId: user.businessId, role: "assistant", createdAt: { gt: since } } });
  return ok({ settings: ai, connected: aiConnected(), users, channels: channels.map((c) => ({ id: c.id, label: c.label ?? c.displayPhoneNumber ?? c.provider, status: c.status, active: c.isActive, simulated: c.provider === "mock" })), usage: { chatAnswers30d: usage, serviceReplies24h: templates } });
});

const policy = z.enum(["auto", "approve", "off"]);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const schema = z.object({
  name: z.string().trim().min(1).max(40), language: z.enum(["he", "en"]), tone: z.enum(["friendly", "formal", "short"]), length: z.enum(["short", "normal", "detailed"]),
  agentsCanChat: z.boolean(), managerIds: z.array(z.string()).max(100), autoRepairs: z.boolean(),
  actions: z.object({ create_task: policy, set_follow_up: policy, change_lead_status: policy, transfer_lead: policy }),
  service: z.object({ enabled: z.boolean(), credentialIds: z.array(z.string()).max(20), hours: z.object({ start: hhmm, end: hhmm, days: z.array(z.number().int().min(0).max(6)).max(7) }), qualificationQuestions: z.array(z.string().trim().max(200)).max(8).transform(q=>[...new Set(q.filter(Boolean))]).optional(), handoffTopics: z.array(z.string().trim().min(1).max(60)).max(30), allowOrderStatus: z.boolean(), maxRepliesPerConversationPerHour: z.number().int().min(1).max(60), dailyReplyLimit: z.number().int().min(1).max(20000), offHoursMessage: z.string().max(500) }),
  limits: z.object({ dailyChatMessagesPerUser: z.number().int().min(10).max(5000) }),
}).partial();

export const PUT = withAuth(async ({ req, user }) => {
  const { ai } = await getAiSettings(user.businessId);
  assertCanManage(user, ai);
  const b = await parseBody(req, schema);
  // Only the owner may change who manages the assistant.
  if (b.managerIds && user.role !== "owner" && JSON.stringify(b.managerIds) !== JSON.stringify(ai.managerIds)) throw new ApiError("רק הבעלים יכול לשנות מי מנהל את העוזר", 403, "forbidden");
  const realIds = (b.service?.credentialIds ?? []).filter((id) => id !== "demo");
  if (realIds.length) {
    const own = await prisma.providerCredential.count({ where: { businessId: user.businessId, id: { in: realIds } } });
    if (own !== realIds.length) throw new ApiError("ערוץ לא תקין", 400, "validation");
  }
  const next = mergeAi({ ...ai, ...b, actions: { ...ai.actions, ...(b.actions ?? {}) }, service: { ...ai.service, ...(b.service ?? {}) }, limits: { ...ai.limits, ...(b.limits ?? {}) } });
  const biz = await prisma.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
  await prisma.business.update({ where: { id: user.businessId }, data: { settings: { ...((biz.settings ?? {}) as object), ai: next } as unknown as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "business", user.businessId, "ai.settings_updated", { fields: Object.keys(b), serviceEnabled: next.service.enabled });
  return ok({ settings: next });
});
