import { businessDayStart } from "@/lib/business-day";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { agentMetrics } from "@/lib/stats";
import { activeMonitorFor } from "@/lib/dialer/monitor";
import { reapStaleSessions } from "@/lib/dialer/session";
import { telephonyStatus } from "@/lib/telephony";
import { getBusinessSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const CONNECTED_WITHIN_MS = 60_000;
const METRICS_TTL_MS = 5_000;
const metricsCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof agentMetrics>> }>();
async function cachedMetrics(key: string, f: Parameters<typeof agentMetrics>[0]) {
  const hit = metricsCache.get(key);
  if (hit && Date.now() - hit.at < METRICS_TTL_MS) return hit.value;
  const value = await agentMetrics(f);
  for (const [k, v] of metricsCache) if (Date.now() - v.at >= METRICS_TTL_MS) metricsCache.delete(k);
  if (metricsCache.size >= 200) metricsCache.delete(metricsCache.keys().next().value!);
  metricsCache.set(key, { at: Date.now(), value });
  return value;
}

export type LiveStatus = "available" | "dialing" | "ringing" | "in_call" | "on_hold" | "wrap_up" | "break" | "idle" | "offline" | "unknown";

/**
 * Live floor snapshot – polled every ~1.5s by the command center.
 * Three separate facts per agent: browser connection, availability (presence) and the provider's call state.
 */
export const GET = withAuth(async ({ user }) => {
  const visible = await visibleUserIds(user);
  if (Math.random() < 0.1) await reapStaleSessions(user.businessId).catch(() => 0);
  const now = new Date();
  const settings = await getBusinessSettings(user.businessId);
  const startOfToday = businessDayStart(settings.timezone, now);

  const [agents, liveCalls, sessions, metrics, monitor, todayFailed] = await Promise.all([
    prisma.user.findMany({
      where: { businessId: user.businessId, isActive: true, role: { in: ["agent", "manager"] }, ...(visible ? { id: { in: visible } } : {}) },
      select: { id: true, fullName: true, role: true, presence: true, presenceAt: true, lastSeenAt: true, team: { select: { id: true, name: true } } },
      orderBy: { fullName: "asc" },
    }),
    prisma.call.findMany({
      where: { businessId: user.businessId, endedAt: null, ...(visible ? { userId: { in: visible } } : {}) },
      select: { id: true, userId: true, status: true, direction: true, toE164: true, createdAt: true, ringingAt: true, answeredAt: true, conferenceId: true, agentLegId: true, contactId: true, contact: { select: { id: true, fullName: true } }, list: { select: { id: true, name: true } }, lastEventAt: true, monitors: { where: { endedAt: null }, select: { id: true, managerId: true, mode: true, status: true, manager: { select: { fullName: true } } } } },
    }),
    prisma.dialerSession.findMany({ where: { businessId: user.businessId, status: { in: ["active", "paused"] }, ...(visible ? { userId: { in: visible } } : {}) }, select: { userId: true, mode: true, status: true, lastHeartbeatAt: true, list: { select: { id: true, name: true } } } }),
    cachedMetrics(`${user.businessId}:${startOfToday.toISOString()}:${visible ? visible.join(",") : "*"}`, { businessId: user.businessId, userIds: visible, from: startOfToday }),
    activeMonitorFor(user.id),
    prisma.call.count({ where: { businessId: user.businessId, direction: "outbound", agentLegId: null, status: "failed", createdAt: { gte: startOfToday }, ...(visible ? { userId: { in: visible } } : {}) } }),
  ]);
  const callBy = Object.fromEntries(liveCalls.map((c) => [c.userId, c]));
  const sessBy = Object.fromEntries(sessions.map((s) => [s.userId, s]));

  const rows = agents.map((a) => {
    const call = callBy[a.id] ?? null;
    const sess = sessBy[a.id] ?? null;
    const lastSeen = a.lastSeenAt?.getTime() ?? 0;
    const connected = now.getTime() - lastSeen < CONNECTED_WITHIN_MS;
    let status: LiveStatus = "offline";
    let sinceAt: Date;
    if (call) {
      status = call.status === "answered" ? "in_call" : call.status === "ringing" ? "ringing" : "dialing";
      sinceAt = call.answeredAt ?? call.ringingAt ?? call.createdAt;
    } else if (!connected && sess) {
      status = "unknown"; // session says working, browser silent
      sinceAt = sess.lastHeartbeatAt;
    } else if (!connected) {
      status = "offline";
      sinceAt = a.presenceAt;
    } else if (a.presence === "offline") {
      status = "idle"; // browser connected, but not working a session (not available for inbound routing)
      sinceAt = a.lastSeenAt ?? a.presenceAt;
    } else if (a.presence === "wrap_up") {
      status = "wrap_up";
      sinceAt = a.presenceAt;
    } else if (a.presence === "paused") {
      status = "break";
      sinceAt = a.presenceAt;
    } else {
      status = "available";
      sinceAt = a.presenceAt;
    }
    const m = metrics.perUser[a.id];
    return {
      id: a.id,
      fullName: a.fullName,
      role: a.role,
      team: a.team,
      connected,
      lastSeenAt: a.lastSeenAt,
      presence: a.presence,
      status,
      sinceAt,
      session: sess ? { mode: sess.mode, status: sess.status, list: sess.list } : null,
      call: call
        ? { id: call.id, status: call.status, direction: call.direction, toE164: call.toE164, contact: call.contact, list: call.list, createdAt: call.createdAt, ringingAt: call.ringingAt, answeredAt: call.answeredAt, canMonitor: Boolean(call.answeredAt) && (Boolean(call.conferenceId) || telephonyStatus().simulation) && call.userId !== user.id, monitors: call.monitors }
        : null,
      today: m ?? null,
    };
  });

  const counts = { in_call: 0, dialing: 0, available: 0, wrap_up: 0, break: 0, idle: 0, offline: 0, unknown: 0 };
  for (const r of rows) {
    const st = r.status as LiveStatus;
    const k: keyof typeof counts = st === "ringing" || st === "dialing" ? "dialing" : st === "in_call" || st === "on_hold" ? "in_call" : st;
    counts[k]++;
  }

  return ok({
    serverNow: now.toISOString(),
    rows,
    counts,
    today: { ...metrics.totals, failedBeforeProvider: todayFailed },
    monitor,
    dialingPaused: settings.dialingPaused,
    telephony: telephonyStatus(),
    teams: [...new Map(agents.filter((a) => a.team).map((a) => [a.team!.id, a.team!])).values()],
  });
}, { minRole: "manager" });
