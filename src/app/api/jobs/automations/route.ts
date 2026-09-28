import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { processBusinesses } from "@/jobs/business-runner";
import { processDueAutomationRuns } from "@/jobs/automation-runner";
import { processDueSequenceRuns } from "@/server/services/sequence-service";
import { processAbandonedCarts } from "@/server/services/cart-service";
import { processAssistantSchedules } from "@/server/assistant/scheduler";
import { applyPendingTransfers } from "@/lib/crm/lead-ops";
import { runOpsTick } from "@/server/ops/engine";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Delayed messaging automations (NO_REPLY_TIMEOUT) – every 2 minutes. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    return Response.json(await processBusinesses("automation", async (deadline, businessId) => {
      const a = await processDueAutomationRuns(deadline);
      const c = await processAbandonedCarts(businessId);
      const b = await processDueSequenceRuns(deadline, businessId);
      // The assistant must never break the other automations of this business.
      const d = await processAssistantSchedules(businessId).catch((e: Error) => { console.error("assistant scheduler failed", { businessId, error: e.message }); return { processed: 0 }; });
      // Safety net for transfers that waited for a call that has since been documented.
      const t = await applyPendingTransfers(businessId).catch((e: Error) => { console.error("pending transfers failed", { businessId, error: e.message }); return 0; });
      // "מנהל AI": expiries, momentum detection, unattended "available now", at-risk allocations. Never blocks the rest.
      const o = await runOpsTick(businessId).catch((e: Error) => { console.error("ai ops tick failed", { businessId, error: e.message }); return { processed: 0 }; });
      return { processed: a.processed + b.processed + c.processed + d.processed + t + o.processed };
    }));
  } catch (err) {
    return handleError(err);
  }
}
