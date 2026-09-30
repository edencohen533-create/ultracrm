import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { deleteStatus, deleteStatusSchema, deletionImpact } from "@/lib/crm/statuses";

export const dynamic = "force-dynamic";

/** What deleting this status would affect (leads, automations) and the allowed replacements (same meaning). */
export const GET = withAuth(async ({ user, params }) => ok(await deletionImpact(user.businessId, params.id)), { minRole: "manager", perm: "crm.edit" });

/** Delete a custom status (owner) – with a replacement when leads or automations use it. */
export const DELETE = withAuth(async ({ req, user, params }) => ok(await deleteStatus(user, params.id, await parseBody(req, deleteStatusSchema))), { minRole: "manager", perm: "crm.edit" });
