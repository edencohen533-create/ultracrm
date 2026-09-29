import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { routingOverview, saveRouting } from "@/server/services/telephony-admin-service";

export const dynamic = "force-dynamic";

const provider = z.enum(["telnyx", "mock", "zadarma"]);
const patch = z.object({
  primaryProvider: provider.nullable().optional(),
  backupProvider: provider.nullable().optional(),
  mode: z.enum(["primary_only", "manual_backup", "auto_failover"]).optional(),
  manualActive: z.enum(["primary", "backup"]).optional(),
  failureThreshold: z.number().int().min(1).max(100).optional(),
  windowSeconds: z.number().int().min(10).max(3600).optional(),
  cooldownSeconds: z.number().int().min(30).max(86400).optional(),
  probeCalls: z.number().int().min(1).max(20).optional(),
  backupDailyCallLimit: z.number().int().min(1).max(100000).nullable().optional(),
  failoverOnCapacity: z.boolean().optional(),
});

/** Provider routing for new calls – business owner only. */
export const GET = withAuth(async ({ user }) => ok(await routingOverview(user.businessId)), { minRole: "owner", module: "telephony" });
export const PATCH = withAuth(async ({ req, user }) => {
  await saveRouting(user.businessId, user.id, await parseBody(req, patch));
  return ok(await routingOverview(user.businessId));
}, { minRole: "owner", module: "telephony" });
