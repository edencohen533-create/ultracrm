import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Every version of an insight (source recording, who reviewed, when). */
export const GET = withAuth(async ({ user, params }) => {
  const cur = await prisma.salesInsight.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, rootId: true } });
  if (!cur) throw new ApiError("התובנה לא נמצאה", 404, "not_found");
  const items = await prisma.salesInsight.findMany({ where: { businessId: user.businessId, OR: [{ rootId: cur.rootId ?? cur.id }, { id: cur.rootId ?? cur.id }] }, orderBy: { version: "desc" }, select: { id: true, version: true, title: true, body: true, objection: true, status: true, flags: true, autoPublished: true, reviewedAt: true, reviewedById: true, createdAt: true } });
  const ids = [...new Set(items.map((i) => i.reviewedById).filter((x): x is string => Boolean(x)))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  return ok({ items: items.map((i) => ({ ...i, reviewedBy: users.find((u) => u.id === i.reviewedById)?.fullName ?? null })) });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
