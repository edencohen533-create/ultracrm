import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Upgrade requests from business managers + the latest package / permission changes across the platform. */
export const GET = withAuth(async ({ user }) => {
  await requirePlatformAdmin(user);
  return ok(await withoutBusiness(async () => {
    const rows = await db.accessAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const biz = await db.business.findMany({ where: { id: { in: rows.map((r) => r.businessId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const name = new Map(biz.map((b) => [b.id, b.name]));
    return { items: rows.map((r) => ({ ...r, businessName: r.businessId ? name.get(r.businessId) ?? null : null })) };
  }));
});
