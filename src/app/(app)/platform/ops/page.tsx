import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { PlatformOps } from "@/components/access/PlatformOps";

export const dynamic = "force-dynamic";
/** Platform administrators only (Account.isPlatformAdmin) – the APIs check it again on every call. */
export default async function PlatformOpsPage() {
  const s = await getValidSession();
  if (!s) redirect("/login");
  const a = await withoutBusiness(() => db.account.findUnique({ where: { id: s.accountId }, select: { isPlatformAdmin: true } }));
  if (!a?.isPlatformAdmin) redirect("/no-access?reason=action_denied");
  return <PlatformOps />;
}
