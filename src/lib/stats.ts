/**
 * Manager metrics. Every metric has an explicit numerator/denominator:
 *  - dials:            calls created in range (outbound + inbound), any status
 *  - connected:        calls where the provider confirmed the other party answered (answeredAt != null)
 *  - uniqueContacts:   distinct contactId among connected calls
 *  - connectRate:      connected / dials
 *  - talkSeconds:      Σ talkSeconds (answeredAt → endedAt) over connected calls
 *  - avgTalkSeconds:   talkSeconds / connected
 *  - avgRingSeconds:   Σ (answeredAt|endedAt − ringingAt) / calls that rang
 *  - avgWrapUpSeconds: Σ (outcomeSavedAt − endedAt) / calls with an agent-saved outcome
 *  - avgGapSeconds:    Σ (createdAt − previous call's outcomeSavedAt in the same session) / such pairs
 *  - outcomes:         count per saved business outcome
 *  - sales:            outcomes.sale;  callbacks: outcomes.callback
 *  - callbackAdherence: callback tasks completed on or before dueAt / callback tasks due in range
 *  - inboundMissed:    inbound calls with no agent answer
 * Revenue and telephony cost are NOT computed – there is no authoritative source in this system.
 */
import { prisma } from "@/lib/db";
import type { OutcomeKey } from "@/generated/prisma/enums";

export interface StatsFilter {
  businessId: string;
  userIds: string[] | null; // null = all
  from?: Date;
  to?: Date;
  listId?: string;
}

interface Bucket {
  dials: number;
  /** Outbound attempts the provider actually created (agent leg id present). */
  outboundAttempts: number;
  outboundAnswered: number;
  dialSeconds: number;
  connected: number;
  contactIds: Set<string>;
  talkSeconds: number;
  ringSeconds: number;
  rang: number;
  wrapSeconds: number;
  wrapped: number;
  gapSeconds: number;
  gaps: number;
  inbound: number;
  inboundMissed: number;
  outcomes: Partial<Record<OutcomeKey, number>>;
}
const empty = (): Bucket => ({ dials: 0, outboundAttempts: 0, outboundAnswered: 0, dialSeconds: 0, connected: 0, contactIds: new Set(), talkSeconds: 0, ringSeconds: 0, rang: 0, wrapSeconds: 0, wrapped: 0, gapSeconds: 0, gaps: 0, inbound: 0, inboundMissed: 0, outcomes: {} });

function finish(b: Bucket) {
  return {
    dials: b.dials,
    outboundAttempts: b.outboundAttempts,
    outboundAnswered: b.outboundAnswered,
    outboundAnswerRate: b.outboundAttempts ? Math.round((b.outboundAnswered / b.outboundAttempts) * 100) : 0,
    dialSeconds: Math.round(b.dialSeconds),
    connected: b.connected,
    uniqueContacts: b.contactIds.size,
    connectRate: b.dials ? Math.round((b.connected / b.dials) * 100) : 0,
    talkSeconds: b.talkSeconds,
    avgTalkSeconds: b.connected ? Math.round(b.talkSeconds / b.connected) : 0,
    avgRingSeconds: b.rang ? Math.round(b.ringSeconds / b.rang) : 0,
    avgWrapUpSeconds: b.wrapped ? Math.round(b.wrapSeconds / b.wrapped) : 0,
    avgGapSeconds: b.gaps ? Math.round(b.gapSeconds / b.gaps) : 0,
    inbound: b.inbound,
    inboundMissed: b.inboundMissed,
    outcomes: b.outcomes,
    sales: b.outcomes.sale ?? 0,
    callbacks: b.outcomes.callback ?? 0,
  };
}

