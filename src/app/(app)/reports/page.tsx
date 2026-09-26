import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { AgentPerformance } from "@/components/reports/AgentPerformance";
import { ReportsNav } from "@/components/reports/ReportsNav";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const ent = await getEntitlements(session.businessId);
  if (!ent.modules.telephony) redirect(ent.modules.messaging ? "/analytics" : "/leads");
  return <><ReportsNav /><AgentPerformance /></>;
}
