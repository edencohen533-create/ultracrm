/**
 * "מנהל AI" – agent performance and capacity, computed in code from the data (never by the model).
 *
 *  • handled = distinct contacts the agent really dialed (outbound call with lead_dialed_at) in the period
 *  • answered = those dials that were answered · wins = deals won by the agent (closed in the period)
 *  • closeRate = wins / handled – today vs. the agent's own baseline (previous N days) vs. peers today on leads
 *    from the same sources ("similar leads"); lead age and source mix are reported so an easy batch is visible
 *  • confidence: Wilson lower bound of today's rate (a single deal never makes an agent "hot")
 *  • capacity: untouched leads (new, never dialed), follow-ups due soon, online (dialer heartbeat), in a call
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { businessDayStart } from "@/lib/business-day";
import { getBusinessSettings } from "@/lib/settings";

const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);
const ONLINE_MS = 5 * 60_000;

export interface Rate { handled: number; answered: number; wins: number; rate: number | null }
export interface AgentSnapshot {
  id: string; name: string; role: string;
  today: Rate; baseline: Rate & { days: number }; peers: Rate;
  sources: string[]; avgLeadAgeDays: number | null;
  untouched: number; openLeads: number; followUpsSoon: number; online: boolean; inCall: boolean;
  inPool: boolean; capOk: boolean;
}

const rate = (handled: number, answered: number, wins: number): Rate => ({ handled, answered, wins, rate: handled > 0 ? wins / handled : null });

/** Wilson score lower bound for a proportion (z from the confidence level, one-sided). */
export function wilsonLower(wins: number, n: number, confidence: number) {
  if (n <= 0) return 0;
  const z = ({ 0.8: 0.8416, 0.85: 1.0364, 0.9: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 } as Record<number, number>)[confidence] ?? 1.2816;
  const p = wins / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
}

