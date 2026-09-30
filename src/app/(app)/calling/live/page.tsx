import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { LiveFloor } from "@/components/manager/LiveFloor";

export const dynamic = "force-dynamic";

/** "שיחות פעילות" – the floor view for managers only (the API enforces role, module and the manager's data scope). */
export default async function ActiveCallsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/calling/lists");
  return <LiveFloor />;
}
