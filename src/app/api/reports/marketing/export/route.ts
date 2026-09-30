import { withAuth, parseQuery } from "@/lib/api";
import { assertAccess } from "@/lib/access/engine";
import { audit } from "@/lib/audit";
import { assertMarketing } from "@/server/marketing/meta-connection";
import { marketingReport } from "@/server/marketing/report";
import { reportQuerySchema, toParams } from "@/server/marketing/params";
import { reportCsv } from "@/server/marketing/export";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** CSV of exactly what the screen shows (same filters, same calculation) – needs the export permission too. */
export const GET = withAuth(async ({ req, user }) => {
  await assertMarketing(user, "view");
  await assertAccess(user, "crm.export");
  const q = parseQuery(req, reportQuerySchema);
  const report = await marketingReport(user, toParams(q));
  await audit(user.businessId, user.id, "business", user.businessId, "marketing.report_exported", { from: q.from, to: q.to, mode: q.mode, level: q.level });
  return new Response(reportCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="marketing-${q.level}-${q.from}-${q.to}.csv"`, "Cache-Control": "private, no-store" } });
}, { module: "crm" });
