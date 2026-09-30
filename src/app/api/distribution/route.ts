import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import { capOf, chooseRegular, eligibility, SKIP_LABEL } from "@/lib/crm/distribution";
import { agentSnapshots } from "@/server/ops/metrics";
import { ruleFor } from "@/server/ops/rules";
import { distributionRulesView } from "@/server/ops/distribution";

export const dynamic = "force-dynamic";

/**
 * The owner's distribution screen: the policy, every agent with why they do / don't receive leads right now, who is
 * next in the rotation, and the distribution rules with today's state. Owner only (also through the API).
 */
export const GET = withAuth(async ({ user }) => {
  const s = await getBusinessSettings(user.businessId);
  const p = s.leadAssignment;
  const users = await prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, role: { in: ["agent", "manager"] } }, orderBy: { createdAt: "asc" }, select: { id: true, fullName: true, role: true, _count: { select: { ownedLeads: { where: { status: { in: ["new", "contacted", "qualified"] } } } } } } });
  const { agents: snaps } = await agentSnapshots(user.businessId);
  const loadCap = await ruleFor(user.businessId, "load_cap");
  const auto = loadCap?.autonomy === "auto";
  const agents = users.map((u) => { const sn = snaps.find((x) => x.id === u.id); return { id: u.id, name: u.fullName, openLeads: u._count.ownedLeads, untouched: sn?.untouched ?? 0, online: Boolean(sn?.online) }; });
  const el = eligibility(p, agents.map((a) => ({ ...a, online: p.requireOnline ? a.online : true })), auto ? loadCap!.config.maxUntouched : null);
  const next = chooseRegular(p, el.eligible, agents.map((a) => a.id));
  return ok({
    policy: p, timezone: s.timezone, loadCap: auto ? loadCap!.config.maxUntouched : null,
    agents: agents.map((a) => ({ ...a, role: users.find((u) => u.id === a.id)!.role, cap: capOf(p, a.id) || null, eligible: el.eligible.some((e) => e.id === a.id), why: el.skipped[a.id] ? SKIP_LABEL[el.skipped[a.id]] : null })),
    next: next ? { id: next, name: agents.find((a) => a.id === next)?.name ?? "" } : null,
    rules: await distributionRulesView(user.businessId),
  });
}, { minRole: "owner" });
