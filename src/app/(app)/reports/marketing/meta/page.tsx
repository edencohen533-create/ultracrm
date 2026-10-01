import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { can, effectiveAccess } from "@/lib/access/engine";
import { AccessDenied } from "@/components/shared/access-denied";
import { ReportsNav } from "@/components/reports/ReportsNav";
import { MetaConversions } from "@/components/marketing/MetaConversions";

export const dynamic = "force-dynamic";

/** דוחות ← שיווק ומכירות ← המרות למטא. Same gate as the marketing report; managing needs marketing_connect. */
export default async function MetaConversionsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const a = await effectiveAccess(session.businessId, session.id);
  if (!can(a, "crm.marketing_view") || (!a.isOwner && a.scope !== "business")) return <AccessDenied />;
  return <><ReportsNav /><MetaConversions canManage={can(a, "crm.marketing_connect")} /></>;
}