export async function agentMetrics(f: StatsFilter) {
  const range = f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {};
  const where = { businessId: f.businessId, ...(f.userIds ? { userId: { in: f.userIds } } : {}), ...(f.listId ? { listId: f.listId } : {}), ...range };
  const calls = await prisma.call.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: { userId: true, sessionId: true, listId: true, contactId: true, direction: true, agentLegId: true, createdAt: true, ringingAt: true, answeredAt: true, endedAt: true, talkSeconds: true, outcome: true, outcomeSavedAt: true, outcomeNote: true, contact: { select: { source: true } } },
  });
  const per = new Map<string, Bucket>();
  const byList = new Map<string, Bucket>();
  const bySource = new Map<string, Bucket>();
  const totals = empty();
  const lastWrapBySession = new Map<string, Date>();

  const add = (b: Bucket, c: (typeof calls)[number]) => {
    b.dials++;
    if (c.direction === "outbound" && c.agentLegId) {
      b.outboundAttempts++;
      if (c.answeredAt) b.outboundAnswered++;
      const end = c.answeredAt ?? c.endedAt;
      if (end) b.dialSeconds += Math.max(0, (end.getTime() - c.createdAt.getTime()) / 1000);
    }
    if (c.direction === "inbound") {
      b.inbound++;
      if (!c.answeredAt) b.inboundMissed++;
    }
    if (c.answeredAt) {
      b.connected++;
      if (c.contactId) b.contactIds.add(c.contactId);
      b.talkSeconds += c.talkSeconds ?? 0;
    }
    if (c.ringingAt) {
      const end = c.answeredAt ?? c.endedAt;
      if (end) {
        b.ringSeconds += Math.max(0, (end.getTime() - c.ringingAt.getTime()) / 1000);
        b.rang++;
      }
    }
    // Only agent-saved outcomes count as wrap-up (auto-saved technical failures / missed inbound have no outcome).
    if (c.outcome && c.outcomeSavedAt && c.endedAt) {
      b.wrapSeconds += Math.max(0, (c.outcomeSavedAt.getTime() - c.endedAt.getTime()) / 1000);
      b.wrapped++;
      b.outcomes[c.outcome] = (b.outcomes[c.outcome] ?? 0) + 1;
    }
  };
  for (const c of calls) {
    const a = per.get(c.userId) ?? empty();
    add(a, c);
    add(totals, c);
    per.set(c.userId, a);
    if (c.listId) {
      const l = byList.get(c.listId) ?? empty();
      add(l, c);
      byList.set(c.listId, l);
    }
    const src = c.contact?.source ?? "—";
    const s = bySource.get(src) ?? empty();
    add(s, c);
    bySource.set(src, s);
    // gap between calls within a session
    if (c.sessionId) {
      const prev = lastWrapBySession.get(c.sessionId);
      if (prev) {
        const gap = (c.createdAt.getTime() - prev.getTime()) / 1000;
        if (gap >= 0 && gap < 3600) {
          a.gapSeconds += gap;
          a.gaps++;
          totals.gapSeconds += gap;
          totals.gaps++;
        }
      }
      if (c.outcomeSavedAt) lastWrapBySession.set(c.sessionId, c.outcomeSavedAt);
    }
  }

  // Callback adherence: tasks due in range
  const tasks = await prisma.task.findMany({
    where: { businessId: f.businessId, type: "callback", ...(f.userIds ? { userId: { in: f.userIds } } : {}), ...(f.from || f.to ? { dueAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}) },
    select: { userId: true, dueAt: true, status: true, doneAt: true },
  });
  const adherence = (list: typeof tasks) => {
    const due = list.filter((t) => t.status !== "cancelled");
    const onTime = due.filter((t) => t.status === "done" && t.doneAt && t.doneAt.getTime() <= t.dueAt.getTime() + 15 * 60_000).length;
    return { due: due.length, onTime, overdueOpen: due.filter((t) => t.status === "open" && t.dueAt.getTime() < Date.now()).length, rate: due.length ? Math.round((onTime / due.length) * 100) : null };
  };

  return {
    totals: { ...finish(totals), callbackAdherence: adherence(tasks) },
    perUser: Object.fromEntries([...per.entries()].map(([k, v]) => [k, { ...finish(v), callbackAdherence: adherence(tasks.filter((t) => t.userId === k)) }])),
    byList: Object.fromEntries([...byList.entries()].map(([k, v]) => [k, finish(v)])),
    bySource: Object.fromEntries([...bySource.entries()].map(([k, v]) => [k, finish(v)])),
  };
}

/** Things a supervisor should look at right now. */
export async function operationalAlerts(businessId: string, userIds: string[] | null) {
  const now = Date.now();
  const userFilter = userIds ? { userId: { in: userIds } } : {};
  const [longCalls, longWrap, silentSessions, overdueTasks] = await Promise.all([
    prisma.call.findMany({ where: { businessId, endedAt: null, createdAt: { lt: new Date(now - 2 * 3600_000) }, ...userFilter }, select: { id: true, userId: true, createdAt: true, user: { select: { fullName: true } } } }),
    prisma.call.findMany({ where: { businessId, endedAt: { lt: new Date(now - 10 * 60_000) }, outcomeSavedAt: null, leadId: { not: null }, createdAt: { gt: new Date(now - 6 * 3600_000) }, ...userFilter }, select: { id: true, userId: true, endedAt: true, user: { select: { fullName: true } } } }),
    prisma.dialerSession.findMany({ where: { businessId, status: { in: ["active", "paused"] }, lastHeartbeatAt: { lt: new Date(now - 60_000) }, ...userFilter }, select: { id: true, userId: true, lastHeartbeatAt: true, user: { select: { fullName: true } } } }),
    prisma.task.count({ where: { businessId, status: "open", dueAt: { lt: new Date(now) }, ...userFilter } }),
  ]);
  const alerts: Array<{ kind: string; severity: "warn" | "bad"; text: string; userId?: string }> = [];
  for (const c of longCalls) alerts.push({ kind: "long_call", severity: "warn", userId: c.userId, text: `${c.user.fullName}: שיחה פעילה מעל שעתיים (ייתכן מצב תקוע)` });
  for (const c of longWrap) alerts.push({ kind: "wrapup_stuck", severity: "warn", userId: c.userId, text: `${c.user.fullName}: שיחה שהסתיימה לפני יותר מ-10 דק׳ ללא תיעוד` });
  for (const s of silentSessions) alerts.push({ kind: "session_silent", severity: "bad", userId: s.userId, text: `${s.user.fullName}: הסשן לא שלח heartbeat כבר ${Math.round((now - s.lastHeartbeatAt.getTime()) / 1000)} שנ׳ (לשונית נסגרה?)` });
  if (overdueTasks > 0) alerts.push({ kind: "overdue_callbacks", severity: overdueTasks > 5 ? "bad" : "warn", text: `${overdueTasks} משימות חזרה באיחור` });
  return { alerts, overdueTasks };
}
