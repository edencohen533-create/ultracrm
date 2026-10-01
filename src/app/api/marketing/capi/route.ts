import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma, dbSchema } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { ACTION_SOURCES, STANDARD_EVENTS, TEMPLATES, TRIGGERS, VALUE_SOURCES, getConnection } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";

/** Everything the "המרות למטא" screen needs: connection (no token), rules, the business's real statuses and fields. */
export const GET = withAuth(async ({ user }) => { await assertCapiAccess(user, false); 
  const [connection, rules, statuses, adsConnection, counts] = await Promise.all([
    getConnection(user.businessId),
    prisma.metaCapiRule.findMany({ where: { businessId: user.businessId }, orderBy: { createdAt: "asc" } }),
    prisma.leadStatusDef.findMany({ where: { businessId: user.businessId, deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, label: true, kind: true, active: true } }),
    prisma.metaAdConnection.findUnique({ where: { businessId: user.businessId }, select: { status: true, scopes: true } }),
    prisma.metaCapiEvent.groupBy({ by: ["status"], where: { businessId: user.businessId }, _count: { _all: true } }),
  ]);
  // Custom fields actually used by this business's contacts (keys only).
  const keys = await prisma.$queryRaw<Array<{ k: string }>>(Prisma.sql`SELECT DISTINCT jsonb_object_keys(custom_fields) AS k FROM ${Prisma.raw(`"${dbSchema()}"."contacts"`)} WHERE business_id = ${user.businessId} AND jsonb_typeof(custom_fields) = 'object' LIMIT 200`).catch(() => []);
  return ok({
    connection, rules: rules.map((r) => ({ ...r, fixedValue: r.fixedValue === null ? null : Number(r.fixedValue) })), statuses, fields: keys.map((x) => x.k).sort(),
    adsConnection: adsConnection ? { status: adsConnection.status, scopes: adsConnection.scopes } : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    vocabulary: { triggers: TRIGGERS, actionSources: ACTION_SOURCES, valueSources: VALUE_SOURCES, standardEvents: STANDARD_EVENTS, templates: TEMPLATES },
    eventsManagerUrl: connection ? `https://business.facebook.com/events_manager2/list/dataset/${connection.datasetId}/overview` : "https://business.facebook.com/events_manager2",
  });
}, { perm: "crm.marketing_view" });
