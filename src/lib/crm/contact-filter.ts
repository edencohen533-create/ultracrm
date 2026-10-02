import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { AudienceError, listAudienceWhere } from "@/server/services/audience-service";
import { contactWhere, type ContactFilter } from "./contacts";

/** Resolve both ordinary filters and saved audiences; never widen an unavailable audience to all contacts. */
export async function resolvedContactWhere(businessId: string, filter: ContactFilter): Promise<Prisma.ContactWhereInput> {
  const where = contactWhere(businessId, filter);
  if (!filter.segmentId) return where;
  const list = await prisma.distributionList.findFirst({ where: { id: filter.segmentId, businessId }, select: { id: true, segment: true } });
  if (!list) throw new ApiError("הסגמנט לא נמצא", 404, "not_found");
  try { return { AND: [where, await listAudienceWhere(prisma as unknown as Prisma.TransactionClient, list, new Date())] }; }
  catch (e) { if (e instanceof AudienceError) throw new ApiError(e.message, 400, "segment_invalid"); throw e; }
}
