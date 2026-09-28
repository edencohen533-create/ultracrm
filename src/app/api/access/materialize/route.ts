import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { materializeDerived } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Owner: confirm the role-based mapping of users that were never assigned explicitly (stores it as-is). */
export const POST = withAuth(async ({ user }) => ok({ confirmed: await materializeDerived(user.businessId, user.accountId) }), { minRole: "owner" });
