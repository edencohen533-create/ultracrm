import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

/** Start the initial import (continues in the background job; progress on the status screen). */
export const POST = withAuth(async ({ user, params }) => ok(await svc.startInitialSync(user, params.id)));
