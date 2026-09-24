import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export async function audit(businessId: string, actorId: string | null, entityType: string, entityId: string, action: string, payload?: Record<string, unknown>, db: Prisma.TransactionClient = prisma) {
  try {
    await db.auditLog.create({ data: { businessId, actorId, entityType, entityId, action, payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined } });
  } catch (err) {
    console.error("[audit] failed", err);
  }
}
