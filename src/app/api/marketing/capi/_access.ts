import { can, effectiveAccess } from "@/lib/access/engine";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";

/** Same gate as the marketing report: the permission AND a business-wide data scope (the log names customers). */
export async function assertCapiAccess(user: SessionUser, manage = false) {
  const a = await effectiveAccess(user.businessId, user.id);
  if (!can(a, manage ? "crm.marketing_connect" : "crm.marketing_view") || (!a.isOwner && a.scope !== "business")) throw new ApiError("אין הרשאה להמרות למטא", 403, "forbidden");
}
