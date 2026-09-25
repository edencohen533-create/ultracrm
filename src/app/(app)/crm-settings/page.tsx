import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { CrmSettings } from "@/components/crm-settings/CrmSettings";
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await getValidSession();
  if (!user) redirect("/login");
  if (!(await getEntitlements(user.businessId)).modules.crm) redirect("/leads");
  return <CrmSettings />;
}
