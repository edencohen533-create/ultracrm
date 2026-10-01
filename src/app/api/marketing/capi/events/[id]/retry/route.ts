import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { retryEvent } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ user, params }) => { await assertCapiAccess(user, true); return ok(await retryEvent(user, params.id)); }, { perm: "crm.marketing_connect" });
