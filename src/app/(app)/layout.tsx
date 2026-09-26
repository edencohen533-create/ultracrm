import { redirect } from "next/navigation";
import { getValidSession, membershipsForAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEntitlements } from "@/lib/modules";
import { DialerProvider } from "@/components/telephony/DialerProvider";
import { CallBar } from "@/components/telephony/CallBar";
import { TopNav } from "@/components/layout/TopNav";

export const dynamic = "force-dynamic";

/**
 * Shared shell for every module: a compact top navigation (five destinations), the call bar and the page.
 * The DialerProvider lives here, so navigating
 * between CRM, inbox and dialer screens never drops the telephony connection
 * or an active call.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getValidSession();
  if (!session) redirect("/login");
  const [business, memberships, entitlements] = await Promise.all([
    db.business.findUnique({ where: { id: session.businessId }, select: { name: true } }),
    membershipsForAccount(session.accountId),
    getEntitlements(session.businessId),
  ]);
  return (
    <DialerProvider enabled={entitlements.modules.telephony}>
      <div className="app-shell flex flex-col min-h-screen">
        <TopNav
          user={{ fullName: session.fullName, role: session.role }}
          businessName={business?.name ?? "UltraCRM"}
          businesses={memberships.map((m) => ({ id: m.business.id, name: m.business.name, active: m.businessId === session.businessId }))}
          modules={entitlements.modules}
          planName={entitlements.planName}
        />
        {entitlements.modules.telephony && <CallBar />}
        <main className="flex-1 min-w-0 min-h-0">{children}</main>
      </div>
    </DialerProvider>
  );
}
