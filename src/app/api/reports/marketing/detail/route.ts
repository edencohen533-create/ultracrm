import { withAuth, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { assertMarketing } from "@/server/marketing/meta-connection";
import { marketingRowDetail } from "@/server/marketing/report";
import { reportQuerySchema, toParams } from "@/server/marketing/params";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The inquiries / deals / purchases behind one row (same filters and calculation as the report). */
export const GET = withAuth(async ({ req, user }) => {
  await assertMarketing(user, "view");
  const q = parseQuery(req, reportQuerySchema);
  if (!q.key) throw new ApiError("חסר מזהה שורה", 400, "validation");
  return ok(await marketingRowDetail(user, toParams(q), q.key));
}, { module: "crm" });
