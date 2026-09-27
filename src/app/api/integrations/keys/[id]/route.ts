import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Revoke immediately – the next request with this key is rejected. */
export const DELETE = withAuth(async ({ user, params }) => {
  const r = await prisma.apiKey.updateMany({ where: { id: params.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw new ApiError("המפתח לא נמצא", 404, "not_found");
  await audit(user.businessId, user.id, "api_key", params.id, "api_key.revoked");
  return ok({ revoked: true });
}, { minRole: "manager" });