export async function agentSnapshots(businessId: string, opts: { now?: Date; baselineDays?: number } = {}): Promise<{ dayStart: Date; agents: AgentSnapshot[] }> {
  const now = opts.now ?? new Date();
  const settings = await getBusinessSettings(businessId);
  const dayStart = businessDayStart(settings.timezone, now);
  const days = opts.baselineDays ?? 30;
  const from = new Date(dayStart.getTime() - days * 86400_000);
  const users = await prisma.user.findMany({ where: { businessId, isActive: true, role: { in: ["agent", "manager"] } }, orderBy: { createdAt: "asc" }, select: { id: true, fullName: true, role: true } });
  if (!users.length) return { dayStart, agents: [] };
  const ids = users.map((u) => u.id);

  // Handled (distinct contacts per day) + answered, today and baseline, per agent.
  const dials = await prisma.$queryRaw<Array<{ uid: string; today: boolean; handled: number; answered: number }>>(Prisma.sql`
    SELECT user_id AS uid, (created_at >= ${dayStart}) AS today,
           count(DISTINCT (contact_id, date_trunc('day', created_at)))::int AS handled, count(answered_at)::int AS answered
    FROM ${T("calls")}
    WHERE business_id = ${businessId} AND user_id = ANY(${ids}) AND direction = 'outbound' AND lead_dialed_at IS NOT NULL
      AND contact_id IS NOT NULL AND created_at >= ${from} AND created_at <= ${now}
    GROUP BY 1, 2`);
  const wins = await prisma.$queryRaw<Array<{ uid: string; today: boolean; n: number }>>(Prisma.sql`
    SELECT owner_user_id AS uid, (closed_at >= ${dayStart}) AS today, count(*)::int AS n
    FROM ${T("deals")} WHERE business_id = ${businessId} AND status = 'won' AND owner_user_id = ANY(${ids}) AND closed_at >= ${from} AND closed_at <= ${now}
    GROUP BY 1, 2`);
  // Today's handled leads: source + age (for "similar leads" and to expose an unusually fresh batch).
  const handledToday = await prisma.$queryRaw<Array<{ uid: string; contact_id: string; source: string | null; age_days: number | null; won: boolean }>>(Prisma.sql`
    SELECT DISTINCT ON (c.user_id, c.contact_id) c.user_id AS uid, c.contact_id, l.source,
           EXTRACT(EPOCH FROM (c.created_at - l.created_at)) / 86400.0 AS age_days,
           EXISTS (SELECT 1 FROM ${T("deals")} d WHERE d.business_id = c.business_id AND d.contact_id = c.contact_id AND d.status = 'won' AND d.closed_at >= ${dayStart}) AS won
    FROM ${T("calls")} c
    LEFT JOIN LATERAL (SELECT source, created_at FROM ${T("leads")} WHERE business_id = c.business_id AND contact_id = c.contact_id ORDER BY created_at DESC LIMIT 1) l ON true
    WHERE c.business_id = ${businessId} AND c.user_id = ANY(${ids}) AND c.direction = 'outbound' AND c.lead_dialed_at IS NOT NULL AND c.created_at >= ${dayStart}
    ORDER BY c.user_id, c.contact_id, c.created_at ASC`);
  const untouched = await prisma.$queryRaw<Array<{ uid: string; n: number; open: number }>>(Prisma.sql`
    SELECT l.owner_user_id AS uid,
           count(*) FILTER (WHERE l.status = 'new' AND NOT EXISTS (SELECT 1 FROM ${T("calls")} c WHERE c.business_id = l.business_id AND c.contact_id = l.contact_id AND c.direction = 'outbound' AND c.lead_dialed_at IS NOT NULL AND (l.reopened_at IS NULL OR c.created_at >= l.reopened_at)))::int AS n,
           count(*) FILTER (WHERE l.status IN ('new', 'contacted', 'qualified'))::int AS open
    FROM ${T("leads")} l WHERE l.business_id = ${businessId} AND l.owner_user_id = ANY(${ids}) GROUP BY 1`);
  const soon = await prisma.task.groupBy({ by: ["userId"], where: { businessId, userId: { in: ids }, status: "open", type: "callback", dueAt: { lte: new Date(now.getTime() + 2 * 3600_000) } }, _count: { _all: true } });
  const sessions = await prisma.dialerSession.findMany({ where: { businessId, userId: { in: ids }, status: "active", lastHeartbeatAt: { gte: new Date(now.getTime() - ONLINE_MS) } }, select: { userId: true } });
  const live = await prisma.call.findMany({ where: { businessId, userId: { in: ids }, endedAt: null, createdAt: { gte: new Date(now.getTime() - 2 * 3600_000) } }, select: { userId: true } });

  const policy = settings.leadAssignment;
  const capOf = (id: string) => (policy.perAgentMax ?? {})[id] ?? policy.maxOpenLeadsPerAgent;
  const agents: AgentSnapshot[] = users.map((u) => {
    const d = (t: boolean) => dials.find((x) => x.uid === u.id && x.today === t);
    const w = (t: boolean) => wins.find((x) => x.uid === u.id && x.today === t)?.n ?? 0;
    const mine = handledToday.filter((h) => h.uid === u.id);
    const sources = [...new Set(mine.map((h) => h.source ?? "ללא מקור"))];
    // Peers today on leads of the same sources (all sources when the agent has none yet).
    const peerRows = handledToday.filter((h) => h.uid !== u.id && (!sources.length || sources.includes(h.source ?? "ללא מקור")));
    const ages = mine.map((h) => Number(h.age_days)).filter((x) => Number.isFinite(x));
    const un = untouched.find((x) => x.uid === u.id);
    const cap = capOf(u.id);
    return {
      id: u.id, name: u.fullName, role: u.role,
      today: rate(d(true)?.handled ?? 0, d(true)?.answered ?? 0, w(true)),
      baseline: { ...rate(d(false)?.handled ?? 0, d(false)?.answered ?? 0, w(false)), days },
      peers: rate(peerRows.length, 0, peerRows.filter((h) => h.won).length),
      sources, avgLeadAgeDays: ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : null,
      untouched: un?.n ?? 0, openLeads: un?.open ?? 0,
      followUpsSoon: soon.find((x) => x.userId === u.id)?._count._all ?? 0,
      online: sessions.some((s) => s.userId === u.id), inCall: live.some((c) => c.userId === u.id),
      inPool: !policy.agentIds.length || policy.agentIds.includes(u.id),
      capOk: !cap || (un?.open ?? 0) < cap,
    };
  });
  return { dayStart, agents };
}

