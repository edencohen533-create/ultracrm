/** Scheduled follow-up → ask its offline owner → connect grace or explicitly authorised transfer.
 * Existing OpsRecommendation records provide durable state and per-occurrence deduplication.
 * No response or ambiguous response can authorise a transfer. No customer messages are sent here.
 */
import crypto from "node:crypto";
import { Prisma, type OpsRecommendation } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { type SessionUser, visibleUserIds } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { getBusinessSettings } from "@/lib/settings";
import { can, effectiveAccess } from "@/lib/access/engine";
import { ruleFor, requiresManager } from "./rules";
import { send, notifyManagers } from "./engine";

const KIND = "followup_checkin";
const OPEN = ["pending_agent", "waiting_connection", "pending_manager"];
type Proposal = { taskId: string; leadId: string; dueAt: string; version: number; ruleVersion: string; toAgentId?: string };
const proposal = (r: OpsRecommendation) => r.proposal as unknown as Proposal;
const json = (x: unknown) => x as Prisma.InputJsonValue;
const plus = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000);
export async function dialerOnline(businessId: string, userId: string, now = new Date()) {
  return Boolean(await prisma.dialerSession.findFirst({ where: { businessId, userId, status: "active", lastHeartbeatAt: { gte: plus(now, -3) }, user: { isActive: true } }, select: { id: true } }));
}
async function current(r: OpsRecommendation, now = new Date()) {
  const p = proposal(r);
  const rule = await ruleFor(r.businessId, KIND);
  if (!(await getBusinessSettings(r.businessId)).aiOps.enabled || !rule || rule.id !== r.ruleId || rule.updatedAt.toISOString() !== p.ruleVersion) return null;
  const task = await prisma.task.findFirst({ where: { id: p.taskId, businessId: r.businessId, leadId: p.leadId, userId: r.agentId!, status: "open", type: "callback", dueAt: new Date(p.dueAt), version: p.version, user: { isActive: true }, lead: { ownerUserId: r.agentId, status: { in: ["new", "contacted", "qualified", "follow_up"] }, pendingTransferToUserId: null } }, include: { contact: true } });
  if (!task || task.dueAt > now || task.contact.isBlocked || task.contact.consentStatus === "OPTED_OUT") return null;
  if (await prisma.dncEntry.findFirst({ where: { businessId: r.businessId, phoneE164: task.contact.phoneE164 } })) return null;
  return { task, rule };
}
async function finish(r: OpsRecommendation, status: string, reason: string, notify = false) {
  const changed = await prisma.opsRecommendation.updateMany({ where: { id: r.id, businessId: r.businessId, status: r.status }, data: { status, result: json({ ...(r.result as object ?? {}), reason }) } });
  if (changed.count) {
    await audit(r.businessId, null, "ai_ops", r.id, "ai_ops.followup_" + status, { reason });
    if (notify) await notifyManagers({ ...r, status }, "פולואפ: " + r.title + "\n" + reason + "\nלא בוצעה העברה.");
  }
  if (!changed.count) {
    const latest = await prisma.opsRecommendation.findUniqueOrThrow({ where: { id: r.id } });
    return { status: latest.status, message: "הבקשה כבר טופלה; המצב המעודכן מוצג במערכת." };
  }
  return { status, message: reason };
}
export function parseFollowupAnswer(text: string): "connect" | "transfer" | "unclear" {
  const t = text.trim().replace(/[!.,?]/g, "").replace(/\s+/g, " ");
  // Explicit allow-list; "כן"/"לא" cannot answer an either/or question safely.
  if (/^(אני )?(עולה|מתחבר|מתחברת)( עכשיו| לחייגן| מיד)?$/.test(t) || t === "connect") return "connect";
  if (/^(תעביר|תעבירו|להעביר)( את הליד)?( לנציג אחר| לנציגה אחרת)?$/.test(t) || t === "transfer") return "transfer";
  return "unclear";
}
async function chooseTarget(r: OpsRecommendation, manager?: SessionUser | null) {
  const ids = manager ? await visibleUserIds(manager) : null;
  const sessions = await prisma.dialerSession.findMany({ where: { businessId: r.businessId, status: "active", lastHeartbeatAt: { gte: plus(new Date(), -3) }, userId: { not: r.agentId!, ...(ids ? { in: ids } : {}) }, user: { isActive: true } }, orderBy: { lastHeartbeatAt: "desc" }, include: { user: true }, take: 100 });
  const { agents } = await (await import("./metrics")).agentSnapshots(r.businessId);
  for (const session of sessions) {
    const a = agents.find(x => x.id === session.userId);
    if (!a || a.inCall || !a.inPool || !a.capOk) continue;
    const access = await effectiveAccess(r.businessId, session.userId);
    if (!can(access, "telephony.use") || !can(access, "crm.view")) continue;
    const task = await prisma.task.findFirst({ where: { id: proposal(r).taskId, businessId: r.businessId }, include: { listLead: { select: { listId: true } } } });
    if (task?.listLead?.listId) {
      try { await (await import("@/lib/dialer/queue")).assertListAccess(r.businessId, session.userId, session.user.role, task.listLead.listId); } catch { continue; }
    }
    return session.user;
  }
  return null;
}

