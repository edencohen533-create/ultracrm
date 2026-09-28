import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { permissionMatrix } from "@/lib/access/manage";
import { ACTIONS, DEPENDENCIES, MODULE_LABEL, SCOPE_LABEL, TEMPLATES } from "@/lib/access/catalog";

export const dynamic = "force-dynamic";
/** Business permission matrix: users × modules (within the manager's scope), seats, the package and the catalog. */
export const GET = withAuth(async ({ user }) => ok({ ...(await permissionMatrix(user)), catalog: { actions: ACTIONS, labels: MODULE_LABEL, scopes: SCOPE_LABEL, templates: TEMPLATES, dependencies: DEPENDENCIES } }), { minRole: "manager" });
