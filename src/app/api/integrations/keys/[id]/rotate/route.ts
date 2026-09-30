import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { audit } from "@/lib/audit";
import { assertIntegrationAdmin } from "@/server/crm-sync/connections";
import { rotateApiKey } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

/** Replace a key: the new one is shown once; the old one keeps working for 24 hours, then expires. */
export const POST = withAuth(async ({ user, params }) => {
  await assertIntegrationAdmin(user);
  const r = await rotateApiKey(user, params.id);
  await audit(user.businessId, user.id, "business", user.businessId, "integration.key_rotated", { oldKeyId: params.id, newKeyId: r.id });
  return ok(r, 201);
});
