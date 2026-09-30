import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

export const maxDuration = 60;
export const GET = withAuth(async ({ user, params }) => ok(await svc.preview(user, params.id)));
