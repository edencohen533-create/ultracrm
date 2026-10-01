import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { ok, handleError, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { authenticateGeneralApiKey } from "@/server/services/integrations";
import { receiptSchema } from "@/server/services/store-order-service";

export const dynamic = "force-dynamic";

/**
 * Public API: a receipt from a SEPARATE invoicing system, attached to an existing order of this business by its
 * number (the number the customer sees). Two stores with the same number → send storeId. The receipt keeps its own
 * line items, so a mismatch with the order is visible (never silently merged).
 */
export async function POST(req: Request) {
  try {
    const a = await authenticateGeneralApiKey(req);
    let body: unknown; try { body = await req.json(); } catch { throw new ApiError("גוף הבקשה אינו JSON תקין", 400, "invalid_json"); }
    const p = z.object({ orderNumber: z.string().trim().min(1).max(120), storeId: z.string().trim().max(60).optional(), receipt: receiptSchema, source: z.string().trim().max(80).optional() }).safeParse(body);
    if (!p.success) throw new ApiError("נתונים לא תקינים", 400, "validation", p.error.flatten());
    const r = await withBusiness(a.business.id, async () => {
      const n = p.data.orderNumber.replace(/^#/, "");
      const orders = await prisma.storeOrder.findMany({ where: { businessId: a.business.id, orderNumber: { in: [n, `#${n}`] }, ...(p.data.storeId ? { storeId: p.data.storeId } : {}) }, select: { id: true, storeId: true } });
      if (!orders.length) throw new ApiError("לא נמצאה הזמנה עם המספר הזה בעסק", 404, "order_not_found");
      if (orders.length > 1) throw new ApiError("יש כמה הזמנות עם המספר הזה (כמה חנויות) – יש לשלוח storeId", 409, "ambiguous_order", { storeIds: orders.map((o) => o.storeId) });
      await prisma.storeOrder.update({ where: { id: orders[0].id }, data: { receipt: { ...p.data.receipt, source: p.data.source ?? "api" } as Prisma.InputJsonValue } });
      await audit(a.business.id, null, "store_order", orders[0].id, "store_order.receipt_attached", { source: p.data.source ?? "api", number: p.data.receipt.number ?? null });
      return { orderId: orders[0].id };
    }, a.session);
    return ok(r);
  } catch (e) { return handleError(e); }
}
