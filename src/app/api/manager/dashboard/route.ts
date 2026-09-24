import { businessDayStart } from "@/lib/business-day";
import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { agentMetrics, operationalAlerts } from "@/lib/stats";
import { getBusinessSettings } from "@/lib/settings";
import { listQueueStats } from "@/lib/dialer/queue";
import { reapStaleSessions } from "@/lib/dialer/session";
import { telephonyStatus } from "@/lib/telephony";

export const dynamic = "force-dynamic";

const q = z.object({ from: z.string().optional(), to: z.string().optional(), listId: z.string().optional(), userId: z.string().optional() });

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, q);
  await reapStaleSessions(user.businessId).catch(() => 0);
  const visible = await visibleUserIds(user);
  let userIds = visible;
  if (f.userId) userIds = visible && !visible.includes(f.userId) ? ["__none__"] : [f.userId];

  const settings = await getBusinessSettings(user.businessId);
  const startOfToday = businessDayStart(settings.timezone);
  const from = f.from ? new Date(f.from) : startOfToday;
  const to = f.to ? new Date(f.to) : undefined;

  const [agents, metrics, liveCalls, lists, alerts] = await Promise.all([
    prisma.user.findMany({
      where: { businessId: user.businessId, isActive: true, ...(visible ? { id: { in: visible } } : {}) },
      select: { id: true, fullName: true, role: true, presence: true, presenceAt: true, lastSeenAt: true, team: { select: { id: true, name: true } } },
      orderBy: { fullName: "asc" },
    }),
    agentMetrics({ businessId: user.businessId, userIds, from, to, listId: f.listId }),
    prisma.call.findMany({
      where: { businessId: user.businessId, endedAt: null, ...(visible ? { userId: { in: visible } } : {}) },
      select: { id: true, userId: true, status: true, direction: true, toE164: true, createdAt: true, answeredAt: true, contact: { select: { fullName: true } }, list: { select: { name: true } } },
    }),
    prisma.dialList.findMany({ where: { businessId: user.businessId, archivedAt: null }, select: { id: true, name: true, isActive: true, isPaused: true }, orderBy: { name: "asc" } }),
    operationalAlerts(user.businessId, visible),
  ]);
  const queues = await Promise.all(lists.filter((l) => l.isActive).map(async (l) => ({ ...l, stats: await listQueueStats(l.id) })));
  const sessions = await prisma.dialerSession.findMany({
    where: { businessId: user.businessId, status: { in: ["active", "paused"] }, userId: { in: agents.map((a) => a.id) } },
    select: { userId: true, mode: true, status: true, startedAt: true, dialsCount: true, list: { select: { id: true, name: true } } },
  });
  const sessionByUser = Object.fromEntries(sessions.map((s) => [s.userId, s]));
  const liveByUser = Object.fromEntries(liveCalls.map((c) => [c.userId, c]));
  return ok({
    now: new Date().toISOString(),
    range: { from: from.toISOString(), to: to?.toISOString() ?? null },
    agents: agents.map((a) => {
      const lc = liveByUser[a.id] ?? null;
      // "ringing" is derived: a live call that has not been answered yet.
      const displayPresence = lc && !lc.answeredAt ? "ringing" : a.presence;
      return { ...a, displayPresence, session: sessionByUser[a.id] ?? null, liveCall: lc, metrics: metrics.perUser[a.id] ?? null };
    }),
    totals: metrics.totals,
    byList: metrics.byList,
    bySource: metrics.bySource,
    lists,
    queues,
    alerts: alerts.alerts,
    overdueTasks: alerts.overdueTasks,
    dialingPaused: settings.dialingPaused,
    telephony: telephonyStatus(),
    definitions: {
      dials: "שיחות שנוצרו בטווח (כולל כשלונות)",
      connected: "שיחות שבהן הספק אישר שהלקוח ענה",
      connectRate: "נענו ÷ ניסיונות",
      avgTalkSeconds: "סך זמן שיחה (ממענה עד ניתוק) ÷ שיחות שנענו",
      sales: "תוצאות 'בוצעה מכירה' שנשמרו על ידי הנציג",
      uniqueContacts: "אנשי קשר שונים שנוצר איתם קשר (שיחות שנענו)",
      avgRingSeconds: "זמן צלצול ממוצע: מתחילת הצלצול עד מענה או ניתוק",
      avgWrapUpSeconds: "זמן תיעוד ממוצע: מסיום השיחה עד שמירת התוצאה",
      avgGapSeconds: "זמן ממוצע בין שמירת תוצאה לחיוג הבא באותו סשן",
      callbackAdherence: "משימות חזרה שבוצעו עד 15 דק׳ אחרי המועד ÷ משימות שהגיע מועדן",
      inboundMissed: "שיחות נכנסות שלא נענו על ידי נציג",
    },
  });
}, { minRole: "manager" });
