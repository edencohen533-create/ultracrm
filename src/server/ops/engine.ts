/**
 * "מנהל AI" – recommendations and temporary lead allocations, end to end:
 *
 *   detect (numbers in code) → recommendation (evidence + exact change) → MANAGER approves (ceiling, nothing assigned)
 *   → the AGENT is asked on WhatsApp / in the app (if the extra-leads policy says so) → agent confirms ≤ ceiling
 *   → re-check (active, permitted, campaign access, capacity) → allocation (AssignmentOverride on the regular policy,
 *   and/or existing UNASSIGNED leads right away) → completed when the approved number was assigned or the shift ends.
 *
 * Every transition is an atomic status change (a second approval / reply does nothing). Nothing is reserved while
 * waiting – the regular distribution keeps running. No reply is never an approval. Leads that belong to another agent
 * are never moved. If the model is unavailable, everything still works (numbers and texts are generated in code).
 */
import crypto from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { OpsRecommendation } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { agentSnapshots, agentCapacity, wilsonLower, type AgentSnapshot, type Capacity } from "./metrics";
import { ensureDefaultRules, requiresManager, ruleFor, type RuleConfig } from "./rules";

export type Mode = "extra" | "priority" | "share";
export interface Proposal { mode: Mode; count: number; sharePct: number; source: string | null; listId: string | null; listName?: string | null; fromUnassigned: boolean; until: string | null }
export const MODE_LABEL: Record<Mode, string> = {
  extra: "לידים נוספים מעבר לחלקו הרגיל בחלוקה",
  priority: "קדימות: הלידים החדשים הבאים יגיעו אליו",
  share: "חלוקה משוקללת: אחוז מהלידים החדשים הבאים",
};
export const STAGES = ["pending_manager", "pending_agent", "active", "completed"] as const;
export const STATUS_LABEL: Record<string, string> = { pending_manager: "ממתין לאישור מנהל", pending_agent: "ממתין לאישור נציג", active: "הקצאה פעילה", completed: "הושלם", rejected: "נדחה", expired: "פג תוקף", cancelled: "בוטל", failed: "לא בוצע", needs_adjustment: "נדרשת התאמה", insight: "תובנה" };

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const code4 = () => String(crypto.randomInt(1000, 10000));
const hhmm = (d: Date | null, tz: string) => (d ? new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d) : "—");

// ─── assessment ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface Assessment { state: "momentum" | "insufficient_data" | "normal" | "overloaded" | "not_available"; reasons: string[]; lowerBound: number | null; lift: number | null }

/** Pure: is the agent in momentum by the rule's thresholds? (Numbers only – no model involved.) */
export function assessMomentum(a: AgentSnapshot, c: RuleConfig<"momentum">): Assessment {
  const reasons: string[] = [];
  if (!a.inPool) return { state: "not_available", reasons: ["לא משתתף בחלוקת הלידים"], lowerBound: null, lift: null };
  if (a.today.handled < c.minHandled) reasons.push(`רק ${a.today.handled} לידים טופלו היום (סף: ${c.minHandled})`);
  if (a.today.wins < c.minWins) reasons.push(`${a.today.wins} סגירות היום (סף: ${c.minWins})`);
  if (a.baseline.handled < c.minBaselineHandled) reasons.push(`בסיס השוואה קטן: ${a.baseline.handled} לידים ב-${a.baseline.days} הימים הקודמים (סף: ${c.minBaselineHandled})`);
  if (reasons.length) return { state: "insufficient_data", reasons, lowerBound: null, lift: null };
  const base = a.baseline.rate ?? 0;
  const lb = wilsonLower(a.today.wins, a.today.handled, c.confidence);
  const lift = base > 0 ? (a.today.rate ?? 0) / base : null;
  const hot = (a.today.rate ?? 0) >= base * c.liftFactor && lb > base && (base > 0 || (a.today.rate ?? 0) > 0);
  const peersOk = !c.compareToPeers || a.peers.handled < c.minHandled || (a.today.rate ?? 0) > (a.peers.rate ?? 0);
  if (!hot) return { state: "normal", reasons: [`שיעור סגירה ${pct(a.today.rate)} מול ממוצע אישי ${pct(base)} – לא מעל הסף בביטחון מספיק`], lowerBound: lb, lift };
  if (!peersOk) return { state: "normal", reasons: [`לא מעל נציגים על לידים דומים (${pct(a.peers.rate)})`], lowerBound: lb, lift };
  if (a.untouched >= c.maxUntouched) return { state: "overloaded", reasons: [`${a.untouched} לידים שטרם טופלו (סף: פחות מ-${c.maxUntouched})`], lowerBound: lb, lift };
  return { state: "momentum", reasons: [], lowerBound: lb, lift };
}

function momentumText(a: AgentSnapshot, cap: Capacity, p: Proposal, tz: string, listName: string | null) {
  const what = p.mode === "share" ? `${p.sharePct}% מ-${p.count} הלידים החדשים הבאים` : p.mode === "priority" ? `את ${p.count} הלידים החדשים הבאים` : `עוד ${p.count} לידים היום, מעבר לחלקו הרגיל`;
  return {
    title: `${a.name} במומנטום: סגר ${a.today.wins} מתוך ${a.today.handled} לידים שטופלו היום (${pct(a.today.rate)}), לעומת ממוצע אישי של ${pct(a.baseline.rate)}`,
    explanation: [
      `יש לו כרגע מקום לעוד לידים עד סוף המשמרת (${cap.shift?.end ?? "—"}): קיבולת מוערכת ${cap.capacityLeads} לידים, עומס קיים ${cap.load} (${cap.untouched} שטרם טופלו + ${cap.followUpsBeforeEnd} פולואפים).`,
      `להקצות לו ${what}${listName ? ` בקמפיין ${listName}` : p.source ? ` ממקור ${p.source}` : ""}? תוקף עד ${hhmm(cap.shiftEnd, tz)}.`,
    ].join(" "),
  };
}

/** Optional model interpretation of the computed evidence (never new numbers). Falls back silently. */
async function interpret(evidence: unknown): Promise<string | null> {
  const { aiConnected } = await import("@/server/ai/settings");
  if (!aiConnected()) return null;
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: process.env.AI_SERVICE_MODEL ?? "claude-sonnet-5", max_tokens: 220, temperature: 0, system: "כתוב 2 משפטים בעברית למנהל מכירות שמפרשים את הנתונים: מה בולט ומה כדאי לבדוק (למשל מדגם, מקור לידים, גיל לידים). אל תוסיף מספרים שלא מופיעים בנתונים ואל תטען לסיבתיות.", messages: [{ role: "user", content: JSON.stringify(evidence).slice(0, 6000) }] }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { content: Array<{ type: string; text?: string }> }).content.filter((c) => c.type === "text").map((c) => c.text).join("").trim().slice(0, 600) || null;
  } catch { return null; }
}

