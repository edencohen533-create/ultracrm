import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { datasetsFromAdsConnection } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
/** Pixels / datasets visible through the ads-reading connection (to pick from). Reading them does not grant sending. */
export const GET = withAuth(async ({ user }) => { await assertCapiAccess(user, true); return ok(await datasetsFromAdsConnection(user.businessId)); }, { perm: "crm.marketing_connect" });
