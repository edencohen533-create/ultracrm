import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { usageSummary } from "@/lib/modules";
import { businessEntitlement, seatSummary } from "@/lib/access/engine";

export const dynamic = "force-dynamic";

/**
 * The business's package, where each module comes from (package / add-on / trial / temporary), seats and usage.
 * Read-only: the package is changed only by the platform admin (a business cannot upgrade itself). Payment status is
 * shown as known ("manual" = no billing integration – never presented as verified).
 */
export const GET = withAuth(async ({ user }) => {
  const [summary, ent, seats] = await Promise.all([usageSummary(user.businessId), businessEntitlement(user.businessId), seatSummary(user.businessId)]);
  return ok({ ...summary, entitlement: ent, seats });
}, { minRole: "manager" });
