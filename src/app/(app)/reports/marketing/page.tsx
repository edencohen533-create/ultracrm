import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { can, effectiveAccess } from "@/lib/access/engine";
import { AccessDenied } from "@/components/shared/access-denied";
import { ReportsNav } from "@/components/reports/ReportsNav";
import { MarketingReport } from "@/components/marketing/MarketingReport";
import { Spinner } from "@/components/ui";

export const dynamic = "force-dynamic";

/** דוחות ← שיווק ומכירות. Business-wide revenue and ad spend: the explicit permission and a business-level data scope. */
export default async function MarketingReportPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const a = await effectiveAccess(session.businessId, session.id);
  if (!can(a, "crm.marketing_view") || (!a.isOwner && a.scope !== "business")) return <AccessDenied />;
  return (
    <>
      <ReportsNav />
      <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}>
        <MarketingReport canConnect={can(a, "crm.marketing_connect")} canExport={can(a, "crm.export")} />
      </Suspense>
    </>
  );
}
