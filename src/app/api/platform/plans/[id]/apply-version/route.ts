import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { applyEntitlementChange, computeImpact, requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const schema = z.object({ versionId: z.string().min(1), businessIds: z.array(z.string()).max(500).optional(), apply: z.boolean().default(false) });

/** Move businesses from an older version of this package to `versionId`: preview first (per business), then apply. */
export const POST = withAuth(async ({ req, user, params }) => {
  await requirePlatformAdmin(user);
  const b = await parseBody(req, schema);
  const v = await withoutBusiness(() => db.planVersion.findFirst({ where: { id: b.versionId, planId: params.id } }));
  if (!v) throw new ApiError("הגרסה לא שייכת לחבילה", 400, "validation");
  const candidates = await withoutBusiness(() => db.business.findMany({ where: { planVersion: { planId: params.id }, NOT: { planVersionId: v.id }, ...(b.businessIds ? { id: { in: b.businessIds } } : {}) }, select: { id: true, name: true } }));
  const rows = [];
  for (const c of candidates) {
    try {
    const { impact } = await computeImpact(c.id, { planVersionId: v.id });
    const blocked = Object.keys(impact.seatOverflow).length > 0;
    if (b.apply && !blocked) await applyEntitlementChange(user, c.id, { planVersionId: v.id });
    rows.push({ businessId: c.id, name: c.name, impact, applied: b.apply && !blocked, needsSeatChoice: blocked, blockedReason: null });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "subscription_managed") throw error;
      rows.push({ businessId: c.id, name: c.name, impact: null, applied: false, needsSeatChoice: false, blockedReason: error.message });
    }
  }
  return ok({ version: v.version, businesses: rows });
});
