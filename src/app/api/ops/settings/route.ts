import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getBusinessSettings } from "@/lib/settings";
import { visibleUserIds } from "@/lib/auth";

const time = z.string().regex(/^\d{2}:\d{2}$/);
const schema = z.object({
  enabled: z.boolean().optional(), notifyWhatsApp: z.boolean().optional(),
  maxAlertsPerDay: z.number().int().min(1).max(100).optional(), cooldownMinutes: z.number().int().min(10).max(1440).optional(),
  shift: z.object({ userId: z.string(), value: z.object({ start: time, end: time, days: z.array(z.number().int().min(0).max(6)).min(1) }).nullable() }).optional(),
});

/** "מנהל AI" settings + agent shifts (without a shift an agent is never assumed free). */
export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const s = await getBusinessSettings(user.businessId);
  const shifts = { ...s.aiOps.shifts };
  if (b.shift) {
    const ids = await visibleUserIds(user);
    if (ids && !ids.includes(b.shift.userId)) throw new ApiError("הנציג אינו בצוות שלך", 403, "forbidden");
    if (b.shift.value && b.shift.value.end <= b.shift.value.start) throw new ApiError("שעת הסיום חייבת להיות אחרי שעת ההתחלה", 400, "validation");
    if (b.shift.value) shifts[b.shift.userId] = b.shift.value; else delete shifts[b.shift.userId];
  }
  const next = { ...s.aiOps, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.notifyWhatsApp !== undefined ? { notifyWhatsApp: b.notifyWhatsApp } : {}), ...(b.maxAlertsPerDay ? { maxAlertsPerDay: b.maxAlertsPerDay } : {}), ...(b.cooldownMinutes ? { cooldownMinutes: b.cooldownMinutes } : {}), shifts };
  if ((b.enabled !== undefined || b.notifyWhatsApp !== undefined || b.maxAlertsPerDay || b.cooldownMinutes) && user.role !== "owner" && user.role !== "manager") throw new ApiError("אין הרשאה", 403, "forbidden");
  // Raw JSON merge under a row lock – no other settings touched.
  await prisma.$transaction(async (tx) => {
    const biz = await tx.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
    const raw = (biz.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
    await tx.business.update({ where: { id: user.businessId }, data: { settings: { ...raw, aiOps: next } as object } });
  });
  await audit(user.businessId, user.id, "ai_ops", user.businessId, "ai_ops.settings_updated", { changes: b });
  return ok(next);
}, { minRole: "manager", module: "crm" });
