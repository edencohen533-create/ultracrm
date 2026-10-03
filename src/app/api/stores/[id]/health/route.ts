import { withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { ok, ApiError } from "@/lib/response";
export const GET = withAuth(async ({ params }) => {
  const store = await prisma.storeConnection.findUnique({ where: { id: params.id } });
  if (!store) throw new ApiError("החנות לא נמצאה", 404, "not_found");
  const [cart, purchase, failed, pending] = await Promise.all([
    prisma.cart.findFirst({ where: { storeId: store.id, status: { not: "empty" }, items: { not: [] } }, orderBy: { lastActivityAt: "desc" }, select: { externalId: true, lastActivityAt: true } }),
    prisma.cart.findFirst({ where: { storeId: store.id, status: { in: ["converted", "recovered"] } }, orderBy: { convertedAt: "desc" }, select: { externalId: true, orderId: true, convertedAt: true } }),
    prisma.storeEvent.count({ where: { storeId: store.id, status: "failed" } }),
    prisma.storeEvent.count({ where: { storeId: store.id, status: { in: ["pending", "processing"] } } }),
  ]);
  return ok({ active: store.isActive, api: store.apiStatus, webhook: store.webhookStatus, lastVerifiedEventAt: store.lastVerifiedEventAt, cart, purchase, failed, pending });
}, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
