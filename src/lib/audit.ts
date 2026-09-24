import { prisma, type Db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Audit log for management actions and sensitive changes. Never throws – a
 * failed audit write must not roll back the business operation.
 */
export async function audit(businessId: string, actorId: string | null, entityType: string, entityId: string, action: string, payload?: Record<string, unknown>, db: Db = prisma, conversationId?: string | null) {
  try {
    await db.auditLog.create({ data: { businessId, actorId, entityType, entityId, action, conversationId: conversationId ?? null, payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined } });
  } catch (err) {
    console.error("[audit] failed", err);
  }
}

/** Messaging-module style helper (ported from solinainbox). Uses the current business context. */
export interface AuditLogInput {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  conversationId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function writeAuditLog(input: AuditLogInput, db: Db = prisma): Promise<void> {
  const { requireBusinessId } = await import("@/lib/tenant");
  await audit(requireBusinessId(), input.actorUserId ?? null, input.entityType, input.entityId, input.action, (input.metadata ?? {}) as Record<string, unknown>, db, input.conversationId);
}
