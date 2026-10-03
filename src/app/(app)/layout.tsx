import { redirect } from "next/navigation";
import { getValidSession, membershipsForAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEntitlements } from "@/lib/modules";
import { effectiveAccess } from "@/lib/access/engine";
import { DialerProvider } from "@/components/telephony/DialerProvider";
import { CallBar } from "@/components/telephony/CallBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { AccessGate } from "@/components/layout/AccessGate";
import { HotLeadsBanner } from "@/components/telephony/HotLeadsBanner";
import { OpsAgentRequests } from "@/components/ai/OpsAgentRequests";
import { SupportBanner } from "@/components/platform/SupportBanner";

export const dynamic = "force-dynamic";

/**
 * Shared shell for every module: the vertical side menu (five destinations), the call bar and the page.
 * The DialerProvider lives here, so navigating
 * between CRM, inbox and dialer screens never drops the telephony connection
 * or an active call.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getValidSession();
  if (!session) redirect("/login");
  const [business, memberships, entitlements, access, account] = await Promise.all([
    db.business.findUnique({ where: { id: session.businessId }, select: { name: true } }),
    membershipsForAccount(session.accountId),
    getEntitlements(session.businessId),
    effectiveAccess(session.businessId, session.id),
    db.account.findUnique({ where: { id: session.accountId }, select: { isPlatformAdmin: true } }),
  ]);
  // Dialer UI only for users who may use the dialer (package ∩ user permission).
  const dialer = access.modules.telephony.state === "active" && access.modules.telephony.actions.includes("use");
  return (
    <DialerProvider enabled={dialer}>
      <div className="flex min-h-screen">
        <Sidebar
          user={{ fullName: session.fullName, role: session.role }}
          businessName={business?.name ?? "Solina CRM"}
          businesses={session.support ? [] : memberships.map((m) => ({ id: m.business.id, name: m.business.name, active: m.businessId === session.businessId }))}
          modules={entitlements.modules}
          access={access.modules}
          platformAdmin={Boolean(account?.isPlatformAdmin) && !session.support}
          planName={entitlements.planName}
        />
        <div className="app-main-col flex-1 min-w-0 flex flex-col">
          {session.support && <SupportBanner businessName={session.support.businessName} expiresAt={session.support.expiresAt} />}
          {dialer && <CallBar />}
          {dialer && <HotLeadsBanner />}
          {access.modules.crm.state === "active" && access.modules.crm.actions.includes("view") && <OpsAgentRequests />}
          <main className="flex-1 min-w-0 min-h-0"><AccessGate access={access.modules}>{children}</AccessGate></main>
        </div>
      </div>
    </DialerProvider>
  );
}
