import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db, prisma } from "@/lib/db";
import { invalidateEntitlements, usageSummary } from "@/lib/modules";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Plan, enabled modules and current usage of the business. */
export const GET = withAuth(async ({ user }) => {
  const [summary, plans, business] = await Promise.all([
    usageSummary(user.businessId),
    db.plan.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, key: true, name: true, modules: true, quotas: true } }),
    prisma.business.findUnique({ where: { id: user.businessId }, select: { planId: true, modules: true } }),
  ]);
  return ok({ ...summary, plans, planId: business?.planId ?? null, overrides: business?.modules ?? {} });
});

/**
 * Owner: switch plan or override modules. No payment is collected – plan
 * assignment is an operator/owner action until billing exists.
 */
export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ planId: z.string().nullable().optional(), modules: z.record(z.enum(["crm", "messaging", "telephony"]), z.boolean()).optional() }));
  if (b.planId) {
    const plan = await db.plan.findUnique({ where: { id: b.planId }, select: { id: true } });
    if (!plan) throw new ApiError("חבילה לא נמצאה", 404, "not_found");
  }
  await prisma.business.update({ where: { id: user.businessId }, data: { ...(b.planId !== undefined ? { planId: b.planId } : {}), ...(b.modules ? { modules: b.modules } : {}) } });
  invalidateEntitlements(user.businessId);
  await audit(user.businessId, user.id, "business", user.businessId, "business.plan_changed", { planId: b.planId, modules: b.modules });
  return ok(await usageSummary(user.businessId));
}, { minRole: "owner" });
