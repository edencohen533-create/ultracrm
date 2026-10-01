import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Spinner } from "@/components/ui";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { ReportsOverview } from "@/components/reports/ReportsOverview";
import { ReportsNav } from "@/components/reports/ReportsNav";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const ent = await getEntitlements(session.businessId);
  // Telephony and / or WhatsApp activity (a business without both still has the marketing tab when allowed).
  if (!ent.modules.telephony && !ent.modules.whatsapp) redirect(ent.modules.crm ? "/reports/marketing" : "/leads");
  return <><ReportsNav /><Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><ReportsOverview /></Suspense></>;
}
