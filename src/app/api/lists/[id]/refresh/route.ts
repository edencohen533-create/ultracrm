import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { addLeadsToList } from "@/lib/lists";
import { audit } from "@/lib/audit";
import type { ContactFilter } from "@/lib/contacts";

export const dynamic = "force-dynamic";

/** Dynamic list: re-apply the saved CRM filter and add newly matching contacts (never removes). */
export const POST = withAuth(async ({ user, params }) => {
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  if (!list.filterJson) throw new ApiError("לרשימה אין סינון שמור – היא מוקפאת", 400, "list_frozen");
  const added = await addLeadsToList(user.businessId, list.id, list.filterJson as ContactFilter);
  await prisma.dialList.update({ where: { id: list.id }, data: { lastRefreshedAt: new Date() } });
  await audit(user.businessId, user.id, "automation", list.id, "automation.list_refreshed", { trigger: "manual_refresh", added, result: "ok" });
  return ok({ added });
}, { minRole: "manager" });
