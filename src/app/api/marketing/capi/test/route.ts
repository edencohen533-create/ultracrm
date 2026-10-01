import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { sendTestEvent } from "@/server/marketing/capi";

export const dynamic = "force-dynamic";
/** Sends one test event – only with the Test Event Code (Events Manager → Test events), never as production data. */
export const POST = withAuth(async ({ user }) => { await assertCapiAccess(user, true); return ok(await sendTestEvent(user)); }, { perm: "crm.marketing_connect" });
