/**
 * Lead distribution – the pure decision, shared by the real assignment (events/handlers.ts → pickOwner, under a
 * per-business lock) and the preview / simulation (server/ops/distribution.ts). No I/O here.
 *
 *  • Eligible = active agent/manager in the pool (settings → חלוקת לידים; empty pool = everyone), under their cap of
 *    open leads, under the "מנהל AI" load rule, and – when "availability" is on – connected to the dialer now.
 *  • Round robin: the next eligible agent after the one who received the previous lead (the pointer), in a fixed order
 *    (when they joined). An agent who is not eligible right now is skipped – the pointer is not lost.
 *  • Least loaded: the eligible agent with the fewest open leads (ties → the fixed order).
 *  • A temporary allocation (an approved "מנהל AI" request or distribution rule) may take the lead ("extra": on top of
 *    the regular share, taken from other agents' turns – the pointer does not move).
 *  • Nobody eligible → the lead stays unassigned (or, when availability is on and "anyone eligible" was chosen, the
 *    availability condition is dropped for that lead).
 */
export interface DistAgent { id: string; name?: string; openLeads: number; untouched: number; online: boolean }
export interface DistPolicy { mode: "least_loaded" | "round_robin"; maxOpenLeadsPerAgent: number; agentIds: string[]; perAgentMax: Record<string, number>; lastAssignedUserId: string | null; requireOnline?: boolean; whenNoneOnline?: "unassigned" | "any_eligible" }
export interface DistOverride { id: string; agentId: string; mode: string; sharePct: number; leadLimit: number; assigned: number; total: number }
export type SkipReason = "not_in_pool" | "cap" | "load" | "offline";
export interface Decision {
  owner: string | null; movePointer: boolean; overrideId: string | null;
  reason: { policy: "round_robin" | "least_loaded"; regular: string | null; eligible: string[]; skipped: Record<string, SkipReason>; availabilityDropped: boolean; override: { id: string; mode: string } | null; none: string | null };
}

export const capOf = (p: DistPolicy, id: string) => (p.perAgentMax ?? {})[id] ?? p.maxOpenLeadsPerAgent;

/** Who may receive the next lead, and why the others may not. `agents` in the fixed order (joined first → first). */
export function eligibility(p: DistPolicy, agents: DistAgent[], loadCap: number | null) {
  const skipped: Record<string, SkipReason> = {};
  const inPool = agents.filter((a) => { const ok = !p.agentIds.length || p.agentIds.includes(a.id); if (!ok) skipped[a.id] = "not_in_pool"; return ok; });
  const underCap = inPool.filter((a) => { const cap = capOf(p, a.id); const ok = !cap || a.openLeads < cap; if (!ok) skipped[a.id] = "cap"; return ok; });
  const underLoad = underCap.filter((a) => { const ok = loadCap === null || a.untouched < loadCap; if (!ok) skipped[a.id] = "load"; return ok; });
  if (!p.requireOnline) return { eligible: underLoad, skipped, availabilityDropped: false };
  const online = underLoad.filter((a) => { if (!a.online) skipped[a.id] = "offline"; return a.online; });
  if (online.length || p.whenNoneOnline !== "any_eligible") return { eligible: online, skipped, availabilityDropped: false };
  for (const a of underLoad) delete skipped[a.id];
  return { eligible: underLoad, skipped, availabilityDropped: true };
}

/** The regular policy's pick among the eligible agents. */
export function chooseRegular(p: DistPolicy, eligible: DistAgent[], order: string[] = eligible.map((a) => a.id)): string | null {
  if (!eligible.length) return null;
  if (p.mode === "round_robin") {
    // The first eligible agent AFTER the pointer in the fixed order (wrapping). The agent at the pointer may not be
    // eligible right now (cap / offline) – the rotation still continues from their place, it doesn't restart.
    const ids = new Set(eligible.map((a) => a.id));
    const at = p.lastAssignedUserId ? order.indexOf(p.lastAssignedUserId) : -1;
    for (let k = 1; k <= order.length; k++) { const id = order[(at + k + order.length) % order.length]; if (ids.has(id)) return id; }
    return eligible[0].id;
  }
  return [...eligible].sort((a, b) => a.openLeads - b.openLeads)[0].id;
}

/** An active temporary allocation applied to one lead (the same arithmetic as before, now pure). */
export function applyOverridePure(ov: DistOverride | null, eligible: string[], regular: string) {
  if (!ov || !eligible.includes(ov.agentId)) return { owner: regular, movePointer: true, toAgent: false, assigned: ov?.assigned ?? 0, total: ov?.total ?? 0, done: false };
  let owner = regular; let movePointer = true; let toAgent = false;
  if (ov.mode === "priority") { owner = ov.agentId; toAgent = true; movePointer = regular === ov.agentId; }
  else if (ov.mode === "extra") { if (regular !== ov.agentId) { owner = ov.agentId; toAgent = true; movePointer = false; } }
  else {
    const due = Math.round((ov.sharePct / 100) * (ov.total + 1));
    if (ov.assigned < due) { owner = ov.agentId; toAgent = true; movePointer = regular === ov.agentId; }
    else if (regular === ov.agentId) { const others = eligible.filter((x) => x !== ov.agentId); if (others.length) owner = others[ov.total % others.length]; }
  }
  const assigned = ov.assigned + (toAgent ? 1 : 0); const total = ov.total + 1;
  const done = ov.mode === "share" ? total >= ov.leadLimit : assigned >= ov.leadLimit;
  return { owner, movePointer, toAgent, assigned, total, done };
}

/** One lead: eligibility → regular pick → temporary allocation. */
export function decide(p: DistPolicy, agents: DistAgent[], loadCap: number | null, ov: DistOverride | null): Decision {
  const el = eligibility(p, agents, loadCap);
  const regular = chooseRegular(p, el.eligible, agents.map((a) => a.id));
  const base = { policy: p.mode, regular, eligible: el.eligible.map((a) => a.id), skipped: el.skipped, availabilityDropped: el.availabilityDropped };
  if (!regular) return { owner: null, movePointer: false, overrideId: null, reason: { ...base, override: null, none: agents.length ? "אין נציג זכאי כרגע (מכסה / עומס / זמינות / מחוץ לחלוקה)" : "אין נציגים פעילים" } };
  const o = applyOverridePure(ov, base.eligible, regular);
  return { owner: o.owner, movePointer: o.movePointer, overrideId: o.toAgent && ov ? ov.id : null, reason: { ...base, override: o.toAgent && ov ? { id: ov.id, mode: ov.mode } : null, none: null } };
}

export const SKIP_LABEL: Record<SkipReason, string> = { not_in_pool: "לא משתתף בחלוקה", cap: "הגיע למכסת הלידים הפתוחים", load: "יותר מדי לידים שטרם טופלו (כלל עומס)", offline: "לא מחובר לחייגן כרגע" };
