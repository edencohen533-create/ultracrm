import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

/** Status screen: connection, freshness, synced counts, write-back queue, failures, review queue. */
export const GET = withAuth(async ({ user, params }) => ok(await svc.connectionStatus(user, params.id)));
