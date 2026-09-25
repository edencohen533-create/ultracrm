import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { createLead, leadFilterSchema, leadInputSchema, listLeads } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => ok(await listLeads(user, parseQuery(req, leadFilterSchema))), { module: "crm" });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, leadInputSchema);
  return ok(await createLead(user, b), 201);
}, { module: "crm" });
