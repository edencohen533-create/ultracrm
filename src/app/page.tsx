import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { effectiveAccess } from "@/lib/access/engine";
import { Landing } from "@/components/public/Landing";

/** Home: logged out → the public landing page; logged in → the first screen this user may open. */
export default async function RootPage() {
  const s = await getValidSession();
  if (!s) return <Landing />;
  const a = await effectiveAccess(s.businessId, s.id).catch(() => null);
  const can = (m: keyof NonNullable<typeof a>["modules"], act: string) => a?.modules[m].state === "active" && a.modules[m].actions.includes(act);
  redirect(can("crm", "view") ? "/leads" : can("telephony", "use") ? "/dialer" : can("whatsapp", "view") ? "/inbox" : can("sms", "view") ? "/campaigns/sms" : can("email", "view") ? "/campaigns/email" : "/no-access?reason=module_not_assigned");
}
