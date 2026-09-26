import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { findDuplicateGroups } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";

/** Possible duplicate contacts (same email / same name). Nothing is merged automatically. */
export const GET = withAuth(async ({ user }) => ok({ groups: await findDuplicateGroups(user.businessId) }), { minRole: "manager", module: "crm" });
