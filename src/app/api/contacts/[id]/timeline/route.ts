import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { contactTimeline } from "@/lib/crm/timeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  return ok({ items: await contactTimeline(user, c.id) });
});
