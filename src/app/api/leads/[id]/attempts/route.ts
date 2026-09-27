import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { attemptHistory } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/** Dial attempts of a lead: date/time, agent, result. Same visibility as the lead itself. */
export const GET = withAuth(async ({ user, params }) => ok({ items: await attemptHistory(user, params.id) }), { module: "crm" });
