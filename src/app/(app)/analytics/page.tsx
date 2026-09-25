import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { MessagingReport, loadMessagingStats } from "@/components/reports/MessagingReport";

export default organizationRequest(async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const { days: rawDays } = await searchParams;
  const days = [7, 30, 90].includes(Number(rawDays)) ? Number(rawDays) : 30;
  const stats = await loadMessagingStats(days);
  return <MessagingReport days={days} stats={stats} />;
});
