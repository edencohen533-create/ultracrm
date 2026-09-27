import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { requirePlatformAdmin, setUserPermissions } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Platform admin edits a user's permissions in any business – still bounded by that business's package and seats. */
export const PUT = withAuth(async ({ req, user, params }) => {
  await requirePlatformAdmin(user);
  const body = await req.json().catch(() => null);
  return ok(await withBusiness(params.id, () => setUserPermissions({ ...user, businessId: params.id }, params.userId, body, { platform: true })));
});
