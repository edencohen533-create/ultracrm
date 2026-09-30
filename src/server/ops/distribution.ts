/**
 * Distribution rules (owner) – evaluation, today's state, and a dry-run preview.
 *
 *  • A rule is a structured OpsRule ("performance_bonus"), saved as a DRAFT until the business owner approves it.
 *    Evaluation is code (numbers from metrics.ts), never the model.
 *  • When the condition holds (with the minimum sample) the rule creates ONE request per agent per business day
 *    (unique dedupe key → the check running again while the condition stays true does nothing). The request goes
 *    through the existing approval flow: manager approval per the approval policy, then the agent's confirmation per
 *    the extra-leads policy, capacity / permissions / campaign re-checked, then an "extra" allocation that ends after
 *    N leads or at the end of the day.
 *  • Conflicts: rules are evaluated strongest priority first; an agent with an open request or an active allocation
 *    is skipped (reason recorded), so two rules never stack on the same agent the same day.
 *  • Preview: the same pure decision as the real assignment (src/lib/crm/distribution.ts) over N imaginary leads –
 *    nothing is written.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getBusinessSettings } from "@/lib/settings";
import { zonedParts, zonedDateTime } from "@/lib/business-day";
import { decide, SKIP_LABEL, type DistAgent, type DistOverride, type DistPolicy } from "@/lib/crm/distribution";
import { agentSnapshots, agentCapacity, type AgentSnapshot } from "./metrics";
import { parseConfig, requiresManager, describeRule, type RuleConfig, type Autonomy } from "./rules";

type Bonus = RuleConfig<"performance_bonus">;
const OPEN = ["pending_manager", "pending_agent", "executing", "active", "needs_adjustment"];
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 1000) / 10}%`);

/** Business-local day key and the end of that day (the bonus never outlives it). */
async function dayOf(businessId: string, now: Date) {
  const tz = (await getBusinessSettings(businessId)).timezone;
  const d = zonedParts(tz, now).date;
  const next = new Date(`${d}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { tz, day: d, end: zonedDateTime(tz, next.toISOString().slice(0, 10), "00:00")! };
}

/** Is the rule's condition true for this agent now? (sample first – a small sample never counts.) */
export function bonusCondition(c: Bonus, a: AgentSnapshot | undefined) {
  if (!a) return { state: "agent_unavailable" as const, text: "הנציג אינו פעיל או אינו בחלוקה" };
  if (a.today.handled < c.minHandled) return { state: "insufficient_sample" as const, text: `מדגם לא מספיק: ${a.today.handled} לידים טופלו היום (נדרש ${c.minHandled})`, rate: a.today.rate, handled: a.today.handled, wins: a.today.wins };
  const rate = a.today.rate ?? 0;
  if (rate > c.threshold) return { state: "met" as const, text: `התנאי מתקיים: ${a.today.wins} סגירות מתוך ${a.today.handled} לידים = ${pct(rate)} (סף ${pct(c.threshold)})`, rate, handled: a.today.handled, wins: a.today.wins };
  return { state: "not_met" as const, text: `התנאי לא מתקיים: ${a.today.wins} מתוך ${a.today.handled} = ${pct(rate)} (סף ${pct(c.threshold)})`, rate, handled: a.today.handled, wins: a.today.wins };
}

/** Cron (every 2 minutes, from runOpsTick): active distribution rules → at most one request per agent per day. */
export async function evaluateDistributionRules(businessId: string, now = new Date()) {
  const rules = await prisma.opsRule.findMany({ where: { businessId, kind: "performance_bonus", status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
  if (!rules.length) return { created: 0, results: [] as Array<Record<string, unknown>> };
  const { day, end, tz } = await dayOf(businessId, now);
  const { agents } = await agentSnapshots(businessId, { now });
  const results: Array<Record<string, unknown>> = [];
  let created = 0;
  const { managerDecision, notifyManagers } = await import("./engine");
  for (const rule of rules) {
    let c: Bonus; try { c = parseConfig("performance_bonus", rule.config); } catch { results.push({ ruleId: rule.id, state: "invalid" }); continue; }
    const snap = agents.find((a) => a.id === c.agentId && a.inPool);
    const cond = bonusCondition(c, snap);
    if (cond.state !== "met") { results.push({ ruleId: rule.id, state: cond.state, text: cond.text }); continue; }
    // Already given today (by this or another rule) → nothing (the condition may stay true all day).
    if (await prisma.opsRecommendation.findFirst({ where: { businessId, dedupeKey: `bonus:${c.agentId}:${day}` }, select: { id: true } })) { results.push({ ruleId: rule.id, state: "done_today" }); continue; }
    // Conflict: another request / allocation for this agent is open → skip (a stronger rule was first).
    const busy = await prisma.opsRecommendation.findFirst({ where: { businessId, agentId: c.agentId, status: { in: OPEN } }, select: { id: true, kind: true } })
      ?? await prisma.assignmentOverride.findFirst({ where: { businessId, agentId: c.agentId, status: "active", expiresAt: { gt: now } }, select: { id: true } });
    if (busy) { results.push({ ruleId: rule.id, state: "conflict", text: "לנציג כבר בקשה או הקצאה פתוחה – הכלל ימתין" }); continue; }
    const cap = await agentCapacity(businessId, snap!, now);
    if (!cap.known || cap.spare < 1) {
      const reason = cap.reason ?? `אין קיבולת פנויה (קיבולת ${cap.capacityLeads}, עומס ${cap.load})`;
      // Information once a day; the bonus itself can still happen later today if capacity frees up.
      await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: "performance_bonus", agentId: c.agentId, status: "insight", code: String(1000 + Math.floor(Math.random() * 9000)), title: `${snap!.name}: ${cond.text}`, explanation: `לא הוקצתה תוספת: ${reason}.`, evidence: { cond, capacity: cap } as object, proposal: {}, dedupeKey: `bonus-insight:${rule.id}:${day}`, expiresAt: end } }).catch((e) => { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; });
      results.push({ ruleId: rule.id, state: "no_capacity", text: reason });
      continue;
    }
    const count = Math.min(c.bonusCount, cap.spare);
    const until = cap.shiftEnd && cap.shiftEnd < end ? cap.shiftEnd : end;
    const proposal = { mode: "extra", count, sharePct: 100, source: c.source, listId: c.listId, fromUnassigned: c.fromUnassigned, until: until.toISOString(), ruleId: rule.id };
    let rec;
    try {
      rec = await prisma.opsRecommendation.create({ data: {
        businessId, ruleId: rule.id, kind: "performance_bonus", agentId: c.agentId, status: "pending_manager", code: String(1000 + Math.floor(Math.random() * 9000)),
        title: `${snap!.name}: ${cond.text}`,
        explanation: `לפי הכלל "${rule.name}": תוספת חד-פעמית של ${count} לידים חדשים היום על חשבון החלוקה הרגילה${count < c.bonusCount ? ` (הכלל מגדיר ${c.bonusCount}; לפי הקיבולת פנויים ${cap.spare})` : ""}, עד ${new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(until)}.`,
        evidence: { cond, capacity: cap, ruleId: rule.id } as object, proposal: proposal as object, requestedCount: count,
        dedupeKey: `bonus:${c.agentId}:${day}`, expiresAt: new Date(Math.min(now.getTime() + 2 * 3600_000, until.getTime())),
      } });
    } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") { results.push({ ruleId: rule.id, state: "done_today" }); continue; } throw e; }
    created++;
    await audit(businessId, null, "ai_ops", rec.id, "distribution_rule.fired", { ruleId: rule.id, agentId: c.agentId, cond, count, capacity: { spare: cap.spare } });
    // The owner approved the rule; approvals of the moment still follow the business's policy – never bypassed.
    if (rule.autonomy === "auto" && !(await requiresManager(businessId, "assignment"))) await managerDecision(null, rec.id, { action: "approve", via: "rule" });
    else await notifyManagers(rec, `📈 ${rec.title}\n${rec.explanation}\n\nלאישור השב: אשר ${rec.code}\nלדחייה: דחה ${rec.code}`);
    results.push({ ruleId: rule.id, state: "fired", recommendationId: rec.id, count });
  }
  return { created, results };
}

/** Today's state of each distribution rule (for the owner's screen). */
export async function distributionRulesView(businessId: string) {
  const rules = await prisma.opsRule.findMany({ where: { businessId, kind: "performance_bonus" }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
  const { agents } = await agentSnapshots(businessId);
  const { day } = await dayOf(businessId, new Date());
  const users = await prisma.user.findMany({ where: { businessId }, select: { id: true, fullName: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.fullName]));
  const conflicts = conflictsOf(rules.filter((r) => r.status === "active"));
  return Promise.all(rules.map(async (r) => {
    let c: Bonus | null = null; try { c = parseConfig("performance_bonus", r.config); } catch { c = null; }
    const today = c ? await prisma.opsRecommendation.findFirst({ where: { businessId, dedupeKey: `bonus:${c.agentId}:${day}` }, select: { id: true, status: true, ruleId: true, requestedCount: true } }) : null;
    return {
      id: r.id, name: r.name, status: r.status, priority: r.priority, autonomy: r.autonomy, sourceText: r.sourceText, config: r.config, createdAt: r.createdAt, expiresAt: r.expiresAt,
      summary: c ? describeRule("performance_bonus", c, r.autonomy as Autonomy, names) : null,
      today: c ? { condition: bonusCondition(c, agents.find((a) => a.id === c!.agentId && a.inPool)), request: today } : null,
      conflicts: conflicts[r.id] ?? [],
    };
  }));
}

/** Two active rules on the same agent (the stronger priority wins that day) – shown before activation. */
export function conflictsOf(rules: Array<{ id: string; name: string; priority: number; createdAt: Date; config: unknown }>) {
  const out: Record<string, string[]> = {};
  const byAgent = new Map<string, typeof rules>();
  for (const r of rules) { const a = (r.config as { agentId?: string }).agentId; if (a) byAgent.set(a, [...(byAgent.get(a) ?? []), r]); }
  for (const list of byAgent.values()) if (list.length > 1) {
    const sorted = [...list].sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
    for (const r of sorted.slice(1)) out[r.id] = [`מתנגש עם "${sorted[0].name}" על אותו נציג – באותו יום רק הכלל בעדיפות הגבוהה יותר יפעל`];
  }
  return out;
}

/**
 * Dry run: how the next `count` new leads would be distributed now – the regular policy, the active allocation and
 * (optionally) a draft rule as if its bonus started now. Nothing is written or assigned.
 */
export async function simulateDistribution(businessId: string, input: { count: number; rule?: { config: unknown } | null; assumeConditionMet?: boolean }) {
  const s = await getBusinessSettings(businessId);
  const policy: DistPolicy = { ...s.leadAssignment };
  const users = await prisma.user.findMany({ where: { businessId, isActive: true, role: { in: ["agent", "manager"] } }, orderBy: { createdAt: "asc" }, select: { id: true, fullName: true, _count: { select: { ownedLeads: { where: { status: { in: ["new", "contacted", "qualified"] } } } } } } });
  const { ruleFor } = await import("./rules");
  const loadCap = await ruleFor(businessId, "load_cap");
  const auto = loadCap?.autonomy === "auto";
  const { agents: snaps } = await agentSnapshots(businessId);
  const agents: DistAgent[] = users.map((u) => ({ id: u.id, name: u.fullName, openLeads: u._count.ownedLeads, untouched: snaps.find((x) => x.id === u.id)?.untouched ?? 0, online: policy.requireOnline ? Boolean(snaps.find((x) => x.id === u.id)?.online) : true }));
  const name = (id: string | null) => (id ? users.find((u) => u.id === id)?.fullName ?? id : "ללא שיוך");
  const active = await prisma.assignmentOverride.findFirst({ where: { businessId, status: "active", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } });
  let ov: DistOverride | null = active ? { id: active.id, agentId: active.agentId, mode: active.mode, sharePct: active.sharePct, leadLimit: active.leadLimit, assigned: active.assigned, total: active.total } : null;
  let ruleNote: string | null = null;
  if (input.rule && !ov) {
    const c = parseConfig("performance_bonus", input.rule.config);
    const cond = bonusCondition(c, snaps.find((a) => a.id === c.agentId && a.inPool));
    if (cond.state === "met" || input.assumeConditionMet) {
      const snap = snaps.find((a) => a.id === c.agentId);
      const cap = snap ? await agentCapacity(businessId, snap) : null;
      const n = cap?.known ? Math.min(c.bonusCount, cap.spare) : c.bonusCount;
      ov = { id: "draft", agentId: c.agentId, mode: "extra", sharePct: 100, leadLimit: n, assigned: 0, total: 0 };
      ruleNote = `${cond.state === "met" ? cond.text : `בהנחה שהתנאי מתקיים (כרגע: ${cond.text})`}. תוספת: ${n} לידים${cap && !cap.known ? ` – שימו לב: ${cap.reason}; בביצוע אמיתי לא תוקצה תוספת בלי קיבולת ידועה` : cap && n < c.bonusCount ? ` (לפי קיבולת פנויה ${cap.spare})` : ""}.`;
    } else ruleNote = `הכלל לא היה מופעל עכשיו – ${cond.text}.`;
  } else if (input.rule && ov) ruleNote = "כבר פעילה הקצאה זמנית אחרת – התוספת של הכלל תמתין לסיומה.";
  const rows: Array<{ n: number; agent: string; agentId: string | null; why: string }> = [];
  const tally: Record<string, number> = {};
  for (let i = 1; i <= Math.min(Math.max(1, input.count), 200); i++) {
    const d = decide(policy, agents, auto ? loadCap!.config.maxUntouched : null, ov);
    const skipped = Object.entries(d.reason.skipped).map(([id, r]) => `${name(id)}: ${SKIP_LABEL[r]}`);
    const why = !d.owner ? (d.reason.none ?? "אין נציג זכאי") : d.overrideId ? `תוספת לפי ${ov?.id === "draft" ? "הכלל" : "הקצאה זמנית"} (${ov!.assigned + 1}/${ov!.leadLimit}) – במקום ${name(d.reason.regular)}` : `${policy.mode === "round_robin" ? "סבב (ראונד רובין)" : "הכי פחות לידים פתוחים"}${d.reason.availabilityDropped ? " – אף אחד לא מחובר, הזמינות לא נדרשה" : ""}`;
    rows.push({ n: i, agentId: d.owner, agent: name(d.owner), why: skipped.length ? `${why} · דולגו: ${skipped.join("; ")}` : why });
    if (d.owner) {
      tally[d.owner] = (tally[d.owner] ?? 0) + 1;
      const a = agents.find((x) => x.id === d.owner)!; a.openLeads++; a.untouched++;
      if (d.movePointer) policy.lastAssignedUserId = d.owner;
      if (ov && d.reason.regular && d.reason.eligible.includes(ov.agentId)) {
        const { applyOverridePure } = await import("@/lib/crm/distribution");
        const o = applyOverridePure(ov, d.reason.eligible, d.reason.regular);
        ov = o.done ? null : { ...ov, assigned: o.assigned, total: o.total };
      }
    }
  }
  return { rows, tally: Object.entries(tally).map(([id, n]) => ({ agentId: id, agent: name(id), leads: n })), ruleNote, policy: { mode: policy.mode, requireOnline: Boolean(policy.requireOnline) } };
}
