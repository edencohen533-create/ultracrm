import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { getConnection, previewPayload, ruleSchema } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
/** What a rule would send – field names only, never a customer's data. */
export const POST = withAuth(async ({ req, user }) => { await assertCapiAccess(user, true); return ok(previewPayload(await parseBody(req, ruleSchema), await getConnection(user.businessId))); }, { perm: "crm.marketing_connect" });
