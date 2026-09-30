import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user, params }) => { await requirePlatformAdmin(user); return ok(await withoutBusiness(() => db.reconciliationRun.findUniqueOrThrow({ where: { id: params.id }, include: { items: { take: 2000, orderBy: { kind: "asc" } } } }))); });
