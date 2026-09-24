import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DialerProvider } from "@/components/telephony/DialerProvider";
import { CallBar } from "@/components/telephony/CallBar";
import { Sidebar } from "@/components/layout/Sidebar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies();
  if (!session) redirect("/login");
  const [user, business] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.id }, select: { fullName: true, role: true, isActive: true } }),
    prisma.business.findUnique({ where: { id: session.businessId }, select: { name: true } }),
  ]);
  if (!user || !user.isActive) redirect("/login");
  return (
    <DialerProvider>
      <div className="flex min-h-screen">
        <Sidebar user={{ fullName: user.fullName, role: user.role }} businessName={business?.name ?? "Dialer"} />
        <div className="flex-1 min-w-0 flex flex-col">
          <CallBar />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
    </DialerProvider>
  );
}
