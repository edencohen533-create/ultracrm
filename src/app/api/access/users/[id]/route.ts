import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { setUserPermissions } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Set a user's modules / actions / data scope – inside this business and the package only (see manage.ts rules). */
export const PUT = withAuth(async ({ req, user, params }) => ok(await setUserPermissions(user, params.id, await req.json().catch(() => null))), { minRole: "manager" });