// ─── notifications (manager / agent on WhatsApp, rate-limited) ───────────────────────────────────────────────────
async function linkOf(businessId: string, userId: string) {
  return prisma.assistantLink.findFirst({ where: { businessId, userId, status: "active", verifiedAt: { not: null } } });
}
async function send(businessId: string, userId: string, text: string, title: string) {
  const s = await getBusinessSettings(businessId);
  if (!s.aiOps.notifyWhatsApp || !s.assistant.enabled) return { status: "skipped" as const, detail: "התראות וואטסאפ כבויות" };
  const link = await linkOf(businessId, userId);
  if (!link) return { status: "skipped" as const, detail: "אין מספר וואטסאפ מאומת" };
  const { sendToLink } = await import("@/server/assistant/transport");
  const r = await sendToLink(link, text, { title }).catch((e: Error) => ({ status: "failed" as const, detail: e.message }));
  await prisma.assistantMessage.create({ data: { businessId, linkId: link.id, direction: "out", text: text.slice(0, 4000), intent: "ai_ops", status: r.status === "failed" ? "error" : "ok" } }).catch(() => undefined);
  return r;
}
async function managersToNotify(businessId: string, agentId: string | null) {
  const managers = await prisma.user.findMany({ where: { businessId, isActive: true, role: { in: ["owner", "manager"] } }, select: { id: true, role: true, teamId: true, email: true, fullName: true, accountId: true } });
  const out: string[] = [];
  for (const m of managers) {
    if (!agentId || m.role === "owner") { out.push(m.id); continue; }
    const ids = await visibleUserIds({ ...m, businessId });
    if (!ids || ids.includes(agentId)) out.push(m.id);
  }
  return out;
}
/** Manager alert with anti-flood: per business per day, and per agent+kind per cooldown. */
async function notifyManagers(rec: OpsRecommendation, text: string) {
  const s = await getBusinessSettings(rec.businessId);
  const today = new Date(Date.now() - 24 * 3600_000);
  const sentToday = await prisma.opsRecommendation.count({ where: { businessId: rec.businessId, notifiedAt: { gte: today } } });
  if (sentToday >= s.aiOps.maxAlertsPerDay) return;
  const recent = await prisma.opsRecommendation.findFirst({ where: { businessId: rec.businessId, kind: rec.kind, agentId: rec.agentId, notifiedAt: { gte: new Date(Date.now() - s.aiOps.cooldownMinutes * 60_000) }, NOT: { id: rec.id } }, select: { id: true } });
  if (recent) return;
  const claimed = await prisma.opsRecommendation.updateMany({ where: { id: rec.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (!claimed.count) return;
  for (const m of await managersToNotify(rec.businessId, rec.agentId)) await send(rec.businessId, m, text, "המלצה ממנהל AI");
}
const tellManagers = async (businessId: string, agentId: string | null, text: string) => { for (const m of await managersToNotify(businessId, agentId)) await send(businessId, m, text, "עדכון ממנהל AI"); };

// ─── detection ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Momentum → recommendation (at most one open per agent, cooldown, one allocation at a time per agent). */
export async function evaluateMomentum(businessId: string, now = new Date()) {
  const rule = await ruleFor(businessId, "momentum");
  if (!rule) return { created: 0 };
  const s = await getBusinessSettings(businessId);
  const { agents } = await agentSnapshots(businessId, { now });
  let created = 0;
  for (const a of agents) {
    const as = assessMomentum(a, rule.config);
    if (as.state !== "momentum") continue;
    const busy = await prisma.opsRecommendation.findFirst({ where: { businessId, agentId: a.id, kind: "momentum", OR: [{ status: { in: ["pending_manager", "pending_agent", "active", "needs_adjustment"] } }, { createdAt: { gte: new Date(now.getTime() - s.aiOps.cooldownMinutes * 60_000) } }] }, select: { id: true } });
    if (busy) continue;
    const cap = await agentCapacity(businessId, a, now);
    const day = cap.shiftEnd ? cap.shiftEnd.toISOString().slice(0, 10) : now.toISOString().slice(0, 10);
    const evidence = { agent: a, capacity: cap, thresholds: rule.config, lowerBound: as.lowerBound, lift: as.lift, ruleId: rule.id };
    if (!cap.known || cap.spare < 1) {
      // Momentum without known/free capacity: information only (once a day) – never an allocation.
      const reason = cap.reason ?? `אין קיבולת פנויה עד סוף המשמרת (קיבולת ${cap.capacityLeads}, עומס ${cap.load})`;
      try {
        await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: "momentum", agentId: a.id, status: "insight", code: code4(), title: `${a.name} במומנטום (${a.today.wins}/${a.today.handled} היום, ממוצע אישי ${pct(a.baseline.rate)})`, explanation: `לא הומלצה תוספת לידים: ${reason}.`, evidence: evidence as object, proposal: {}, dedupeKey: `momentum-insight:${a.id}:${day}`, expiresAt: cap.shiftEnd ?? new Date(now.getTime() + 8 * 3600_000) } });
        created++;
      } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; }
      continue;
    }
    const c = rule.config;
    const count = c.mode === "share" ? c.count : Math.min(c.count, cap.spare);
    const list = c.listId ? await prisma.dialList.findFirst({ where: { id: c.listId, businessId }, select: { id: true, name: true } }) : null;
    const proposal: Proposal = { mode: c.mode, count, sharePct: c.sharePct, source: c.source, listId: list?.id ?? null, listName: list?.name ?? null, fromUnassigned: false, until: cap.shiftEnd?.toISOString() ?? null };
    const text = momentumText(a, cap, proposal, s.timezone, list?.name ?? null);
    const status = rule.autonomy === "insight" ? "insight" : "pending_manager";
    let rec: OpsRecommendation;
    try {
      rec = await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: "momentum", agentId: a.id, status, code: code4(), title: text.title, explanation: text.explanation, evidence: { ...evidence, interpretation: await interpret({ agent: a, capacity: cap, lift: as.lift }) } as object, proposal: proposal as object, requestedCount: count, dedupeKey: `momentum:${a.id}:${day}:${Math.floor(now.getTime() / (s.aiOps.cooldownMinutes * 60_000))}`, expiresAt: new Date(Math.min(now.getTime() + 2 * 3600_000, cap.shiftEnd!.getTime())) } });
    } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; throw e; }
    created++;
    await audit(businessId, null, "ai_ops", rec.id, "ai_ops.detected", { kind: "momentum", agentId: a.id, today: a.today, baseline: a.baseline, peers: a.peers, lowerBound: as.lowerBound, capacity: { spare: cap.spare, load: cap.load, shiftEnd: cap.shiftEnd } });
    if (status === "pending_manager" && rule.autonomy === "auto" && !(await requiresManager(businessId, "assignment"))) {
      await managerDecision(null, rec.id, { action: "approve", via: "rule" });
      continue;
    }
    if (status === "pending_manager") await notifyManagers(rec, `🤖 ${text.title}\n${text.explanation}\n\nלאישור השב: אשר ${rec.code}\nלדחייה: דחה ${rec.code}\n(או במערכת: עוזר AI → מנהל AI)`);
  }
  return { created };
}