export async function approveFollowupTransfer(manager: SessionUser | null, r: OpsRecommendation, via = manager ? "app" : "rule") {
  const c = await current(r);
  if (!c || r.expiresAt <= new Date()) return finish(r, "cancelled", "הכלל או הפולואפ השתנו, או שפג תוקף הבקשה.");
  if (r.status !== "pending_manager" || !r.agentRespondedAt || parseFollowupAnswer(r.agentReply ?? "") !== "transfer") throw new ApiError("אין בקשת העברה מפורשת ופעילה מהנציג", 409, "not_pending");
  if (!manager && (c.rule.autonomy !== "auto" || await requiresManager(r.businessId, "ownership"))) return { status: "pending_manager", message: "בקשת ההעברה ממתינה לאישור מנהל." };
  if (await dialerOnline(r.businessId, r.agentId!)) return finish(r, "cancelled", "הנציג כבר התחבר; הליד נשאר אצלו.");
  const target = await chooseTarget(r, manager);
  if (!target) return finish(r, "needs_adjustment", "אין כרגע נציג מחובר ומורשה עם קיבולת; נדרש טיפול מנהל.", true);
  const actor = manager ?? await prisma.user.findFirst({ where: { businessId: r.businessId, role: "owner", isActive: true } });
  if (!actor) return finish(r, "needs_adjustment", "אין בעלים פעיל שמורשה לבצע את הכלל.", true);
  const { transferFollowupFromRule } = await import("@/lib/crm/lead-ops");
  const moved = await transferFollowupFromRule(actor, target.id, r, !manager, via);
  if (!moved) return finish(r, "cancelled", "מצב הפולואפ, השיחה או הנציג השתנה; לא בוצעה העברה.");
  await send(r.businessId, target.id, "הועבר אליך פולואפ שהגיע זמנו. הוא מופיע במשימות ובתור האישי שלך.", "פולואפ הועבר אליך");
  return { status: "completed", message: "הפולואפ הועבר ל" + target.fullName + "." };
}

export async function answerFollowup(user: SessionUser, id: string, text: string, via: "app" | "whatsapp") {
  const r = await prisma.opsRecommendation.findFirst({ where: { id, businessId: user.businessId, agentId: user.id, kind: KIND } });
  if (!r) throw new ApiError("הבקשה לא נמצאה", 404, "not_found");
  if (r.status !== "pending_agent") throw new ApiError("הבקשה כבר טופלה", 409, "not_pending");
  const c = await current(r);
  if (!c) return finish(r, "cancelled", "הפולואפ או הכלל השתנו; הבקשה בוטלה.");
  if (r.expiresAt <= new Date()) return finish(r, "expired", "חלף הזמן לתשובה; הליד לא הועבר.", true);
  const answer = parseFollowupAnswer(text);
  if (answer === "unclear") return { status: "unclear", message: 'לא ברור איזו אפשרות בחרת. השב "מתחבר" או "תעבירו", בצירוף מספר הבקשה ' + r.code + ". לא בוצעה פעולה." };
  const now = new Date();
  const status = answer === "connect" ? "waiting_connection" : "pending_manager";
  const changed = await prisma.opsRecommendation.updateMany({ where: { id, status: "pending_agent", expiresAt: { gt: now } }, data: { status, agentRespondedAt: now, agentReply: answer, expiresAt: plus(now, answer === "connect" ? c.rule.config.connectMinutes : c.rule.config.requestMinutes), decidedVia: via } });
  if (!changed.count) throw new ApiError("הבקשה כבר טופלה או פג תוקפה", 409, "not_pending");
  await audit(user.businessId, user.id, "ai_ops", id, "ai_ops.followup_answer", { answer, via });
  const updated = await prisma.opsRecommendation.findUniqueOrThrow({ where: { id } });
  if (answer === "connect") return { status, message: "הליד נשאר אצלך. נבדוק שהתחברת לחייגן בתוך " + c.rule.config.connectMinutes + " דקות." };
  if (c.rule.autonomy === "auto" && !(await requiresManager(user.businessId, "ownership"))) return approveFollowupTransfer(null, updated);
  await notifyManagers(updated, "הנציג ביקש להעביר פולואפ: " + r.title + "\nלאישור: אשר " + r.code + "\nלדחייה: דחה " + r.code);
  return { status, message: "בקשת ההעברה נשלחה לאישור מנהל. הליד טרם הועבר." };
}

