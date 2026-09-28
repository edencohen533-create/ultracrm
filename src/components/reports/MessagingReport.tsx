import { getOverviewStats } from "@/server/services/analytics-service";
import { StatTile } from "@/components/analytics/stat-tile";
import { AgentBarList } from "@/components/analytics/agent-bar-list";
import { EmptyState } from "@/components/shared/empty-state";
import { serverT } from "@/lib/i18n-server";

export type MessagingStats = Awaited<ReturnType<typeof getOverviewStats>>;

/** Runs inside the business context (analytics-service uses tenant-strict models). */
export function loadMessagingStats(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return getOverviewStats({ from, to });
}

/** Messaging (WhatsApp/SMS/email) analytics for a period – shared by /analytics and /reports. */
export async function MessagingReport({ days, stats, basePath = "/analytics" }: { days: number; stats: MessagingStats; basePath?: string }) {
  const t = await serverT();
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">{t("אנליטיקה", "Analytics")}</h1>
        <div className="mb-2 flex gap-2 text-sm">{[7, 30, 90].map((d) => <a key={d} href={`${basePath}${basePath.includes("?") ? "&" : "?"}days=${d}`} className={`rounded-full border px-3 py-1 ${days === d ? "bg-primary text-primary-foreground" : ""}`}>{t(`${d} ימים`, `${d} days`)}</a>)}</div>
        <p className="text-sm text-muted-foreground">{t(`שיחות שנוצרו ב־${days} הימים האחרונים. שיוך לנציג לפי האחראי הנוכחי. הודעות היום: שתי הכיוונים מאז חצות UTC. ממוצע תגובה: רק שיחות עם הודעה נכנסת ומענה שנשלח אחריה (${stats.firstResponseCount} שיחות). זמן טיפול אינו זמין עד לתיעוד אירועי סגירה אמינים.`, `Conversations created in the last ${days} days. Agent attribution is by current assignee. Messages today: both directions since midnight UTC. Average response: only conversations with an inbound message and a reply sent after it (${stats.firstResponseCount} conversations). Resolution time is unavailable until reliable close events are recorded.`)}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label={t("שיחות פתוחות", "Open conversations")} value={stats.openConversations} />
        <StatTile label={t("הודעות היום", "Messages today")} value={stats.messagesToday} />
        <StatTile
          label={t("זמן תגובה ראשוני ממוצע", "Avg. first response time")}
          value={stats.avgFirstResponseMinutes !== null ? t(`${stats.avgFirstResponseMinutes} דק'`, `${stats.avgFirstResponseMinutes} min`) : "—"}
        />
        <StatTile
          label={t("זמן טיפול ממוצע", "Avg. resolution time")}
          value={stats.avgResolutionHours !== null ? t(`${stats.avgResolutionHours} שעות`, `${stats.avgResolutionHours} hours`) : "—"}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t(`הודעות יוצאות לפי מספר / ערוץ (${days} ימים) – סטטוסים לפי דיווח הספק`, `Outbound messages by number / channel (${days} days) – statuses as reported by the provider`)}</h2>
        {stats.perNumber.length === 0 ? <EmptyState title={t("אין הודעות יוצאות בטווח", "No outbound messages in range")} /> : (
          <div className="overflow-auto rounded-md border"><table className="w-full text-sm"><thead><tr className="text-muted-foreground"><th className="p-2 text-start">{t("מספר / שולח", "Number / sender")}</th><th className="p-2 text-start">{t("ערוץ", "Channel")}</th><th className="p-2 text-start">{t("נשלחו", "Sent")}</th><th className="p-2 text-start">{t("נמסרו", "Delivered")}</th><th className="p-2 text-start">{t("נקראו", "Read")}</th><th className="p-2 text-start">{t("נכשלו", "Failed")}</th><th className="p-2 text-start">{t("לא ודאי", "Uncertain")}</th></tr></thead>
            <tbody>{stats.perNumber.map((n) => <tr key={n.id} className="border-t"><td className="p-2">{n.label}{!n.isActive && <span className="ms-1 text-xs text-amber-700">{t("(מנותק)", "(disconnected)")}</span>}</td><td className="p-2">{n.channel}</td><td className="p-2">{n.sent}</td><td className="p-2">{n.delivered}</td><td className="p-2">{n.read}</td><td className="p-2">{n.failed}</td><td className="p-2">{n.unknown}</td></tr>)}</tbody></table></div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">{t("שיחות לפי נציג", "Conversations by agent")}</h2>
        {stats.perAgent.length === 0 ? (
          <EmptyState title={t("אין נתונים להצגה", "No data to show")} />
        ) : (
          <AgentBarList data={stats.perAgent} />
        )}
      </div>
    </div>
  );
}