// ─── manager decision ─────────────────────────────────────────────────────────────────────────────────────────
const editSchemaKeys = ["mode", "count", "sharePct", "source", "listId", "fromUnassigned"] as const;
export interface ManagerInput { action: "approve" | "reject"; edits?: Partial<Pick<Proposal, (typeof editSchemaKeys)[number]>>; via: "app" | "whatsapp" | "rule" }

async function assertManagerOf(user: SessionUser, agentId: string | null) {
  if (user.role !== "owner" && user.role !== "manager") throw new ApiError("רק מנהל יכול לאשר", 403, "forbidden");
  if (!agentId) return;
  const ids = await visibleUserIds(user);
  if (ids && !ids.includes(agentId)) throw new ApiError("הנציג אינו בצוות שלך", 403, "forbidden");
}

/** Manager approves (sets the ceiling – nothing is assigned yet) or rejects. `user` null = an auto rule. */
export async function managerDecision(user: SessionUser | null, id: string, input: ManagerInput) {
  const rec = await prisma.opsRecommendation.findFirst({ where: { id, ...(user ? { businessId: user.businessId } : {}) } });
  if (!rec) throw new ApiError("ההמלצה לא נמצאה", 404, "not_found");
  if (user) await assertManagerOf(user, rec.agentId);
  if (rec.status !== "pending_manager") throw new ApiError(`ההמלצה כבר ${STATUS_LABEL[rec.status] ?? rec.status}`, 409, "not_pending");
  if (rec.expiresAt <= new Date()) { await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_manager" }, data: { status: "expired" } }); throw new ApiError("פג תוקף ההמלצה – הנתונים כבר לא עדכניים", 409, "expired"); }
  if (input.action === "reject") {
    const r = await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_manager" }, data: { status: "rejected", decidedById: user?.id ?? null, decidedAt: new Date(), decidedVia: input.via } });
    if (!r.count) throw new ApiError("ההמלצה כבר טופלה", 409, "not_pending");
    await audit(rec.businessId, user?.id ?? null, "ai_ops", rec.id, "ai_ops.rejected", { by: "manager", via: input.via });
    return { status: "rejected" as const };
  }
  if (rec.kind === "availability_unattended") return approveAvailabilityTransfer(user, rec, input.via);
  // Edits (explicit mode / count / campaign) – validated here.
  const p = { ...(rec.proposal as unknown as Proposal), ...(input.edits ?? {}) } as Proposal;
  if (!["extra", "priority", "share"].includes(p.mode)) throw new ApiError("סוג הקצאה לא תקין", 400, "validation");
  p.count = Math.round(Number(p.count)); p.sharePct = Math.round(Number(p.sharePct));
  if (!(p.count >= 1 && p.count <= 100)) throw new ApiError("כמות לידים בין 1 ל-100", 400, "validation");
  if (p.mode === "share" && !(p.sharePct >= 10 && p.sharePct <= 100)) throw new ApiError("אחוז בין 10 ל-100", 400, "validation");
  if (p.listId) { const l = await prisma.dialList.findFirst({ where: { id: p.listId, businessId: rec.businessId, archivedAt: null }, select: { id: true, name: true } }); if (!l) throw new ApiError("הקמפיין לא נמצא", 400, "validation"); p.listName = l.name; }
  const policy = await ruleFor(rec.businessId, "extra_leads_policy");
  const askAgent = policy ? policy.config.askAgent : true;
  const s = await getBusinessSettings(rec.businessId);
  const until = p.until ? new Date(p.until) : null;
  const waitUntil = new Date(Math.min(Date.now() + (policy?.config.requestMinutes ?? 60) * 60_000, until?.getTime() ?? Infinity));
  const next = askAgent ? "pending_agent" : "approved_direct";
  const r = await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_manager" }, data: { status: askAgent ? "pending_agent" : "executing", proposal: p as object, managerApprovedCount: p.count, decidedById: user?.id ?? null, decidedAt: new Date(), decidedVia: input.via, ...(askAgent ? { agentAskedAt: new Date(), expiresAt: waitUntil } : {}) } });
  if (!r.count) throw new ApiError("ההמלצה כבר טופלה", 409, "not_pending");
  await audit(rec.businessId, user?.id ?? null, "ai_ops", rec.id, "ai_ops.manager_approved", { via: input.via, proposal: p, askAgent });
  if (next === "approved_direct") return executeAllocation(rec.id, p.count, { via: input.via, by: user?.id ?? null, fromManager: true });
  // Ask the agent – on WhatsApp (verified number) and in the app.
  const agent = await prisma.user.findFirst({ where: { id: rec.agentId!, businessId: rec.businessId }, select: { fullName: true } });
  const what = p.mode === "share" ? `${p.sharePct}% מ-${p.count} הלידים החדשים הבאים` : p.mode === "priority" ? `קדימות ב-${p.count} הלידים החדשים הבאים` : `תוספת של ${p.count} לידים`;
  const msg = `היי ${agent?.fullName.split(" ")[0] ?? ""}, אושרה עבורך ${what}${p.listName ? ` מקמפיין ${p.listName}` : p.source ? ` ממקור ${p.source}` : ""} להיום. האם תספיק לבצע ניסיון טיפול ראשון ב${p.count === 1 ? "ליד" : `כל ה-${p.count}`} עד סוף המשמרת ב-${hhmm(until, s.timezone)}?\n\nאפשר לענות:\n• כן – אפשר להעביר ${p.count}\n• מספר קטן יותר (למשל: 3)\n• לא היום\n(בקשה ${rec.code}, בתוקף עד ${hhmm(waitUntil, s.timezone)})`;
  const sent = await send(rec.businessId, rec.agentId!, msg, "בקשת אישור לידים נוספים");
  await prisma.opsRecommendation.update({ where: { id }, data: { result: { agentRequest: { channel: sent.status === "sent" || sent.status === "template" ? "whatsapp" : "app", delivery: sent.status, detail: "detail" in sent ? sent.detail ?? null : null, text: msg } } as object } });
  return { status: "pending_agent" as const, delivery: sent.status };
}

// ─── agent decision ─────────────────────────────────────────────────────────────────────────────────────────────
export type AgentAnswer = { kind: "yes"; count: number | null } | { kind: "no" } | { kind: "unclear"; reason: string };
const HEB_NUM: Record<string, number> = { "אחד": 1, "אחת": 1, "שניים": 2, "שתיים": 2, "שנים": 2, "שלושה": 3, "שלוש": 3, "ארבעה": 4, "ארבע": 4, "חמישה": 5, "חמש": 5, "שישה": 6, "שש": 6, "שבעה": 7, "שבע": 7, "שמונה": 8, "תשעה": 9, "תשע": 9, "עשרה": 10, "עשר": 10 };

/** Agent's free-text answer → yes (all / N) · no · unclear (ask again, never assign). */
export function parseAgentAnswer(text: string): AgentAnswer {
  const t = text.trim().replace(/[.!?,״"]/g, " ").replace(/\s+/g, " ").trim();
  const n = t.match(/\b(\d{1,3})\b/) ? Number(t.match(/\b(\d{1,3})\b/)![1]) : (Object.entries(HEB_NUM).find(([w]) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t))?.[1] ?? null);
  if (/^(לא|לא היום|לא הפעם|אין מצב|לא אספיק|לא יכול|לא יכולה|לא תודה|אני לא יכול|אני לא יכולה)(\s|$)/.test(t) && !(n && /אבל|רק/.test(t))) return { kind: "no" };
  if (/(כמות קטנה יותר|פחות|לא את כולם|חלק)/.test(t) && !n) return { kind: "unclear", reason: "כמה לידים תוכל/י לקבל?" };
  if (n !== null && n >= 0) return n === 0 ? { kind: "no" } : { kind: "yes", count: n };
  if (/^(כן|כן כן|יאללה|סבבה|בטח|אפשר|מאשר|מאשרת|אשר|אוקיי|אוקי|ok|yes|בסדר|תעביר|תעבירו|שלח|שלחו)(\s|$)/i.test(t)) return { kind: "yes", count: null };
  return { kind: "unclear", reason: "לא הבנתי – אפשר לענות: כן / מספר לידים / לא היום" };
}

/** The agent's answer to a pending request (only the agent it was addressed to). */
export async function agentDecision(agent: SessionUser, id: string, answer: AgentAnswer, via: "app" | "whatsapp", raw?: string) {
  const rec = await prisma.opsRecommendation.findFirst({ where: { id, businessId: agent.businessId } });
  if (!rec || rec.agentId !== agent.id) throw new ApiError("הבקשה לא נמצאה", 404, "not_found");
  if (rec.status !== "pending_agent") throw new ApiError(`הבקשה כבר ${STATUS_LABEL[rec.status] ?? rec.status}`, 409, "not_pending");
  if (rec.expiresAt <= new Date()) { await expireRec(rec, "לא התקבלה תשובה בזמן"); throw new ApiError("פג תוקף הבקשה", 409, "expired"); }
  if (answer.kind === "unclear") return { status: "unclear" as const, message: answer.reason };
  const ceiling = rec.managerApprovedCount ?? 0;
  if (answer.kind === "no") {
    const r = await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_agent" }, data: { status: "rejected", agentRespondedAt: new Date(), agentReply: (raw ?? "לא").slice(0, 500), agentApprovedCount: 0 } });
    if (!r.count) throw new ApiError("הבקשה כבר טופלה", 409, "not_pending");
    await audit(rec.businessId, agent.id, "ai_ops", rec.id, "ai_ops.agent_declined", { via });
    await tellManagers(rec.businessId, rec.agentId, `ℹ️ ${agent.fullName} השיב/ה שלא יספיק/תספיק היום – לא הוקצו לידים (בקשה ${rec.code}).`);
    return { status: "rejected" as const };
  }
  const want = answer.count ?? ceiling;
  const count = Math.min(want, ceiling);
  const note = want > ceiling ? `ביקש/ה ${want}; אושרו עד ${ceiling} – הגדלה דורשת אישור מנהל נוסף` : null;
  const r = await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_agent" }, data: { status: "executing", agentRespondedAt: new Date(), agentReply: (raw ?? `כן ${count}`).slice(0, 500), agentApprovedCount: count } });
  if (!r.count) throw new ApiError("הבקשה כבר טופלה", 409, "not_pending");
  await audit(rec.businessId, agent.id, "ai_ops", rec.id, "ai_ops.agent_approved", { via, count, requested: want, ceiling });
  const out = await executeAllocation(rec.id, count, { via, by: agent.id, fromManager: false, note });
  if (note && out.status === "active") await tellManagers(rec.businessId, rec.agentId, `ℹ️ ${agent.fullName} ביקש/ה ${want} לידים (אושרו ${ceiling}). הוקצו עד ${ceiling}; הגדלה – בהמלצה חדשה באישורך.`);
  return { ...out, note };
}

// ─── execution ────────────────────────────────────────────────────────────────────────────────────────────────
/** Re-check everything at execution time, then create the allocation. Never marks "done" before leads are assigned. */
async function executeAllocation(id: string, count: number, ctx: { via: string; by: string | null; fromManager: boolean; note?: string | null }) {
  const rec = await prisma.opsRecommendation.findUniqueOrThrow({ where: { id } });
  const p = rec.proposal as unknown as Proposal;
  const fail = async (reason: string, status: "failed" | "needs_adjustment" = "failed", extra: Record<string, unknown> = {}) => {
    await prisma.opsRecommendation.update({ where: { id }, data: { status, result: { ...((rec.result ?? {}) as object), reason, ...extra } as object } });
    await audit(rec.businessId, ctx.by, "ai_ops", id, status === "failed" ? "ai_ops.failed" : "ai_ops.needs_adjustment", { reason, ...extra });
    await tellManagers(rec.businessId, rec.agentId, `⚠️ ${rec.title.split(":")[0]} – ${status === "failed" ? "לא בוצע" : "נדרשת התאמה"}: ${reason} (בקשה ${rec.code})`);
    if (rec.agentId) await send(rec.businessId, rec.agentId, `ℹ️ ההקצאה לא הופעלה: ${reason}. לא הוקצו לידים.`, "עדכון מנהל AI");
    return { status, reason };
  };
  const agent = await prisma.user.findFirst({ where: { id: rec.agentId!, businessId: rec.businessId, isActive: true }, select: { id: true, fullName: true } });
  if (!agent) return fail("הנציג אינו פעיל");
  const { effectiveAccess, can } = await import("@/lib/access/engine");
  const acc = await effectiveAccess(rec.businessId, agent.id);
  if (!can(acc, "crm.view")) return fail("לנציג אין הרשאת CRM");
  if (p.listId) {
    if (!can(acc, "telephony.use")) return fail("לנציג אין הרשאת חייגן לקמפיין");
    // Same rule as the dialer (assertListAccess): a campaign with selected agents is open only to them.
    const list = await prisma.dialList.findFirst({ where: { id: p.listId, businessId: rec.businessId, archivedAt: null, isActive: true }, select: { id: true, agents: { select: { userId: true } } } });
    if (!list || (list.agents.length > 0 && !list.agents.some((x) => x.userId === agent.id))) return fail("הנציג אינו מורשה לקמפיין");
  }
  const s = await getBusinessSettings(rec.businessId);
  const policy = s.leadAssignment;
  if (policy.agentIds.length && !policy.agentIds.includes(agent.id)) return fail("הנציג אינו משתתף בחלוקת הלידים");
  const { agents } = await agentSnapshots(rec.businessId);
  const snap = agents.find((a) => a.id === agent.id);
  if (!snap) return fail("הנציג אינו זמין לחלוקה");
  if (!snap.capOk) return fail("הנציג הגיע למכסת הלידים הפתוחים שלו");
  if (p.mode !== "share") {
    const cap = await agentCapacity(rec.businessId, snap);
    if (!cap.known) return fail(cap.reason ?? "הקיבולת אינה ידועה");
    // Capacity changed materially while waiting → stop and ask for an adjustment (nothing assigned).
    if (cap.spare < count) return fail(`הקיבולת השתנתה: כעת פנויים ${cap.spare} (אושרו ${count}). יש לאשר כמות מותאמת`, "needs_adjustment", { spareNow: cap.spare, approved: count });
  }
  const loadCap = await ruleFor(rec.businessId, "load_cap");
  if (loadCap?.autonomy === "auto" && snap.untouched >= loadCap.config.maxUntouched) return fail(`לנציג ${snap.untouched} לידים שטרם טופלו (כלל עומס: ${loadCap.config.maxUntouched})`);
  const until = p.until ? new Date(p.until) : new Date(Date.now() + 4 * 3600_000);
  if (until <= new Date()) return fail("המשמרת הסתיימה");

  // Allocation – serialized with the regular distribution (same advisory lock as pickOwner).
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-assign:${rec.businessId}`}))`;
    const clash = await tx.assignmentOverride.findFirst({ where: { businessId: rec.businessId, status: "active", expiresAt: { gt: new Date() }, OR: [{ agentId: agent.id }, { mode: "share" }, ...(p.mode === "share" ? [{}] : [])] }, select: { id: true } });
    if (clash) return { clash: true as const };
    let now = 0;
    if (p.fromUnassigned && p.mode !== "share") {
      // Existing leads that belong to NOBODY (never another agent's), oldest first.
      const free = await tx.lead.findMany({ where: { businessId: rec.businessId, ownerUserId: null, status: "new", ...(p.source ? { source: p.source } : {}) }, orderBy: { createdAt: "asc" }, take: count, select: { id: true, contactId: true } });
      for (const l of free) {
        const u = await tx.lead.updateMany({ where: { id: l.id, ownerUserId: null }, data: { ownerUserId: agent.id } });
        if (!u.count) continue;
        await tx.contact.updateMany({ where: { id: l.contactId, ownerUserId: null }, data: { ownerUserId: agent.id } });
        if (p.listId) await tx.listLead.createMany({ data: [{ businessId: rec.businessId, listId: p.listId, contactId: l.contactId, preferredUserId: agent.id }], skipDuplicates: true });
        await audit(rec.businessId, ctx.by, "lead", l.id, "ai_ops.lead_allocated", { recommendationId: rec.id, agentId: agent.id, existing: true }, tx);
        now++;
      }
    }
    const remaining = p.mode === "share" ? count : count - now;
    const ov = remaining > 0 ? await tx.assignmentOverride.create({ data: { businessId: rec.businessId, recommendationId: rec.id, agentId: agent.id, mode: p.mode, sharePct: p.mode === "share" ? p.sharePct : 100, leadLimit: remaining, source: p.source, listId: p.listId, expiresAt: until, createdById: ctx.by, assigned: 0, total: 0 } }) : null;
    await tx.opsRecommendation.update({ where: { id }, data: { status: ov ? "active" : "completed", result: { ...((rec.result ?? {}) as object), approved: count, assignedNow: now, overrideId: ov?.id ?? null, note: ctx.note ?? null } as object } });
    return { clash: false as const, now, overrideId: ov?.id ?? null, remaining };
  });
  if (result.clash) return fail("כבר פעילה חלוקה זמנית אחרת שמתנגשת – אפשר לבטל אותה ולאשר שוב");
  await audit(rec.businessId, ctx.by, "ai_ops", id, "ai_ops.allocation_started", { approved: count, assignedNow: result.now, overrideId: result.overrideId, mode: p.mode, until });
  const tz = s.timezone;
  const txt = result.overrideId ? `✅ הופעלה הקצאה ל${agent.fullName}: ${p.mode === "share" ? `${p.sharePct}% מ-${count} הלידים הבאים` : `${count} לידים (${result.now ? `${result.now} הוקצו עכשיו, ` : ""}${result.remaining} מהלידים החדשים הבאים)`} עד ${hhmm(until, tz)}.` : `✅ הוקצו ל${agent.fullName} ${result.now} לידים.`;
  await tellManagers(rec.businessId, agent.id, `${txt} (בקשה ${rec.code})`);
  await send(rec.businessId, agent.id, `${txt} הם יופיעו אצלך ב-CRM ובתור החיוג.`, "הקצאה הופעלה");
  return { status: result.overrideId ? ("active" as const) : ("completed" as const), assignedNow: result.now, overrideId: result.overrideId };
}

