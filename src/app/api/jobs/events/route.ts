import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { processDomainEvents } from "@/lib/events";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { deliverDueWebhooks } from "@/server/services/integrations";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Cross-module event worker (safety net for the inline kick) – every minute. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const events = await processDomainEvents({ limit: 100, deadline: Date.now() + 35_000 });
    // Outgoing webhooks due now (queued by the "webhooks" event handler, retried with backoff).
    const due = await db.webhookDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: new Date() } }, distinct: ["businessId"], select: { businessId: true }, take: 20 });
    let webhooks = 0;
    for (const { businessId } of due) webhooks += (await withBusiness(businessId, () => deliverDueWebhooks(businessId, Date.now() + 15_000)).catch((e: Error) => { console.error("webhook delivery failed", { businessId, error: e.message }); return { processed: 0 }; })).processed;
    return Response.json({ ...events, webhooks });
  } catch (err) {
    return handleError(err);
  }
}
