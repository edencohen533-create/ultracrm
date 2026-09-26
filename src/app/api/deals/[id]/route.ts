import { visibleUserIds } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { DEAL_INCLUDE, dealPatchSchema, updateDeal } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const ids = await visibleUserIds(user);
  const deal = await prisma.deal.findFirst({ where: { id: params.id, businessId: user.businessId, ...ownerScope(ids) }, include: { ...DEAL_INCLUDE, lead: { select: { id: true, status: true, title: true } }, tasks: { where: { status: "open", ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { dueAt: "asc" }, include: { user: { select: { id: true, fullName: true } } } } } });
  if (!deal) throw new ApiError("עסקה לא נמצאה", 404, "not_found");
  return ok(deal);
}, { module: "crm" });

export const PATCH = withAuth(async ({ req, user, params }) => ok(await updateDeal(user, params.id, await parseBody(req, dealPatchSchema))), { module: "crm" });
