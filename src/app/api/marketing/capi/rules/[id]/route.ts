import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ruleSchema, saveRule } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
export const PUT = withAuth(async ({ req, user, params }) => { await assertCapiAccess(user, true); return ok(await saveRule(user, await parseBody(req, ruleSchema), params.id)); }, { perm: "crm.marketing_connect" });
/** Deleting a rule keeps its log rows (the rule link becomes empty); queued events of it are not sent any more. */
export const DELETE = withAuth(async ({ user, params }) => { await assertCapiAccess(user, true); 
  const r = await prisma.metaCapiRule.findFirst({ where: { id: params.id }, select: { id: true } });
  if (!r) throw new ApiError("הכלל לא נמצא", 404, "not_found");
  await prisma.metaCapiEvent.updateMany({ where: { ruleId: r.id, status: { in: ["queued", "pending_data"] } }, data: { status: "skipped", statusReason: "הכלל נמחק לפני השליחה" } });
  await prisma.metaCapiRule.delete({ where: { id: r.id } });
  await audit(user.businessId, user.id, "marketing", r.id, "capi.rule_deleted", {});
  return ok({ deleted: true });
}, { perm: "crm.marketing_connect" });
