import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { connectionOverview } from "@/server/services/embedded-signup-service";

export const dynamic = "force-dynamic";

/** Connection card data (no secrets). */
export const GET = withAuth(async () => ok(await connectionOverview()), { minRole: "manager", module: "messaging" });
