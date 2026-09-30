import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { effectiveAccess } from "@/lib/access/engine";
import { AccessDenied } from "@/components/shared/access-denied";
import { CrmConnectionsScreen } from "@/components/crm-sync/CrmConnectionsScreen";
import { Spinner } from "@/components/ui";

export const dynamic = "force-dynamic";

/** הגדרות ← חיבורים ← CRM חיצוני. Owner, or a manager with business-wide scope (enforced again on every API). */
export default async function ExternalCrmPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  const a = await effectiveAccess(s.businessId, s.id);
  if (!a.isOwner && !(s.role === "manager" && a.scope === "business")) return <AccessDenied />;
  return <Suspense fallback={<div className="p-10 flex justify-center"><Spinner /></div>}><CrmConnectionsScreen /></Suspense>;
}
