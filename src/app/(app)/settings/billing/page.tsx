import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { AccessDenied } from "@/components/shared/access-denied";
import { BillingScreen } from "@/components/billing/BillingScreen";

export const dynamic = "force-dynamic";
/** הגדרות ← חיוב ושימוש – the owner or a billing admin (billing is separate from module permissions). */
export default async function BillingPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  const u = await db.user.findFirst({ where: { id: s.id, businessId: s.businessId }, select: { role: true, permissions: true, isSupport: true } });
  if (!u || u.isSupport || !(u.role === "owner" || (u.permissions as { billingAdmin?: boolean } | null)?.billingAdmin)) return <AccessDenied />;
  return <BillingScreen />;
}
