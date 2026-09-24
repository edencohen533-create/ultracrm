import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { createDeal, dealFilterSchema, dealInputSchema, listDeals } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => ok(await listDeals(user, parseQuery(req, dealFilterSchema))));

export const POST = withAuth(async ({ req, user }) => ok(await createDeal(user, await parseBody(req, dealInputSchema)), 201));
