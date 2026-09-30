import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

/** Available connectors (real status, capabilities) and this business's connections. No CRM module needed. */
export const GET = withAuth(async ({ user }) => ok({ connectors: svc.connectorCatalog(), connections: await svc.listConnections(user) }));
/** Create a connection (credentials sealed; generated signing secrets shown once). */
export const POST = withAuth(async ({ req, user }) => ok(await svc.createConnection(user, await req.json()), 201));