async function expireRec(rec: OpsRecommendation, reason: string) {
  const r = await prisma.opsRecommendation.updateMany({ where: { id: rec.id, status: rec.status }, data: { status: "expired", result: { ...((rec.result ?? {}) as object), reason } as object } });
  if (!r.count) return;
  await audit(rec.businessId, null, "ai_ops", rec.id, "ai_ops.expired", { from: rec.status, reason });
  if (rec.status === "pending_agent") {
    await tellManagers(rec.businessId, rec.agentId, `⏱️ בקשה ${rec.code}: ${reason} – לא הוקצו לידים.`);
    if (rec.agentId) await send(rec.businessId, rec.agentId, `⏱️ פג תוקף הבקשה (${rec.code}) – לא הוקצו לידים.`, "עדכון מנהל AI");
  }
}

/** Manager cancels an allocation (or a pending request). Leads already assigned stay with the agent. */
export async function cancelRecommendation(user: SessionUser, id: string) {
  const rec = await prisma.opsRecommendation.findFirst({ where: { id, businessId: user.businessId } });
  if (!rec) throw new ApiError("לא נמצא", 404, "not_found");
  await assertManagerOf(user, rec.agentId);
  if (!["pending_manager", "pending_agent", "active", "needs_adjustment"].includes(rec.status)) throw new ApiError("אין מה לבטל", 409, "not_active");
  const r = await prisma.opsRecommendation.updateMany({ where: { id, status: rec.status }, data: { status: "cancelled", decidedById: rec.decidedById ?? user.id } });
  if (!r.count) throw new ApiError("כבר טופל", 409, "not_active");
  const ov = await prisma.assignmentOverride.updateMany({ where: { businessId: user.businessId, recommendationId: id, status: "active" }, data: { status: "cancelled", endedAt: new Date(), endedReason: `בוטל ע״י ${user.fullName}` } });
  await audit(user.businessId, user.id, "ai_ops", id, "ai_ops.cancelled", { from: rec.status, overrideCancelled: ov.count > 0 });
  if (rec.status === "pending_agent" && rec.agentId) await send(user.businessId, rec.agentId, `ℹ️ הבקשה ${rec.code} בוטלה ע״י המנהל – לא יוקצו לידים.`, "עדכון מנהל AI");
}

