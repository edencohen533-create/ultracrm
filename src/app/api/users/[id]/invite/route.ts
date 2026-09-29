import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { reissueInvite } from "@/server/services/invite-service";

export const dynamic = "force-dynamic";

/** New one-time invite link for a membership that was never accepted (the previous link stops working). Owner only. */
export const POST = withAuth(async ({ user, params }) => ok(await reissueInvite(user.businessId, user.id, params.id)), { minRole: "owner" });
