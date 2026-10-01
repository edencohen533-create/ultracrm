import { ok, handleError, ApiError } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { authenticateGeneralApiKey } from "@/server/services/integrations";
import { orderSnapshotSchema, upsertStoreOrder } from "@/server/services/store-order-service";

export const dynamic = "force-dynamic";

/**
 * Public API: an order snapshot from any system (ERP, invoicing, courier, a store without a native connector).
 * Upsert by externalId. Send what you know: items as sold (bundles with components / component lines with
 * parentKey, gifts / benefits, refunded quantities), shipments (split parcels with their items and status) and the
 * receipt (its own line items + https link). Fields you omit keep their stored value. Scoped to the key's business.
 */
export async function POST(req: Request) {
  try {
    const a = await authenticateGeneralApiKey(req);
    let body: unknown; try { body = await req.json(); } catch { throw new ApiError("גוף הבקשה אינו JSON תקין", 400, "invalid_json"); }
    const p = orderSnapshotSchema.safeParse(body);
    if (!p.success) throw new ApiError("נתונים לא תקינים", 400, "validation", p.error.flatten());
    const order = await withBusiness(a.business.id, () => upsertStoreOrder(a.business.id, "api", p.data), a.session);
    return ok({ id: order.id, orderNumber: order.orderNumber, contactLinked: Boolean(order.contactId) });
  } catch (e) { return handleError(e); }
}
