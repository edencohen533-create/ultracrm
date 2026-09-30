import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { effectiveAccess } from "@/lib/access/engine";
import { DialerHubNav } from "@/components/calling/DialerHubNav";

export const dynamic = "force-dynamic";

/** "חייגן" – dial lists, call history and (managers) active calls, as tabs with their own URLs. */
export default async function CallingLayout({ children }: { children: ReactNode }) {
  const session = await getValidSession();
  if (!session) redirect("/login");
  const access = await effectiveAccess(session.businessId, session.id);
  const showLive = session.role !== "agent" && access.modules.telephony.state === "active";
  return <><DialerHubNav showLive={showLive} />{children}</>;
}
