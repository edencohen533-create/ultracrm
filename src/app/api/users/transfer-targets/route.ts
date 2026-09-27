import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { canTransferLeads } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/** Who can receive a transferred lead (names only). Agents allowed to transfer see every active user of the business. */
export const GET = withAuth(async ({ user }) => {
  if (!(await canTransferLeads(user))) throw new ApiError("אין הרשאה להעביר לידים", 403, "forbidden");
  const ids = user.role === "agent" ? null : await visibleUserIds(user);
  const items = await prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true } });
  return ok({ items });
}, { module: "crm" });
