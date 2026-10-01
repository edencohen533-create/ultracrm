import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Spinner } from "@/components/ui";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { ReportsOverview } from "@/components/reports/ReportsOverview";
import { ReportsNav } from "@/components/reports/ReportsNav";

export const dynamic = "force-dynamic";

export default async function WhatsAppReportsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const ent = await getEntitlements(session.businessId);
  if (!ent.modules.whatsapp) redirect(ent.modules.telephony ? "/reports" : ent.modules.crm ? "/reports/marketing" : "/leads");
  return <><ReportsNav /><Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><ReportsOverview channel="whatsapp" /></Suspense></>;
}
