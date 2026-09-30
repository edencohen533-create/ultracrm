import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { assertMarketing, connectionStatus, disconnect } from "@/server/marketing/meta-connection";

export const dynamic = "force-dynamic";

/** Meta Ads connection status of the active business (no token ever returned). */
export const GET = withAuth(async ({ user }) => { await assertMarketing(user, "view"); return ok(await connectionStatus(user)); }, { module: "crm" });

/** Disconnect (token deleted). ?deleteData=1 also deletes the synced ad data of this business. */
export const DELETE = withAuth(async ({ req, user }) => ok(await disconnect(user, { deleteData: new URL(req.url).searchParams.get("deleteData") === "1" })), { module: "crm" });
