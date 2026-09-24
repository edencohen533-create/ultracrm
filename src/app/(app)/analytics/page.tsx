import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { getOverviewStats } from "@/server/services/analytics-service";
import { StatTile } from "@/components/analytics/stat-tile";
import { AgentBarList } from "@/components/analytics/agent-bar-list";
import { EmptyState } from "@/components/shared/empty-state";

export default organizationRequest(async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const session = await auth();

  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return <AccessDenied />;
  }

  const { days: rawDays } = await searchParams;
  const days = [7, 30, 90].includes(Number(rawDays)) ? Number(rawDays) : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const stats = await getOverviewStats({ from, to });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">אנליטיקה</h1>
        <div className="mb-2 flex gap-2 text-sm">{[7, 30, 90].map((d) => <a key={d} href={`/analytics?days=${d}`} className={`rounded-full border px-3 py-1 ${days === d ? "bg-primary text-primary-foreground" : ""}`}>{d} ימים</a>)}</div>
        <p className="text-sm text-muted-foreground">שיחות שנוצרו ב־{days} הימים האחרונים. שיוך לנציג לפי האחראי הנוכחי. הודעות היום: שתי הכיוונים מאז חצות UTC. ממוצע תגובה: רק שיחות עם הודעה נכנסת ומענה שנשלח אחריה ({stats.firstResponseCount} שיחות). זמן טיפול אינו זמין עד לתיעוד אירועי סגירה אמינים.</p>
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
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">הודעות יוצאות לפי מספר / ערוץ ({days} ימים) – סטטוסים לפי דיווח הספק</h2>
        {stats.perNumber.length === 0 ? <EmptyState title="אין הודעות יוצאות בטווח" /> : (
          <div className="overflow-auto rounded-md border"><table className="w-full text-sm"><thead><tr className="text-muted-foreground"><th className="p-2 text-start">מספר / שולח</th><th className="p-2 text-start">ערוץ</th><th className="p-2 text-start">נשלחו</th><th className="p-2 text-start">נמסרו</th><th className="p-2 text-start">נקראו</th><th className="p-2 text-start">נכשלו</th><th className="p-2 text-start">לא ודאי</th></tr></thead>
            <tbody>{stats.perNumber.map((n) => <tr key={n.id} className="border-t"><td className="p-2">{n.label}{!n.isActive && <span className="ms-1 text-xs text-amber-700">(מנותק)</span>}</td><td className="p-2">{n.channel}</td><td className="p-2">{n.sent}</td><td className="p-2">{n.delivered}</td><td className="p-2">{n.read}</td><td className="p-2">{n.failed}</td><td className="p-2">{n.unknown}</td></tr>)}</tbody></table></div>
        )}
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
