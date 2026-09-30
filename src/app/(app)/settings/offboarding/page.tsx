import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { AccessDenied } from "@/components/shared/access-denied";
import { OffboardingScreen } from "@/components/billing/OffboardingScreen";

export const dynamic = "force-dynamic";
export default async function OffboardingPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  if (s.role !== "owner" || s.supportSessionId) return <AccessDenied />;
  return <OffboardingScreen />;
}
