import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { requirePlatformAdmin } from "@/lib/access/manage";
import { cancelCredit } from "@/server/billing/pricing";

export const dynamic = "force-dynamic";

/** Cancel a credit that was not used yet. */
export const DELETE = withAuth(async ({ user, params }) => { await requirePlatformAdmin(user); return ok(await cancelCredit(user, params.id, params.creditId)); });
