import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { checkConnection } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ user }) => { await assertCapiAccess(user, true); return ok(await checkConnection(user)); }, { perm: "crm.marketing_connect" });
