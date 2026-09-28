import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { opsOverview } from "@/server/ops/overview";

export const dynamic = "force-dynamic";

/** "מנהל AI" – everything the manager screen shows (scoped to the manager's team). */
export const GET = withAuth(async ({ user }) => ok(await opsOverview(user)), { minRole: "manager", module: "crm" });
