import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { availableAccounts, setAccounts } from "@/server/marketing/meta-connection";

export const dynamic = "force-dynamic";

/** Ad accounts the connected Meta login can read (to choose from). */
export const GET = withAuth(async ({ user }) => ok(await availableAccounts(user)), { module: "crm" });
/** { accountIds, historyDays } – which accounts belong to this business and how far back to sync. */
export const PUT = withAuth(async ({ req, user }) => ok(await setAccounts(user, await req.json())), { module: "crm" });
