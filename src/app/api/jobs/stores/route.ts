import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { processStoreEvents } from "@/server/services/woo/events";
import { runSyncStep, startReconcile } from "@/server/services/woo/sync";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Every minute: store event worker (retries), running imports / reconciles, and an hourly reconcile per connected store. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const deadline = Date.now() + 45_000;
    const events = await processStoreEvents({ limit: 50, deadline: Date.now() + 20_000 });
    const stores = await db.storeConnection.findMany({ where: { platform: "woocommerce", isActive: true, apiStatus: "ok" }, select: { id: true, businessId: true, syncState: true, lastSyncAt: true } });
    let steps = 0; let reconciles = 0;
    for (const s of stores) {
      if (Date.now() > deadline) break;
      const st = s.syncState as { status?: string } | null;
      await withBusiness(s.businessId, async () => {
        if (st?.status === "running") { await runSyncStep(s.id, Math.min(deadline, Date.now() + 10_000)); steps++; return; }
        // Hourly reconcile, only after an initial import (lastSyncAt set).
        if (s.lastSyncAt && Date.now() - s.lastSyncAt.getTime() > 3600_000) {
          const store = await db.storeConnection.findUniqueOrThrow({ where: { id: s.id } });
          await startReconcile(store); await runSyncStep(s.id, Math.min(deadline, Date.now() + 10_000)); reconciles++;
        }
      }).catch((e: Error) => console.error("[jobs/stores]", { storeId: s.id, error: e.message }));
    }
    return Response.json({ events, steps, reconciles });
  } catch (err) { return handleError(err); }
}
