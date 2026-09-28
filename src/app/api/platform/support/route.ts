import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Platform admin: public support requests, Meta deletion/deauthorize callbacks and business deletion requests. */
export const GET = withAuth(async ({ user }) => {
  await requirePlatformAdmin(user);
  return ok(await withoutBusiness(async () => ({
    support: await db.supportRequest.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, email: true, businessName: true, topic: true, message: true, lang: true, status: true, createdAt: true } }),
    meta: await db.metaDeletionRequest.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    deletions: await db.business.findMany({ where: { deletionScheduledFor: { not: null } }, select: { id: true, name: true, deletionRequestedAt: true, deletionScheduledFor: true } }),
  })));
});
