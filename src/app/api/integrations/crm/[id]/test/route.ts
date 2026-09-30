import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

/** A real request to the external system – only a pass makes the connection active. */
export const POST = withAuth(async ({ user, params }) => ok(await svc.testConnection(user, params.id)));
