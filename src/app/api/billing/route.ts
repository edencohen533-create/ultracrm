import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { billingOverview } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
/** חיוב ושימוש – subscription, licenses, documents, notices. Owner / billing admin only (separate from module work). */
export const GET = withAuth(async ({ user }) => ok(await billingOverview(user)));