// ─── capacity: can the agent handle N more leads before the end of the shift? ────────────────────────────────────
export interface Capacity {
  known: boolean; reason: string | null;
  shift: { start: string; end: string } | null; shiftEnd: Date | null; remainingMinutes: number;
  pacePerHour: number | null; paceBasis: string | null;
  untouched: number; followUpsBeforeEnd: number; load: number; capacityLeads: number; spare: number;
}

/**
 * Remaining shift minutes × handling pace (first dials per hour: today when there is enough of it, otherwise the
 * agent's own average over active days) − what is already on the agent's plate (untouched leads + follow-ups due
 * before the shift ends). Unknown shift or pace → `known: false` (the agent is NOT assumed free).
 */
export async function agentCapacity(businessId: string, agent: AgentSnapshot, now = new Date()): Promise<Capacity> {
  const settings = await getBusinessSettings(businessId);
  const tz = settings.timezone;
  const shift = settings.aiOps.shifts[agent.id] ?? null;
  const base: Capacity = { known: false, reason: null, shift: shift ? { start: shift.start, end: shift.end } : null, shiftEnd: null, remainingMinutes: 0, pacePerHour: null, paceBasis: null, untouched: agent.untouched, followUpsBeforeEnd: 0, load: 0, capacityLeads: 0, spare: 0 };
  if (!shift) return { ...base, reason: "שעות העבודה של הנציג לא הוגדרו – לא מניחים שהוא פנוי" };
  const { zonedParts, zonedDateTime } = await import("@/lib/business-day");
  const p = zonedParts(tz, now);
  const weekday = new Date(`${p.date}T12:00:00Z`).getUTCDay();
  if (!shift.days.includes(weekday)) return { ...base, known: true, reason: "הנציג לא במשמרת היום" };
  const start = zonedDateTime(tz, p.date, shift.start)!; const end = zonedDateTime(tz, p.date, shift.end)!;
  if (now >= end) return { ...base, known: true, shiftEnd: end, reason: `המשמרת הסתיימה (${shift.end})` };
  const remainingMinutes = Math.round((end.getTime() - Math.max(now.getTime(), start.getTime())) / 60_000);

  // Pace: today (≥ 5 first dials and ≥ 1 hour worked), otherwise the agent's own average per active shift hour.
  let pacePerHour: number | null = null; let paceBasis: string | null = null;
  const first = await prisma.call.findFirst({ where: { businessId, userId: agent.id, direction: "outbound", leadDialedAt: { not: null }, createdAt: { gte: start } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const workedH = first ? (now.getTime() - first.createdAt.getTime()) / 3600_000 : 0;
  if (agent.today.handled >= 5 && workedH >= 1) { pacePerHour = agent.today.handled / workedH; paceBasis = `היום: ${agent.today.handled} לידים ב-${workedH.toFixed(1)} שעות`; }
  else {
    const activeDays = (await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT count(DISTINCT date_trunc('day', created_at))::int AS n FROM ${T("calls")} WHERE business_id = ${businessId} AND user_id = ${agent.id} AND direction = 'outbound' AND lead_dialed_at IS NOT NULL AND created_at >= ${new Date(now.getTime() - agent.baseline.days * 86400_000)} AND created_at < ${start}`))[0]?.n ?? 0;
    const [sh, sm] = shift.start.split(":").map(Number); const [eh, em] = shift.end.split(":").map(Number);
    const shiftH = Math.max(1, (eh * 60 + em - sh * 60 - sm) / 60);
    if (activeDays >= 3 && agent.baseline.handled >= 10) { pacePerHour = agent.baseline.handled / (activeDays * shiftH); paceBasis = `ממוצע אישי: ${agent.baseline.handled} לידים ב-${activeDays} ימי עבודה`; }
  }
  const followUpsBeforeEnd = await prisma.task.count({ where: { businessId, userId: agent.id, status: "open", type: "callback", dueAt: { lte: end } } });
  const load = agent.untouched + followUpsBeforeEnd;
  if (pacePerHour === null) return { ...base, shiftEnd: end, remainingMinutes, followUpsBeforeEnd, load, reason: "אין מספיק נתונים על קצב הטיפול של הנציג" };
  const capacityLeads = Math.floor((remainingMinutes / 60) * pacePerHour);
  return { ...base, known: true, shiftEnd: end, remainingMinutes, pacePerHour: Math.round(pacePerHour * 10) / 10, paceBasis, followUpsBeforeEnd, load, capacityLeads, spare: Math.max(0, capacityLeads - load) };
}
