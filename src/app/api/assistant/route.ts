import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings, DEFAULT_ASSISTANT } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";
import { assistantMode } from "@/server/assistant/brain";
import { linkView } from "@/server/assistant/access";

export const dynamic = "force-dynamic";

/** Assistant screen: connection status, settings, links, templates (with approval status). Managers and owners. */
export const GET = withAuth(async ({ user }) => {
  const s = await getBusinessSettings(user.businessId);
  const [cred, links, templates, users] = await Promise.all([
    prisma.providerCredential.findFirst({ where: { businessId: user.businessId, channel: "whatsapp", isActive: true }, orderBy: { createdAt: "desc" }, select: { provider: true, displayPhoneNumber: true, verifiedName: true } }),
    prisma.assistantLink.findMany({ where: { businessId: user.businessId, ...(user.role === "owner" ? {} : { userId: user.id }) }, orderBy: { createdAt: "desc" }, include: { user: { select: { fullName: true, role: true } } } }),
    prisma.template.findMany({ where: { businessId: user.businessId, channel: "whatsapp" }, orderBy: { name: "asc" }, select: { id: true, name: true, status: true, variables: true, language: true } }),
    user.role === "owner" ? prisma.user.findMany({ where: { businessId: user.businessId, isActive: true }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, role: true } }) : Promise.resolve([]),
  ]);
  return ok({
    connection: cred ? { provider: cred.provider, simulated: cred.provider === "mock", phone: cred.displayPhoneNumber, name: cred.verifiedName } : null,
    mode: assistantMode(), timezone: s.timezone, settings: s.assistant, canEditSettings: user.role === "owner",
    links: links.map(linkView), templates, users,
  });
}, { minRole: "manager" });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const schema = z.object({
  enabled: z.boolean().optional(), paused: z.boolean().optional(),
  daily: z.object({ enabled: z.boolean(), time: hhmm, days: z.array(z.number().int().min(0).max(6)).max(7) }).partial().optional(),
  weekly: z.object({ enabled: z.boolean(), day: z.number().int().min(0).max(6), time: hhmm }).partial().optional(),
  untreatedAlert: z.object({ enabled: z.boolean(), minutes: z.number().int().min(5).max(10080) }).partial().optional(),
  salesGoal: z.object({ enabled: z.boolean(), period: z.enum(["day", "month"]), amount: z.number().min(0).max(1e10) }).partial().optional(),
  recipients: z.array(z.string()).max(50).optional(),
  templateId: z.string().nullable().optional(),
});

/** Settings are business-wide (who receives business reports) → owner only. */
export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  if (b.recipients?.length && (await prisma.assistantLink.count({ where: { businessId: user.businessId, id: { in: b.recipients } } })) !== new Set(b.recipients).size) throw new ApiError("נמען לא קיים", 400, "invalid_recipient");
  if (b.templateId && !(await prisma.template.findFirst({ where: { id: b.templateId, businessId: user.businessId, channel: "whatsapp" }, select: { id: true } }))) throw new ApiError("תבנית לא קיימת", 400, "invalid_template");
  const biz = await prisma.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
  const raw = (biz.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
  const cur = { ...DEFAULT_ASSISTANT, ...((raw.assistant as object) ?? {}) } as typeof DEFAULT_ASSISTANT;
  const next = { ...cur, ...b, daily: { ...cur.daily, ...(b.daily ?? {}) }, weekly: { ...cur.weekly, ...(b.weekly ?? {}) }, untreatedAlert: { ...cur.untreatedAlert, ...(b.untreatedAlert ?? {}) }, salesGoal: { ...cur.salesGoal, ...(b.salesGoal ?? {}) } };
  await prisma.business.update({ where: { id: user.businessId }, data: { settings: { ...raw, assistant: next } as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "settings", user.businessId, "assistant.settings_updated", { changed: Object.keys(b) });
  return ok({ settings: (await getBusinessSettings(user.businessId)).assistant });
}, { minRole: "owner" });
