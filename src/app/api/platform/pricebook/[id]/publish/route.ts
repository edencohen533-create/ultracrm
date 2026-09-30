import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin, accessAudit } from "@/lib/access/manage";
import { publishVersion } from "@/server/billing/pricebook";
import { invalidateRates } from "@/server/billing/usage";

export const dynamic = "force-dynamic";
/** Publish = the version NEW purchases use. Existing subscriptions and issued documents are never repriced. */
export const POST = withAuth(async ({ user, params }) => {
  await requirePlatformAdmin(user);
  const v = await withoutBusiness(() => publishVersion(params.id));
  invalidateRates();
  await accessAudit({ businessId: null, actorAccountId: user.accountId, action: "platform.pricebook_published", after: { version: v.version } });
  return ok(v);
});
