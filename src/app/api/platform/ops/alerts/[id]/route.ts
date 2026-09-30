import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const PATCH = withAuth(async ({ req, user, params }) => {
  await requirePlatformAdmin(user);
  const b = await parseBody(req, z.object({ status: z.enum(["acknowledged", "resolved", "open"]) }));
  return ok(await withoutBusiness(() => db.platformAlert.update({ where: { id: params.id }, data: { status: b.status, resolvedAt: b.status === "resolved" ? new Date() : null } })));
});
