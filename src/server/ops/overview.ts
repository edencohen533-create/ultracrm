/** "מנהל AI" screen data: recommendations, allocations, rules, agents today, log, measured (descriptive) impact. */
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { agentSnapshots, agentCapacity } from "./metrics";
import { assessMomentum, STATUS_LABEL, MODE_LABEL } from "./engine";
import { ensureDefaultRules, describeRule, ruleFor, KIND_LABEL, AUTONOMY_LABEL, ALLOWED_AUTONOMY, type RuleKind, type Autonomy } from "./rules";

export async function opsOverview(user: SessionUser) {
  const businessId = user.businessId;
  await ensureDefaultRules(businessId);
  const s = await getBusinessSettings(businessId);
  const ids = await visibleUserIds(user);
  const inScope = (agentId: string | null) => !ids || !agentId || ids.includes(agentId);

  const rules = (await prisma.opsRule.findMany({ where: { businessId }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] })).map((r) => {
    const kind = r.kind as RuleKind;
    let summary: ReturnType<typeof describeRule> | null = null; try { summary = describeRule(kind, r.config, r.autonomy as Autonomy); } catch { summary = null; }
    return { ...r, kindLabel: KIND_LABEL[kind] ?? r.kind, autonomyLabel: AUTONOMY_LABEL[r.autonomy as Autonomy] ?? r.autonomy, allowedAutonomy: ALLOWED_AUTONOMY[kind] ?? [], summary, expired: Boolean(r.expiresAt && r.expiresAt <= new Date()) };
  });

  const recs = (await prisma.opsRecommendation.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 80 })).filter((r) => inScope(r.agentId));
  const agentNames = new Map((await prisma.user.findMany({ where: { businessId }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
  const overrides = await prisma.assignmentOverride.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 40 });
  const allocatedLogs = await prisma.auditLog.findMany({ where: { businessId, action: "ai_ops.lead_allocated", createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, select: { entityId: true, payload: true, createdAt: true } });
  const byRec = new Map<string, Array<{ leadId: string; at: Date }>>();
  for (const l of allocatedLogs) { const rid = (l.payload as { recommendationId?: string } | null)?.recommendationId; if (rid) byRec.set(rid, [...(byRec.get(rid) ?? []), { leadId: l.entityId, at: l.createdAt }]); }
  const view = (r: (typeof recs)[number]) => {
    const ov = overrides.find((o) => o.recommendationId === r.id) ?? null;
    const allocated = byRec.get(r.id)?.length ?? 0;
    return { ...r, agentName: r.agentId ? agentNames.get(r.agentId) ?? null : null, statusLabel: STATUS_LABEL[r.status] ?? r.status, modeLabel: (r.proposal as { mode?: keyof typeof MODE_LABEL })?.mode ? MODE_LABEL[(r.proposal as { mode: keyof typeof MODE_LABEL }).mode] : null, override: ov, allocated };
  };

  // Agents today (only in the manager's scope) with the momentum assessment and capacity – the numbers behind it all.
  const momentum = await ruleFor(businessId, "momentum");
  const { agents } = await agentSnapshots(businessId);
  const team = [];
  for (const a of agents.filter((x) => inScope(x.id))) {
    const cap = await agentCapacity(businessId, a);
    team.push({ ...a, assessment: momentum ? assessMomentum(a, momentum.config) : null, capacity: cap, shift: s.aiOps.shifts[a.id] ?? null });
  }

  // Impact: descriptive only (no causal claim), per finished allocation.
  const impact = [];
  for (const r of recs.filter((x) => x.kind === "momentum" && ["active", "completed"].includes(x.status)).slice(0, 20)) {
    const leads = byRec.get(r.id) ?? [];
    const rows = leads.length ? await prisma.lead.findMany({ where: { id: { in: leads.map((l) => l.leadId) }, businessId }, select: { id: true, contactId: true } }) : [];
    let dialed = 0, won = 0;
    for (const l of rows) {
      if (await prisma.call.findFirst({ where: { businessId, contactId: l.contactId, direction: "outbound", leadDialedAt: { not: null }, createdAt: { gte: r.createdAt } }, select: { id: true } })) dialed++;
      if (await prisma.deal.findFirst({ where: { businessId, contactId: l.contactId, status: "won", closedAt: { gte: r.createdAt } }, select: { id: true } })) won++;
    }
    const ev = r.evidence as { agent?: { baseline?: { rate: number | null } } };
    impact.push({ id: r.id, agentName: r.agentId ? agentNames.get(r.agentId) ?? null : null, at: r.createdAt, approved: r.agentApprovedCount ?? r.managerApprovedCount, allocated: leads.length, dialed, won, baselineRate: ev.agent?.baseline?.rate ?? null, smallSample: leads.length < 20 });
  }

  const log = await prisma.auditLog.findMany({ where: { businessId, OR: [{ entityType: "ai_ops" }, { action: "ai_ops.lead_allocated" }, { action: { startsWith: "ops_rule." } }] }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, action: true, entityId: true, payload: true, createdAt: true, actor: { select: { fullName: true } } } });
  const lists = await prisma.dialList.findMany({ where: { businessId, archivedAt: null, isActive: true, isDynamic: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => [] as Array<{ id: string; name: string }>);
  const sources = (await prisma.lead.findMany({ where: { businessId, source: { not: null } }, distinct: ["source"], select: { source: true }, take: 50 })).map((x) => x.source!);
  const links = await prisma.assistantLink.findMany({ where: { businessId, status: "active", verifiedAt: { not: null } }, select: { userId: true } });

  return {
    settings: s.aiOps, timezone: s.timezone, aiConnected: Boolean(process.env.ANTHROPIC_API_KEY),
    rules, recommendations: recs.map(view), overrides: overrides.filter((o) => inScope(o.agentId)).map((o) => ({ ...o, agentName: agentNames.get(o.agentId) ?? null })),
    team, impact, log, lists, sources, whatsappLinked: [...new Set(links.map((l) => l.userId))],
  };
}

/** For an agent: requests waiting for their answer (in-app alternative to WhatsApp). */
export async function myRequests(user: SessionUser) {
  const rows = await prisma.opsRecommendation.findMany({ where: { businessId: user.businessId, agentId: user.id, status: "pending_agent", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, code: r.code, proposal: r.proposal, managerApprovedCount: r.managerApprovedCount, expiresAt: r.expiresAt, text: ((r.result ?? {}) as { agentRequest?: { text?: string } }).agentRequest?.text ?? r.explanation }));
}
