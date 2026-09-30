import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { assertMarketing } from "@/server/marketing/meta-connection";
import { marketingReport } from "@/server/marketing/report";
import { reportQuerySchema, toParams } from "@/server/marketing/params";
import { backfillLeadTouchpoints } from "@/lib/marketing/touchpoints";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Marketing & sales report (Meta spend ↔ inquiries ↔ handling ↔ paid purchases). Business-wide view only. */
export const GET = withAuth(async ({ req, user }) => {
  await assertMarketing(user, "view");
  await backfillLeadTouchpoints(user.businessId); // leads from before touchpoints – idempotent, cheap once done
  return ok(await marketingReport(user, toParams(parseQuery(req, reportQuerySchema))));
}, { module: "crm" });
