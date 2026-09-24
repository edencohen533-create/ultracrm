import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Who changed which setting, when (from the audit log). */
export const GET = withAuth(async ({ user }) => {
  const items = await prisma.auditLog.findMany({
    where: { businessId: user.businessId, entityType: { in: ["settings", "list", "dnc", "automation", "monitor"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { id: true, fullName: true } } },
  });
  return ok(items);
}, { minRole: "manager" });
