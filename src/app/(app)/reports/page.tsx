import Link from "next/link";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { OverviewReport } from "@/components/reports/OverviewReport";
import { TelephonyReport } from "@/components/reports/TelephonyReport";
import { CallsReport } from "@/components/reports/CallsReport";
import { MessagingReport, loadMessagingStats } from "@/components/reports/MessagingReport";
import { withBusiness } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type Tab = "overview" | "telephony" | "calls" | "messaging";

/**
 * Managers' reports in one place: business overview (the old dashboard), telephony by period,
 * call history, and messaging analytics. Agents never see this route (sidebar + role check).
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string; days?: string }> }) {
  const session = await getValidSession();
  if (!session) redirect("/login");
  if (session.role === "agent") redirect("/leads");
  const ent = await getEntitlements(session.businessId);
  const { tab: rawTab, days: rawDays } = await searchParams;
  const tabs: Array<[Tab, string]> = [["overview", "סקירה"], ...(ent.modules.telephony ? [["telephony", "טלפוניה"] as [Tab, string], ["calls", "היסטוריית שיחות"] as [Tab, string]] : []), ...(ent.modules.messaging ? [["messaging", "דיוור"] as [Tab, string]] : [])];
  const tab: Tab = tabs.some(([t]) => t === rawTab) ? (rawTab as Tab) : "overview";
  const days = [7, 30, 90].includes(Number(rawDays)) ? Number(rawDays) : 30;
  // analytics-service reads tenant-strict models → establish the business context for this request.
  const stats = tab === "messaging" ? await withBusiness(session.businessId, () => loadMessagingStats(days), session) : null;
  return (
    <div className="flex flex-col min-h-screen">
      <header className="px-5 pt-5 pb-0 border-b border-line">
        <h1 className="text-lg font-semibold mb-3">דוחות</h1>
        <nav className="flex flex-wrap gap-1 -mb-px" aria-label="סוגי דוחות">
          {tabs.map(([t, label]) => (
            <Link key={t} href={`/reports?tab=${t}`} className={`h-9 px-4 text-sm border-b-2 flex items-center ${tab === t ? "border-accent text-text font-medium" : "border-transparent text-muted hover:text-text"}`} data-testid={`reports-tab-${t}`}>{label}</Link>
          ))}
        </nav>
      </header>
      {tab === "overview" && <OverviewReport />}
      {tab === "telephony" && <TelephonyReport />}
      {tab === "calls" && <CallsReport />}
      {tab === "messaging" && stats && <MessagingReport days={days} stats={stats} basePath="/reports?tab=messaging" />}
    </div>
  );
}