// ─── assignment hook (inside pickOwner's lock) ──────────────────────────────────────────────────────────────────
/**
 * Apply an active allocation to one new lead. `eligible` = agents the regular policy may use right now (active, in
 * the pool, under their cap and load rules); `regular` = who the regular policy picked. Returns the final owner and
 * whether the regular round-robin pointer should move (it does not when the lead was taken for an "extra" lead).
 */
export async function applyAllocation(tx: Prisma.TransactionClient, businessId: string, eligible: string[], regular: string, source: string | null) {
  const now = new Date();
  await tx.assignmentOverride.updateMany({ where: { businessId, status: "active", expiresAt: { lte: now } }, data: { status: "expired", endedAt: now, endedReason: "פג תוקף – חזרה לחלוקה הרגילה" } });
  const ov = await tx.assignmentOverride.findFirst({ where: { businessId, status: "active", expiresAt: { gt: now }, OR: [{ source: null }, ...(source ? [{ source }] : [])] }, orderBy: { createdAt: "asc" } });
  if (!ov || !eligible.includes(ov.agentId)) return { owner: regular, movePointer: true, overrideId: null as string | null, listId: null as string | null };
  let owner = regular; let movePointer = true; let toAgent = false;
  if (ov.mode === "priority") { owner = ov.agentId; toAgent = true; movePointer = regular === ov.agentId; }
  else if (ov.mode === "extra") { if (regular !== ov.agentId) { owner = ov.agentId; toAgent = true; movePointer = false; } }
  else {
    const due = Math.round((ov.sharePct / 100) * (ov.total + 1));
    if (ov.assigned < due) { owner = ov.agentId; toAgent = true; movePointer = regular === ov.agentId; }
    else if (regular === ov.agentId) { const others = eligible.filter((x) => x !== ov.agentId); if (others.length) owner = others[(ov.total) % others.length]; }
  }
  const assigned = ov.assigned + (toAgent ? 1 : 0); const total = ov.total + 1;
  const done = ov.mode === "share" ? total >= ov.leadLimit : assigned >= ov.leadLimit;
  await tx.assignmentOverride.update({ where: { id: ov.id }, data: { assigned, total, ...(done ? { status: "completed", endedAt: now, endedReason: "הושלמה הכמות שאושרה – חזרה לחלוקה הרגילה" } : {}) } });
  return { owner, movePointer, overrideId: toAgent ? ov.id : null, listId: toAgent ? ov.listId : null };
}

