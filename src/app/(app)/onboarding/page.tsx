import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";

export const dynamic = "force-dynamic";
export default async function OnboardingPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  if (s.role === "agent") redirect("/leads");
  return <OnboardingChecklist />;
}
