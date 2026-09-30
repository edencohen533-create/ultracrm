import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => ok(await svc.discovery(user, params.id)));