// ─── availability: agent not connected → alert / propose transfer ───────────────────────────────────────────────
export async function checkUnattendedAvailability(businessId: string, now = new Date()) {
  const rule = await ruleFor(businessId, "availability");
  if (!rule || rule.config.fallback === "none") return 0;
  const signals = await prisma.callbackSignal.findMany({ where: { businessId, status: "active", expiresAt: { gt: now }, requestedAt: { lte: new Date(now.getTime() - rule.config.unattendedAfterMinutes * 60_000) } }, take: 20 });
  let n = 0;
  for (const sig of signals) {
    if (!sig.userId || !sig.leadId) continue;
    const online = await prisma.dialerSession.findFirst({ where: { businessId, userId: sig.userId, status: "active", lastHeartbeatAt: { gte: new Date(now.getTime() - 3 * 60_000) } }, select: { id: true } });
    if (online) continue;
    const { agents } = await agentSnapshots(businessId, { now });
    const owner = agents.find((a) => a.id === sig.userId);
    const { effectiveAccess, can } = await import("@/lib/access/engine");
    let target: AgentSnapshot | null = null;
    if (rule.config.fallback === "transfer_to_available") {
      for (const a of agents.filter((x) => x.id !== sig.userId && x.online && !x.inCall && x.inPool && x.capOk).sort((x, y) => x.untouched - y.untouched)) {
        if (can(await effectiveAccess(businessId, a.id), "telephony.use")) { target = a; break; }
      }
    }
    const contact = await prisma.contact.findFirst({ where: { id: sig.contactId, businessId }, select: { fullName: true } });
    const title = `${contact?.fullName ?? "לקוח/ה"} כתב/ה שזמין/ה עכשיו – ${owner?.name ?? "הנציג"} לא מחובר/ת לחייגן`;
    const explanation = target ? `להעביר את הליד ל${target.name} (מחובר/ת, ${target.untouched} לידים שטרם טופלו) כדי שיחויג עכשיו? ההעברה כוללת את הקדימות.` : "אין כרגע נציג מחובר ופנוי שמורשה לחייגן. כדאי ליצור קשר עם הנציג.";
    try {
      const rec = await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: "availability_unattended", agentId: sig.userId, status: target ? "pending_manager" : "insight", code: code4(), title, explanation, evidence: { signalId: sig.id, text: sig.text, requestedAt: sig.requestedAt, ownerOnline: false } as object, proposal: { signalId: sig.id, leadId: sig.leadId, toAgentId: target?.id ?? null, toAgentName: target?.name ?? null } as object, dedupeKey: `avail:${sig.id}`, expiresAt: sig.expiresAt ?? new Date(now.getTime() + 15 * 60_000) } });
      n++;
      await notifyManagers(rec, `📲 ${title}\n${explanation}${target ? `\n\nלאישור השב: אשר ${rec.code}\nלדחייה: דחה ${rec.code}` : ""}`);
      if (target && rule.autonomy === "auto" && !(await requiresManager(businessId, "ownership"))) await managerDecision(null, rec.id, { action: "approve", via: "rule" });
    } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; }
  }
  return n;
}

