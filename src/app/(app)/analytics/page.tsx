import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { getOverviewStats } from "@/server/services/analytics-service";
import { StatTile } from "@/components/analytics/stat-tile";
import { AgentBarList } from "@/components/analytics/agent-bar-list";
import { EmptyState } from "@/components/shared/empty-state";

export default organizationRequest(async function AnalyticsPage() {
  const session = await auth();

  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return <AccessDenied />;
  }

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const stats = await getOverviewStats({ from, to });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">אנליטיקה</h1>
        <p className="text-sm text-muted-foreground">שיחות שנוצרו ב־30 הימים האחרונים. שיוך לנציג לפי האחראי הנוכחי. הודעות היום: שתי הכיוונים מאז חצות UTC. ממוצע תגובה: רק שיחות עם הודעה נכנסת ומענה שנשלח אחריה ({stats.firstResponseCount} שיחות). זמן טיפול אינו זמין עד לתיעוד אירועי סגירה אמינים.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="שיחות פתוחות" value={stats.openConversations} />
        <StatTile label="הודעות היום" value={stats.messagesToday} />
        <StatTile
          label="זמן תגובה ראשוני ממוצע"
          value={stats.avgFirstResponseMinutes !== null ? `${stats.avgFirstResponseMinutes} דק'` : "—"}
        />
        <StatTile
          label="זמן טיפול ממוצע"
          value={stats.avgResolutionHours !== null ? `${stats.avgResolutionHours} שעות` : "—"}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">שיחות לפי נציג</h2>
        {stats.perAgent.length === 0 ? (
          <EmptyState title="אין נתונים להצגה" />
        ) : (
          <AgentBarList data={stats.perAgent} />
        )}
      </div>
    </div>
  );
});
