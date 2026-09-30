import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { withIntegration } from "@/server/crm-sync/public-api";

export const dynamic = "force-dynamic";

/** Sync state of one external record here: linked local id, last applied source version / time, selection, review. */
export async function GET(req: Request, { params }: { params: Promise<{ type: string; externalId: string }> }) {
  const { type, externalId } = await params;
  return withIntegration(req, type === "lead" ? "leads:write" : "contacts:write", async (a) => {
    if (!["contact", "lead"].includes(type)) throw new ApiError("סוג רשומה לא תקין", 400, "validation");
    const link = await prisma.externalRecordLink.findUnique({ where: { businessId_connectionId_recordType_externalId: { businessId: a.business.id, connectionId: a.connection.id, recordType: type, externalId: decodeURIComponent(externalId) } } });
    if (!link) throw new ApiError("הרשומה לא נמצאה", 404, "not_found");
    const review = await prisma.crmReviewItem.findMany({ where: { businessId: a.business.id, connectionId: a.connection.id, recordType: type, externalId: link.externalId, status: "open" }, select: { kind: true, createdAt: true } });
    return { externalId: link.externalId, localId: link.localId, sourceUpdatedAt: link.sourceUpdatedAt, sourceVersion: link.sourceVersion, lastSyncedAt: link.lastSyncedAt, selected: link.selected, deletedAt: link.deletedAt, openReview: review };
  });
}
