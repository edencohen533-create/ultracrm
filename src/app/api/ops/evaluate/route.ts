import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { runOpsTick } from "@/server/ops/engine";

/** "בדוק עכשיו" – the same check the cron runs every 2 minutes. */
export const POST = withAuth(async ({ user }) => ok(await runOpsTick(user.businessId)), { minRole: "manager", module: "crm" });
