import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";

/**
 * Called only after cron authentication. Rotates over active businesses (least
 * recently scanned first) so one busy business cannot starve the others.
 */
export async function processBusinesses(kind: "campaign" | "automation" | "event", job: (deadline: number, businessId: string) => Promise<{ processed: number }>) {
  const deadline = Date.now() + 43_000;
  const field = kind === "campaign" ? "lastCampaignScanAt" : kind === "automation" ? "lastAutomationScanAt" : "lastEventScanAt";
  const businesses = await db.business.findMany({
    where: { isActive: true }, orderBy: [{ [field]: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 25, select: { id: true },
  });
  let processed = 0, scanned = 0, failed = 0;
  for (const business of businesses) {
    if (Date.now() >= deadline) break;
    await db.business.update({ where: { id: business.id }, data: { [field]: new Date() } });
    try {
      const result = await withBusiness(business.id, () => job(deadline, business.id));
      processed += result.processed;
    } catch (err) {
      // Do not log payloads/credentials, or let a broken business starve every other business.
      failed++;
      console.error("Business worker failed", { businessId: business.id, kind, error: err instanceof Error ? err.message : String(err) });
    }
    scanned++;
  }
  return { processed, businesses: scanned, failed };
}
