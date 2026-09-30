import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

export const PATCH = withAuth(async ({ req, user, params }) => ok(await svc.updateAuth(user, params.id, await req.json())));
