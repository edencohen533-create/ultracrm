import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { transferLeads, transferSchema } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/** Manager: move one or many leads to an active agent. Leads in a live call are moved when that call is documented. */
export const POST = withAuth(async ({ req, user }) => ok(await transferLeads(user, await parseBody(req, transferSchema))), { module: "crm", minRole: "manager" });