async function approveAvailabilityTransfer(user: SessionUser | null, rec: OpsRecommendation, via: string) {
  const p = rec.proposal as { signalId: string; leadId: string; toAgentId: string | null };
  if (!p.toAgentId) throw new ApiError("אין נציג יעד", 409, "no_target");
  const sig = await prisma.callbackSignal.findFirst({ where: { id: p.signalId, businessId: rec.businessId } });
  if (!sig || sig.status !== "active" || !sig.expiresAt || sig.expiresAt <= new Date()) {
    await prisma.opsRecommendation.updateMany({ where: { id: rec.id, status: "pending_manager" }, data: { status: "expired" } });
    throw new ApiError("העדיפות כבר לא בתוקף", 409, "expired");
  }
  const claimed = await prisma.opsRecommendation.updateMany({ where: { id: rec.id, status: "pending_manager" }, data: { status: "executing", decidedById: user?.id ?? null, decidedAt: new Date(), decidedVia: via } });
  if (!claimed.count) throw new ApiError("ההמלצה כבר טופלה", 409, "not_pending");
  const actor = user ?? (await prisma.user.findFirst({ where: { businessId: rec.businessId, role: "owner", isActive: true }, select: { id: true, accountId: true, email: true, fullName: true, role: true, teamId: true } }).then((u) => (u ? { ...u, businessId: rec.businessId } : null)));
  if (!actor) throw new ApiError("אין מנהל פעיל", 409, "no_actor");
  const { transferLeads } = await import("@/lib/crm/lead-ops");
  const { withBusiness } = await import("@/lib/tenant");
  const r = await withBusiness(rec.businessId, () => transferLeads(actor as SessionUser, { leadIds: [p.leadId], toUserId: p.toAgentId! }), actor as SessionUser);
  const moved = r.transferred.includes(p.leadId);
  if (moved) await prisma.callbackSignal.update({ where: { id: sig.id }, data: { userId: p.toAgentId, reason: `הועבר לנציג זמין (${via})` } });
  await prisma.opsRecommendation.update({ where: { id: rec.id }, data: { status: moved ? "completed" : "failed", result: { transferred: moved, pending: r.pending.includes(p.leadId) } as object } });
  await audit(rec.businessId, user?.id ?? null, "ai_ops", rec.id, moved ? "ai_ops.transfer_executed" : "ai_ops.failed", { leadId: p.leadId, to: p.toAgentId, via });
  if (moved) await send(rec.businessId, p.toAgentId, `📲 הועבר אליך ליד שכתב/ה בוואטסאפ שזמין/ה עכשיו – הוא בראש התור שלך.`, "ליד זמין עכשיו");
  return { status: moved ? ("completed" as const) : ("failed" as const) };
}

// ─── tick (automations cron) ────────────────────────────────────────────────────────────────────────────────────
export async function runOpsTick(businessId: string, now = new Date()) {
  const s = await getBusinessSettings(businessId);
  if (!s.aiOps.enabled) return { processed: 0 };
  await ensureDefaultRules(businessId);
  let processed = 0;
  // Expired requests (no reply is never an approval).
  for (const rec of await prisma.opsRecommendation.findMany({ where: { businessId, status: { in: ["pending_manager", "pending_agent", "needs_adjustment"] }, expiresAt: { lte: now } } })) { await expireRec(rec, rec.status === "pending_agent" ? "לא התקבלה תשובה מהנציג בזמן" : "לא התקבלה החלטה בזמן"); processed++; }
  // Allocations that ended (expired / completed / cancelled) → the recommendation is completed; regular policy is back.
  await prisma.assignmentOverride.updateMany({ where: { businessId, status: "active", expiresAt: { lte: now } }, data: { status: "expired", endedAt: now, endedReason: "פג תוקף – חזרה לחלוקה הרגילה" } });
  for (const ov of await prisma.assignmentOverride.findMany({ where: { businessId, status: { in: ["completed", "expired"] }, recommendationId: { not: null }, updatedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } })) {
    const r = await prisma.opsRecommendation.updateMany({ where: { id: ov.recommendationId!, status: "active" }, data: { status: "completed" } });
    if (r.count) { processed++; await audit(businessId, null, "ai_ops", ov.recommendationId!, "ai_ops.allocation_ended", { overrideId: ov.id, reason: ov.endedReason, assigned: ov.assigned, total: ov.total }); }
  }
  processed += (await evaluateMomentum(businessId, now)).created;
  processed += await checkUnattendedAvailability(businessId, now);
  processed += await trackAllocatedLeads(businessId, now);
  return { processed };
}