export async function runFollowupCheckins(businessId: string, now = new Date()) {
  let processed = 0;
  for (const r of await prisma.opsRecommendation.findMany({ where: { businessId, kind: KIND, status: { in: OPEN } } })) {
    if (!(await current(r, now))) { await finish(r, "cancelled", "הפולואפ או הכלל השתנו; הבקשה בוטלה."); processed++; }
    else if (await dialerOnline(businessId, r.agentId!, now)) { await finish(r, "completed", "הנציג התחבר לחייגן; הליד נשאר אצלו. הטיפול בליד עדיין נדרש."); processed++; }
    else if (r.expiresAt <= now) { await finish(r, "expired", r.status === "waiting_connection" ? "הנציג אמר שיתחבר אך לא התחבר בזמן; נדרש טיפול מנהל." : "לא התקבלה החלטה בזמן; נדרש טיפול מנהל.", true); processed++; }
  }
  const rule = await ruleFor(businessId, KIND);
  const settings = await getBusinessSettings(businessId);
  if (!rule || !settings.aiOps.enabled) return processed;
  let cursor: string | undefined;
  while (true) {
  const tasks = await prisma.task.findMany({ where: { businessId, type: "callback", status: "open", dueAt: { lte: now, gte: plus(now, -24 * 60) }, leadId: { not: null }, user: { isActive: true }, lead: { status: { in: ["new", "contacted", "qualified", "follow_up"] }, pendingTransferToUserId: null } }, include: { lead: true, contact: true }, orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  for (const t of tasks) {
    if (t.lead?.ownerUserId !== t.userId || t.contact.isBlocked || t.contact.consentStatus === "OPTED_OUT" || await dialerOnline(businessId, t.userId, now)) continue;
    if (await prisma.dncEntry.findFirst({ where: { businessId, phoneE164: t.contact.phoneE164 } })) continue;
    const dedupeKey = "followup:" + t.id + ":" + t.dueAt.toISOString() + ":" + t.version;
    if (await prisma.opsRecommendation.findUnique({ where: { businessId_dedupeKey: { businessId, dedupeKey } } })) continue;
    const count = await prisma.opsRecommendation.count({ where: { businessId, kind: KIND, agentId: t.userId, createdAt: { gte: plus(now, -1440) } } });
    if (count >= settings.aiOps.maxAlertsPerDay) continue;
    const code = String(crypto.randomInt(1000, 10000));
    const text = "היי, הגיע הפולואפ עם " + t.contact.fullName + " ואתה לא מחובר לחייגן. אתה עולה לחייגן או שנעביר את הליד לנציג אחר?\nהשב: מתחבר " + code + " / תעבירו " + code + "\nממתינים לתשובה " + rule.config.requestMinutes + " דקות. ללא תשובה נעדכן מנהל ולא נעביר אוטומטית.";
    let r: OpsRecommendation;
    try {
      r = await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: KIND, agentId: t.userId, status: "pending_agent", code, title: "פולואפ: " + t.contact.fullName, explanation: text, evidence: json({ dueAt: t.dueAt.toISOString(), ownerOnline: false }), proposal: json({ taskId: t.id, leadId: t.leadId, dueAt: t.dueAt.toISOString(), version: t.version, ruleVersion: rule.updatedAt.toISOString() }), dedupeKey, expiresAt: plus(now, rule.config.requestMinutes), agentAskedAt: now } });
    } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; throw e; }
    const delivery = await send(businessId, t.userId, text, "פולואפ ממתין לתשובתך");
    await prisma.opsRecommendation.updateMany({ where: { id: r.id, status: "pending_agent" }, data: { result: json({ agentRequest: { text, delivery: delivery.status, detail: delivery.detail ?? null } }) } });
    await audit(businessId, null, "ai_ops", r.id, "ai_ops.followup_asked", { taskId: t.id, delivery: delivery.status });
    if (delivery.status === "failed" || delivery.status === "skipped") await notifyManagers(r, "לא ניתן לשלוח לנציג את בקשת הפולואפ בוואטסאפ: " + (delivery.detail ?? delivery.status) + ". הבקשה זמינה לו במערכת.");
    processed++;
  }
  if (tasks.length < 100) break;
  cursor = tasks[tasks.length - 1].id;
  }
  return processed;
}
