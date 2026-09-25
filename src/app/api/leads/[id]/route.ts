import { visibleUserIds } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { LEAD_INCLUDE, leadPatchSchema, updateLead } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({ where: { id: params.id, businessId: user.businessId, ...ownerScope(ids) }, include: { ...LEAD_INCLUDE, tasks: { where: { status: "open", ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { dueAt: "asc" }, include: { user: { select: { id: true, fullName: true } } } }, deals: { where: ownerScope(ids), select: { id: true, title: true, stage: true, amount: true, currency: true } } } });
  if (!lead) throw new ApiError("ליד לא נמצא", 404, "not_found");
  return ok(lead);
}, { module: "crm" });

export const PATCH = withAuth(async ({ req, user, params }) => ok(await updateLead(user, params.id, await parseBody(req, leadPatchSchema))), { module: "crm" });