/** Extra leads not handled and at risk of not being handled today → one alert to the manager (no auto transfer). */
async function trackAllocatedLeads(businessId: string, now: Date) {
  const recs = await prisma.opsRecommendation.findMany({ where: { businessId, kind: "momentum", status: { in: ["active", "completed"] }, updatedAt: { gte: new Date(now.getTime() - 16 * 3600_000) } } });
  let n = 0;
  for (const rec of recs) {
    const p = rec.proposal as unknown as Proposal;
    const until = p.until ? new Date(p.until) : null;
    if (!until || until <= now || until.getTime() - now.getTime() > 90 * 60_000) continue; // look only in the last 90 minutes of the shift
    const leads = await prisma.auditLog.findMany({ where: { businessId, action: "ai_ops.lead_allocated", payload: { path: ["recommendationId"], equals: rec.id } }, select: { entityId: true } });
    if (!leads.length) continue;
    const rows = await prisma.lead.findMany({ where: { id: { in: leads.map((l) => l.entityId) }, businessId }, select: { id: true, contactId: true, status: true } });
    const untouched = [];
    for (const l of rows) { const dialed = await prisma.call.findFirst({ where: { businessId, contactId: l.contactId, direction: "outbound", leadDialedAt: { not: null }, createdAt: { gte: rec.createdAt } }, select: { id: true } }); if (!dialed && l.status === "new") untouched.push(l.id); }
    if (!untouched.length) continue;
    try {
      const alert = await prisma.opsRecommendation.create({ data: { businessId, kind: "allocation_at_risk", agentId: rec.agentId, status: "insight", code: code4(), title: `${untouched.length} מהלידים הנוספים עדיין לא טופלו`, explanation: `נותרו פחות מ-90 דקות למשמרת (עד ${hhmm(until, (await getBusinessSettings(businessId)).timezone)}). הלידים לא יועברו אוטומטית – אפשר להעביר ידנית או לתאם עם הנציג.`, evidence: { recommendationId: rec.id, untouched } as object, proposal: {}, dedupeKey: `risk:${rec.id}`, expiresAt: until } });
      await notifyManagers(alert, `⚠️ ${alert.title} (${rec.title.split(":")[0]}). ${alert.explanation}`);
      n++;
    } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; }
  }
  return n;
}

// ─── WhatsApp replies (manager approvals / agent answers) ───────────────────────────────────────────────────────
/**
 * A verified, linked user's WhatsApp text → an ops decision, or null (not an ops reply – continue as usual).
 * Every answer is tied to ONE request: by its code, or – without a code – only when exactly one request is open for
 * this user. "כן" with several open requests never acts; it asks which one. Returns "" when handled with the
 * reply already sent.
 */
export async function opsWhatsAppReply(user: SessionUser, text: string): Promise<string | null> {
  const t = text.trim();
  const m = t.match(/^(אשר|מאשר|מאשרת|דחה|דוחה|כן|לא)\s*(\d{4})?[\s!.]*$/);
  const codeOnly = t.match(/\b(\d{4})\b/)?.[1] ?? null;
  // Agent side: requests addressed to this user.
  const mine = await prisma.opsRecommendation.findMany({ where: { businessId: user.businessId, agentId: user.id, status: "pending_agent", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } });
  if (mine.length) {
    const target = codeOnly ? mine.find((r) => r.code === codeOnly) : mine.length === 1 ? mine[0] : null;
    if (!target) return codeOnly ? null : `יש כמה בקשות פתוחות: ${mine.map((r) => r.code).join(", ")}. השב עם מספר הבקשה, למשל: "כן ${mine[0].code}" או "3 ${mine[0].code}".`;
    const cleaned = codeOnly ? t.replace(codeOnly, " ") : t;
    const ans = parseAgentAnswer(cleaned);
    try {
      const r = await agentDecision(user, target.id, ans, "whatsapp", t);
      if (r.status === "unclear") return `🤔 ${r.message} (בקשה ${target.code})`;
      if (r.status === "rejected") return "👍 הבנתי, לא יוקצו לידים נוספים היום.";
      // "" = handled; the allocation / adjustment message was already sent by the executor.
      return "";
    } catch (e) { return e instanceof ApiError ? `ℹ️ ${e.message}` : "⚠️ לא הצלחתי לעבד את התשובה – לא הוקצו לידים."; }
  }
  // Manager side.
  if (!m || (user.role !== "owner" && user.role !== "manager")) return null;
  const open = await prisma.opsRecommendation.findMany({ where: { businessId: user.businessId, status: "pending_manager", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } });
  const ids = await visibleUserIds(user);
  const visible = open.filter((r) => !ids || !r.agentId || ids.includes(r.agentId));
  if (!visible.length) return m[2] ? "לא נמצאה המלצה פתוחה עם המספר הזה." : null;
  const target = m[2] ? visible.find((r) => r.code === m[2]) : visible.length === 1 ? visible[0] : null;
  if (!target) return m[2] ? "לא נמצאה המלצה פתוחה עם המספר הזה." : `יש ${visible.length} המלצות פתוחות – לא מבצע בלי מספר:\n${visible.map((r) => `• ${r.code}: ${r.title}`).join("\n")}\nהשב למשל: "אשר ${visible[0].code}" או "דחה ${visible[0].code}".`;
  // Without a code, a pending AI-assistant action in the same chat makes "אשר" ambiguous → ask.
  if (!m[2]) {
    const pendingAi = await prisma.aiAction.count({ where: { businessId: user.businessId, requestedById: user.id, status: "proposed", channel: "whatsapp" } }).catch(() => 0);
    if (pendingAi) return `יש גם פעולה של העוזר שממתינה לאישור. כדי לאשר את המלצת מנהל AI השב "אשר ${target.code}".`;
  }
  const approve = /^(אשר|מאשר|מאשרת|כן)$/.test(m[1]);
  try {
    const r = await managerDecision(user, target.id, { action: approve ? "approve" : "reject", via: "whatsapp" });
    if (r.status === "rejected") return `❎ נדחה: ${target.title}`;
    if (r.status === "pending_agent") return `✅ אושר. נשלחה בקשה לנציג לאשר שיספיק לטפל בהם היום${"delivery" in r && r.delivery !== "sent" && r.delivery !== "template" ? " (לנציג אין וואטסאפ מאומת – הבקשה ממתינה לו במערכת)" : ""}. אעדכן כשיענה.`;
    return `סטטוס: ${STATUS_LABEL[r.status] ?? r.status}`;
  } catch (e) { return e instanceof ApiError ? `ℹ️ ${e.message}` : "⚠️ לא בוצע – נסה במערכת."; }
}
