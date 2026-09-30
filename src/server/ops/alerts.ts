/**
 * Unified platform alerts: one row per fingerprint. The same problem again only bumps count / lastSeenAt (no flood);
 * a resolved alert that recurs reopens the same row. Platform-level (no business scope needed).
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export async function raiseAlert(a: { fingerprint: string; severity: "info" | "warning" | "critical"; category: string; businessId?: string | null; title: string; details?: Record<string, unknown> }) {
  const { withoutBusiness } = await import("@/lib/tenant");
  return withoutBusiness(() => db.platformAlert.upsert({
    where: { fingerprint: a.fingerprint.slice(0, 300) },
    create: { fingerprint: a.fingerprint.slice(0, 300), severity: a.severity, category: a.category, businessId: a.businessId ?? null, title: a.title.slice(0, 300), details: (a.details ?? {}) as Prisma.InputJsonValue },
    update: { count: { increment: 1 }, lastSeenAt: new Date(), severity: a.severity, title: a.title.slice(0, 300), details: (a.details ?? {}) as Prisma.InputJsonValue, status: "open", resolvedAt: null },
  }));
}
export async function resolveAlert(fingerprint: string) {
  const { withoutBusiness } = await import("@/lib/tenant");
  return withoutBusiness(() => db.platformAlert.updateMany({ where: { fingerprint, status: { not: "resolved" } }, data: { status: "resolved", resolvedAt: new Date() } }));
}
