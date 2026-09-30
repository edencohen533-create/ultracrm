import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { waitingToday } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/** "ממתינים לשיחה היום": the owner – whole business / one agent / unassigned; everyone else – only their own. */
export const GET = withAuth(async ({ req, user }) => {
  const r = await waitingToday(user, req.nextUrl.searchParams.get("agent") || null);
  return ok({ asOf: r.asOf, timezone: r.timezone, counts: r.counts });
}, { perm: "crm.view" });
