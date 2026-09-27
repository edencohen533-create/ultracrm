import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { effectiveAccess } from "@/lib/access/engine";

/** Home = the first screen this user may open (CRM users keep landing on /leads, as before). */
export default async function RootPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  const a = await effectiveAccess(s.businessId, s.id).catch(() => null);
  const can = (m: keyof NonNullable<typeof a>["modules"], act: string) => a?.modules[m].state === "active" && a.modules[m].actions.includes(act);
  redirect(can("crm", "view") ? "/leads" : can("telephony", "use") ? "/dialer" : can("whatsapp", "view") ? "/inbox" : can("sms", "view") ? "/campaigns/sms" : can("email", "view") ? "/campaigns/email" : "/no-access?reason=module_not_assigned");
}
