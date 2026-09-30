import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { platformBusinessView } from "@/lib/platform/businesses";

export const dynamic = "force-dynamic";
/** Platform admins only: one business – status, package, seats, usage, health, billing state, support, audit. No content. */
export const GET = withAuth(async ({ user, params }) => ok(await platformBusinessView(user, params.id)));
