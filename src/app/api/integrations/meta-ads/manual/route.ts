import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { connectManualToken } from "@/server/marketing/meta-connection";

export const dynamic = "force-dynamic";

/** Advanced: a system-user token with ads_read for one ad account (verified with Meta before it is stored). */
export const POST = withAuth(async ({ req, user }) => ok(await connectManualToken(user, await req.json())), { module: "crm" });
