import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { db } from "@/lib/db";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { runBillingCycle } from "@/server/billing/subscriptions";
import { meterBusiness } from "@/server/billing/usage";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
/** Every 15 minutes: renewals / retries / grace / cancellations, then the usage metering sweep of active businesses. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const deadline = Date.now() + 45_000;
    const cycle = await withoutBusiness(() => runBillingCycle());
    const businesses = await db.business.findMany({ where: { isActive: true, accessStatus: { notIn: ["cancelled"] } }, select: { id: true } });
    let metered = 0;
    for (const b of businesses) { if (Date.now() > deadline) break; metered += await withBusiness(b.id, () => meterBusiness(b.id)).catch((e: Error) => { console.error("[jobs/billing] meter", b.id, e.message); return 0; }); }
    return Response.json({ cycle, metered });
  } catch (err) { return handleError(err); }
}
