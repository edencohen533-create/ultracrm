import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { connectionSchema, saveConnection } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
/** Save the dataset + token (sealed server-side; only a hint is ever returned). */
export const PUT = withAuth(async ({ req, user }) => { await assertCapiAccess(user, true); return ok(await saveConnection(user, await parseBody(req, connectionSchema))); }, { perm: "crm.marketing_connect" });
