import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { ruleSchema, saveRule } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ req, user }) => { await assertCapiAccess(user, true); return ok(await saveRule(user, await parseBody(req, ruleSchema)), 201); }, { perm: "crm.marketing_connect" });
