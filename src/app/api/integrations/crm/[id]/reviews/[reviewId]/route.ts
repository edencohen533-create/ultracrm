import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import * as svc from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user, params }) => ok(await svc.resolveReview(user, params.id, params.reviewId, await req.json())));
