/**
 * Diagnose & repair. A diagnosis only READS real evidence (automation version, domain events, journey runs and their
 * log, template status and variables, WhatsApp connection, suppression/consent, message delivery, dial-queue rows,
 * locks, transfers) and classifies what happened – it never guesses a cause that the data does not show.
 * Every diagnosis is stored as an AiIncident. Repairs come ONLY from the catalog below, are proposed as AiActions
 * (limited, reversible ones may run automatically when the policy allows; behaviour-changing ones need approval),
 * snapshot the previous state, verify that nothing changed since the diagnosis and are re-validated afterwards.
 * Code bugs are never "fixed" from the chat – the evidence is collected as a bug report. Access problems are never
 * "fixed" by widening permissions. Everything handed to the model is redacted (phones/emails/tokens).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { templateParameterKeys } from "@/lib/campaigns";
import { executeAction, proposeAction, registerExecutor } from "./actions";
import { canManage } from "./settings";
import type { AiCtx, ToolDef } from "./tools";

export const INCIDENT_STATUS = {
  diagnosed: "אובחנה",
  approval_required: "נדרש אישור",
  fixed_verified: "בוצע ואומת",
  fixed_pending: "בוצע – ממתין לאימות",
  external: "נדרש תיקון קוד או טיפול חיצוני",
  escalated: "הועבר למנהל",
  no_issue: "לא נמצאה תקלה",
} as const;
type IncidentStatus = keyof typeof INCIDENT_STATUS;

// ─── redaction (before anything reaches the model / the incident log) ───────────────────────────────────────────
export function redact(v: unknown): unknown {
  if (typeof v === "string") return v
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s-]{6,}(\d{4})/g, "***$1")
    .replace(/\b(?:EAA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/g, "[secret]");
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !/token|secret|password|apiKey|accessToken|config/i.test(k)).map(([k, x]) => [k, redact(x)]));
  return v;
}

export const DIAGNOSE_TOOL_DEFS: ToolDef[] = [
  { name: "diagnose_automation", description: "בדיקה למה אוטומציה לא פעלה / הודעה לא נשלחה ללקוח: בודק גרסה ומצב האוטומציה, אירוע הטריגר, תנאים, ריצה, תבנית ומשתנים, חיבור WhatsApp, הסרה/הסכמה ומסירה. מחזיר סיווג: not_triggered / skipped / failed_send / sent_not_delivered / delivered / scheduled.", input_schema: { type: "object", properties: { leadId: { type: "string", description: "מ-find_lead" }, automationId: { type: "string", description: "אופציונלי – מ-list_automations" }, question: { type: "string" } }, required: ["leadId"] } },
  { name: "diagnose_messaging", description: "בדיקת הודעות אחרונות ללקוח: סטטוס מסירה, שגיאת ספק, חיבור הערוץ, הסרה/הסכמה.", input_schema: { type: "object", properties: { leadId: { type: "string" }, question: { type: "string" } }, required: ["leadId"] } },
  { name: "diagnose_lead", description: "בדיקת ליד: למה לא מופיע בחייגן/ברשימה, פולואפ שלא עלה, שיוך והעברה, נעילה תקועה, חסימה, חלון חיוג.", input_schema: { type: "object", properties: { leadId: { type: "string" }, question: { type: "string" } }, required: ["leadId"] } },
  { name: "diagnose_missing_lead", description: "כשמשתמש לא מוצא ליד (למשל 'למה אני לא רואה את הליד של 050...'): בודק רק בתחום ההרשאות של המשתמש, לעולם לא מרחיב הרשאות.", input_schema: { type: "object", properties: { phoneOrName: { type: "string" } }, required: ["phoneOrName"] } },
  { name: "apply_repair", description: "ביצוע תיקון שהוצע באבחון (לפי actionId). תיקון שדורש אישור יוצג לאישור – אין לדווח שבוצע לפני שהשרת אישר.", input_schema: { type: "object", properties: { actionId: { type: "string" } }, required: ["actionId"] } },
  { name: "propose_repair", description: "הצעת תיקון מהקטלוג בלבד על אבחון קיים: set_step_variable {automationId, stepPosition, key, value} (מילוי משתנה חסר), relink_template {automationId, stepPosition, templateName}.", input_schema: { type: "object", properties: { incidentId: { type: "string" }, repair: { type: "string", enum: ["set_step_variable", "relink_template"] }, params: { type: "object" } }, required: ["incidentId", "repair", "params"] }, managerOnly: true },
  { name: "escalate_to_manager", description: "נציג: העברת אבחון למנהל כשנדרש תיקון משותף.", input_schema: { type: "object", properties: { incidentId: { type: "string" }, note: { type: "string" } }, required: ["incidentId"] } },
  { name: "list_incidents", description: "היסטוריית אבחונים ותקלות אחרונות.", input_schema: { type: "object", properties: {} } },
];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function scopedLead(user: SessionUser, leadId: string) {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId: user.businessId, ...ownerScope(ids) }, include: { contact: { select: { id: true, fullName: true, phoneE164: true, consentStatus: true, isBlocked: true, ownerUserId: true } }, owner: { select: { id: true, fullName: true } } } });
  if (!lead) throw new ApiError("הליד לא נמצא או שאין הרשאה אליו", 404, "not_found");
  return lead;
}

async function saveIncident(user: SessionUser, module: string, question: string, status: IncidentStatus, findings: Record<string, unknown>) {
  return prisma.aiIncident.create({ data: { businessId: user.businessId, requestedById: user.id, module, question: String(question || module).slice(0, 500), status, findings: redact(findings) as Prisma.InputJsonValue } });
}

async function channelHealth() {
  const creds = await prisma.providerCredential.findMany({ where: { channel: "whatsapp" }, select: { id: true, label: true, displayPhoneNumber: true, status: true, isActive: true, sendingBlocked: true, lastConnectionError: true, qualityRating: true } });
  const usable = creds.filter((c) => c.isActive && c.status === "connected" && !c.sendingBlocked);
  return { usable: usable.length > 0, channels: creds.map((c) => ({ label: c.label ?? c.displayPhoneNumber, status: c.status, active: c.isActive, blocked: c.sendingBlocked, error: c.lastConnectionError, quality: c.qualityRating })) };
}

const MSG_OK = ["ACCEPTED", "SENT", "DELIVERED", "READ"];

// ─── automation diagnosis ────────────────────────────────────────────────────────────────────────────────────────
type Finding = { check: string; ok: boolean | null; detail: string };
export async function diagnoseAutomation(ctx: AiCtx, leadId: string, automationId?: string, question = "") {
  const lead = await scopedLead(ctx.user, leadId);
  const contactId = lead.contactId;
  const seqs = await prisma.marketingSequence.findMany({ where: { businessId: ctx.user.businessId, ...(automationId ? { id: automationId } : {}) }, include: { steps: { orderBy: { position: "asc" }, include: { template: { select: { id: true, name: true, status: true, body: true, language: true } } } } }, orderBy: { updatedAt: "desc" }, take: automationId ? 1 : 10 });
  if (!seqs.length) return { incident: await saveIncident(ctx.user, "automations", question, "no_issue", { summary: "אין אוטומציות בעסק" }), classification: "no_automation", summary: "לא הוגדרו אוטומציות בעסק." };
  const health = await channelHealth();
  const { sendBlockReason } = await import("@/lib/suppression");
  const block = await sendBlockReason(ctx.user.businessId, contactId, "marketing");
  const since = new Date(Date.now() - 30 * 86400_000);
  const results = [];
  const repairs: Array<{ kind: string; params: Record<string, unknown>; summary: string; impact?: string; approval: boolean }> = [];
  let external: string | null = null;
  for (const seq of seqs) {
    const f: Finding[] = [];
    const cfg = (seq.triggerConfig ?? {}) as { leadStatus?: string; minAttempts?: number; tagName?: string };
    f.push({ check: "מצב האוטומציה", ok: seq.isActive, detail: seq.isActive ? `פעילה (גרסה ${seq.updatedAt.toISOString()})` : "כבויה/טיוטה – לא מופעלת על אירועים" });
    // trigger event for this contact
    const evType = seq.trigger === "LEAD_STATUS_CHANGED" ? "lead.status_changed" : seq.trigger === "CALL_UNANSWERED" ? "call.outcome_saved" : seq.trigger === "CONTACT_CREATED" ? "contact.created" : seq.trigger === "TAG_ADDED" ? "contact.tag_added" : seq.trigger === "CART_ABANDONED" ? "cart.abandoned" : null;
    const events = evType ? await prisma.domainEvent.findMany({ where: { businessId: ctx.user.businessId, contactId, type: evType, occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" }, take: 10, select: { id: true, status: true, occurredAt: true, payload: true, lastError: true, attempts: true } }) : [];
    const matching = events.filter((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (seq.trigger === "LEAD_STATUS_CHANGED") return !cfg.leadStatus || p.to === cfg.leadStatus;
      if (seq.trigger === "CALL_UNANSWERED") return ["no_answer", "busy"].includes(String(p.outcome));
      if (seq.trigger === "TAG_ADDED") return !cfg.tagName || p.tagName === cfg.tagName;
      return true;
    });
    f.push({ check: "אירוע טריגר (30 יום)", ok: matching.length > 0, detail: matching.length ? `${matching.length} אירועים מתאימים, האחרון ${matching[0].occurredAt.toISOString()} (${matching[0].status})` : events.length ? `נמצאו ${events.length} אירועים מסוג ${evType} אך לא בתנאי הטריגר (${seq.trigger === "LEAD_STATUS_CHANGED" ? `סטטוס יעד ${cfg.leadStatus}; בפועל: ${events.map((e) => String((e.payload as { to?: string }).to)).join(", ")}` : "תנאי לא התקיים"})` : `לא נרשם אירוע ${evType ?? seq.trigger} ללקוח הזה` });
    const failedEv = matching.find((e) => e.status === "failed" || (e.status === "pending" && e.attempts > 0));
    if (failedEv) { f.push({ check: "עיבוד האירוע", ok: false, detail: `האירוע ${failedEv.status} אחרי ${failedEv.attempts} ניסיונות: ${failedEv.lastError ?? ""}` }); external = `כשל בעיבוד אירוע ${failedEv.id}: ${failedEv.lastError ?? "ללא הודעה"}`; }
    // run
    const runs = await prisma.sequenceRun.findMany({ where: { sequenceId: seq.id, contactId }, orderBy: { startedAt: "desc" }, take: 3 });
    const run = runs[0];
    // templates and variables (current version)
    for (const st of seq.steps.filter((s) => s.action === "send")) {
      const t = st.template;
      if (!t) { f.push({ check: `תבנית בשלב ${st.position + 1}`, ok: false, detail: "לא מקושרת תבנית" }); continue; }
      f.push({ check: `תבנית "${t.name}" בשלב ${st.position + 1}`, ok: t.status === "APPROVED", detail: t.status === "APPROVED" ? "מאושרת" : `סטטוס ${t.status}` });
      if (t.status !== "APPROVED") {
        const alt = await prisma.template.findFirst({ where: { businessId: ctx.user.businessId, channel: st.channel, name: t.name, status: "APPROVED", NOT: { id: t.id } }, select: { id: true, language: true } });
        if (alt) repairs.push({ kind: "relink_template", params: { automationId: seq.id, stepPosition: st.position, templateId: alt.id, fromTemplateId: t.id, versionAt: seq.updatedAt.toISOString() }, summary: `קישור שלב ${st.position + 1} ב"${seq.name}" לגרסה המאושרת של "${t.name}" (${alt.language})`, approval: true });
      }
      const vars = (st.variables ?? {}) as Record<string, string>;
      const missing = templateParameterKeys(t.body).filter((k) => !String(vars[k] ?? "").trim());
      if (missing.length) f.push({ check: `משתני התבנית בשלב ${st.position + 1}`, ok: false, detail: `חסרים ערכים: ${missing.map((k) => `{{${k}}}`).join(", ")} – ניתן להציע set_step_variable` });
    }
    if (seq.steps.some((s) => s.action === "send" && s.channel === "whatsapp")) f.push({ check: "חיבור WhatsApp", ok: health.usable, detail: health.usable ? "יש ערוץ מחובר ופעיל" : `אין ערוץ שמיש: ${health.channels.map((c) => `${c.label ?? "?"}: ${c.status}${c.blocked ? " (שליחה חסומה)" : ""}`).join("; ") || "לא הוגדר ערוץ"}` });
    if (seq.steps.some((s) => s.action === "send")) f.push({ check: "הסכמה והסרה", ok: !block, detail: block ?? "הלקוח רשאי לקבל דיוור" });
    // classification from real evidence
    let cls: string; let why: string;
    if (!run) {
      cls = "not_triggered";
      why = !matching.length ? "לא התרחש אירוע שעומד בתנאי הטריגר" : !seq.isActive ? "האוטומציה לא הייתה פעילה" : matching[0].occurredAt < seq.updatedAt ? "האירוע קרה לפני הגרסה הנוכחית/ההפעלה של האוטומציה – אוטומציות פועלות רק על אירועים חדשים" : failedEv ? "עיבוד האירוע נכשל" : matching[0].status === "pending" ? "האירוע עדיין ממתין לעיבוד" : "האירוע עובד אך לא נוצרה ריצה (למשל תנאי ניסיונות/מקור לא התקיים)";
    } else {
      const log = (Array.isArray(run.log) ? run.log : []) as Array<{ step?: number; messageId?: string | null; skipped?: string | null; at?: string }>;
      const msgIds = log.map((l) => l.messageId).filter(Boolean) as string[];
      const msgs = msgIds.length ? await prisma.message.findMany({ where: { id: { in: msgIds } }, select: { id: true, status: true, errorReason: true, errorCode: true, sentAt: true, deliveredAt: true, readAt: true } }) : [];
      const skippedSteps = log.filter((l) => l.skipped);
      f.push({ check: "ריצה", ok: run.status !== "FAILED", detail: `${run.status}${run.stopReason ? ` – ${run.stopReason}` : ""}; שלב ${run.stepIndex + 1}; התחילה ${run.startedAt.toISOString()}${run.status === "PENDING" ? `; הצעד הבא ${run.nextAt.toISOString()}` : ""}` });
      if (skippedSteps.length) f.push({ check: "שלבים שדולגו", ok: false, detail: skippedSteps.map((s) => `שלב ${(s.step ?? 0) + 1}: ${s.skipped}`).join("; ") });
      for (const m of msgs) f.push({ check: "מסירה", ok: m.status === "DELIVERED" || m.status === "READ", detail: `${m.status}${m.errorReason ? ` – ${m.errorReason}` : ""}${m.errorCode ? ` (${m.errorCode})` : ""}` });
      const failedMsg = msgs.find((m) => m.status === "FAILED");
      if (run.status === "FAILED") {
        cls = "failed_send"; why = run.stopReason ?? "הריצה נכשלה";
        const alreadySent = await prisma.message.count({ where: { requestKey: { startsWith: `seq:${run.id}:` }, status: { in: MSG_OK as never } } });
        if (!alreadySent) repairs.push({ kind: "retry_failed_run", params: { runId: run.id, automationId: seq.id }, summary: `ניסיון חוזר לריצה שנכשלה של "${seq.name}" עבור ${lead.contact.fullName}`, impact: "ישלח הודעה אמיתית ללקוח אחד (אם הוא עדיין רשאי לקבל דיוור).", approval: true });
        if (!/תבנית|הסכמה|הוסר|חסום|WhatsApp|ערוץ/.test(why)) external = external ?? `ריצה ${run.id} נכשלה: ${why}`;
      } else if (failedMsg) { cls = "failed_send"; why = failedMsg.errorReason ?? "הספק דחה את ההודעה"; }
      else if (msgs.some((m) => m.status === "DELIVERED" || m.status === "READ")) { cls = "delivered"; why = "ההודעה נמסרה ללקוח (לפי אישור הספק)"; }
      else if (msgs.length) { cls = "sent_not_delivered"; why = "ההודעה נשלחה אך הספק עוד לא דיווח על מסירה"; }
      else if (run.status === "STOPPED" || skippedSteps.length) { cls = "skipped"; why = run.stopReason ?? skippedSteps[0]?.skipped ?? "דולג"; }
      else if (run.status === "PENDING" || run.status === "RUNNING") { cls = "scheduled"; why = `השלב הבא מתוזמן ל-${run.nextAt.toISOString()}`; }
      else { cls = "completed_no_send"; why = "הריצה הסתיימה ללא הודעה (שלבים שאינם שליחה)"; }
    }
    results.push({ automationId: seq.id, name: seq.name, active: seq.isActive, classification: cls, reason: why, findings: f });
  }
  // the most relevant automation = the one with a run or a matching event
  const rank = (c: string) => ["failed_send", "skipped", "sent_not_delivered", "not_triggered", "scheduled", "delivered", "completed_no_send"].indexOf(c);
  results.sort((a, b) => rank(a.classification) - rank(b.classification));
  const main = automationId ? results[0] : results.find((r) => r.classification !== "not_triggered" || r.findings.some((x) => x.check.startsWith("אירוע") && x.ok)) ?? results[0];
  const status: IncidentStatus = repairs.length ? "approval_required" : external ? "external" : main.classification === "delivered" ? "no_issue" : "diagnosed";
  const incident = await saveIncident(ctx.user, "automations", question, status, { lead: { id: lead.id, name: lead.contact.fullName }, main: main.automationId, results, bugReport: external });
  const actionIds = await proposeRepairs(ctx, incident.id, repairs);
  return { incidentId: incident.id, status: INCIDENT_STATUS[status], lead: lead.contact.fullName, classification: main.classification, reason: main.reason, automations: redact(results), repairs: repairs.map((r) => r.summary), actionIds, codeOrExternal: external ? "נאסף תיעוד לדיווח תקלה – תיקון קוד מתבצע רק בענף פיתוח עם בדיקות, לא מהצ׳אט" : null, note: "אין לשלוח מחדש הודעות שהוחמצו אוטומטית – אפשר להציע זאת בנפרד עם ספירה ואישור." };
}

// ─── messaging diagnosis ─────────────────────────────────────────────────────────────────────────────────────────
export async function diagnoseMessaging(ctx: AiCtx, leadId: string, question = "") {
  const lead = await scopedLead(ctx.user, leadId);
  const msgs = await prisma.message.findMany({ where: { conversation: { contactId: lead.contactId }, direction: "OUTBOUND" }, orderBy: { createdAt: "desc" }, take: 10, select: { createdAt: true, channel: true, category: true, status: true, errorReason: true, errorCode: true, deliveredAt: true, readAt: true, template: { select: { name: true } } } });
  const health = await channelHealth();
  const { sendBlockReason } = await import("@/lib/suppression");
  const [mk, sv] = await Promise.all([sendBlockReason(ctx.user.businessId, lead.contactId, "marketing"), sendBlockReason(ctx.user.businessId, lead.contactId, "service")]);
  const lastIn = await prisma.message.findFirst({ where: { conversation: { contactId: lead.contactId }, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const windowOpen = Boolean(lastIn && Date.now() - lastIn.createdAt.getTime() < 24 * 3600_000);
  const failed = msgs.filter((m) => m.status === "FAILED");
  const findings = {
    channel: health, marketingBlocked: mk, serviceBlocked: sv, serviceWindowOpen: windowOpen,
    messages: msgs.map((m) => ({ at: m.createdAt, channel: m.channel, category: m.category, template: m.template?.name ?? null, status: m.status, error: m.errorReason, code: m.errorCode })),
  };
  const status: IncidentStatus = !health.usable ? "external" : failed.length ? "diagnosed" : "no_issue";
  const incident = await saveIncident(ctx.user, "messaging", question, status, { lead: { id: lead.id }, ...findings });
  return { incidentId: incident.id, status: INCIDENT_STATUS[status], ...(redact(findings) as object), summary: !health.usable ? "אין ערוץ WhatsApp מחובר ופעיל – נדרש חיבור" : failed.length ? `${failed.length} הודעות נכשלו; שגיאת הספק האחרונה: ${failed[0].errorReason ?? failed[0].errorCode ?? "לא צוינה"}` : msgs.length ? "לא נמצאו כשלים בהודעות האחרונות" : "לא נשלחו הודעות ללקוח זה" };
}

// ─── lead / dialer / follow-ups diagnosis ────────────────────────────────────────────────────────────────────────
export async function diagnoseLead(ctx: AiCtx, leadId: string, question = "") {
  const lead = await scopedLead(ctx.user, leadId);
  const f: Finding[] = []; const repairs: Array<{ kind: string; params: Record<string, unknown>; summary: string; impact?: string; approval: boolean }> = [];
  f.push({ check: "סטטוס ושיוך", ok: null, detail: `סטטוס ${lead.status}; משויך ל${lead.owner?.fullName ?? "אף אחד (לא יחויג אוטומטית עד שיוך)"}` });
  if (lead.pendingTransferToUserId) f.push({ check: "העברה ממתינה", ok: false, detail: `הליד ממתין להעברה מאז ${lead.pendingTransferAt?.toISOString()} – לא יחויג עד שההעברה תושלם (בסיום השיחה הפעילה)` });
  const dnc = await prisma.dncEntry.findFirst({ where: { phoneE164: lead.contact.phoneE164 }, select: { id: true } });
  if (dnc) f.push({ check: "חסימת חיוג", ok: false, detail: "המספר ברשימת אל-תתקשר – לא יחויג" });
  const tasks = await prisma.task.findMany({ where: { contactId: lead.contactId, status: "open", type: "callback" }, orderBy: { dueAt: "asc" }, take: 3, select: { id: true, dueAt: true, userId: true } });
  f.push({ check: "פולואפ פתוח", ok: null, detail: tasks.length ? `${tasks.length} פתוחים, הקרוב ${tasks[0].dueAt.toISOString()}${tasks[0].dueAt > new Date() ? " (עתידי – לא יחויג לפני המועד)" : " (הגיע מועדו)"}` : lead.status === "follow_up" ? "סטטוס פולואפ ללא מועד – לא ייכנס לתור עד שייקבע מועד" : "אין" });
  const rows = await prisma.listLead.findMany({ where: { contactId: lead.contactId }, select: { id: true, status: true, nextAttemptAt: true, lockExpiresAt: true, lockedByUserId: true, lastSkipReason: true, attempts: true, list: { select: { id: true, name: true, isActive: true, filterJson: true } } } });
  f.push({ check: "תורי חיוג", ok: rows.length > 0, detail: rows.length ? rows.map((r) => `${r.list.name}${r.list.isActive ? "" : " (רשימה כבויה)"}: ${r.status}, ניסיונות ${r.attempts}${r.nextAttemptAt ? `, מוקדם ביותר ${r.nextAttemptAt.toISOString()}` : ""}${r.lastSkipReason ? `, דילוג: ${r.lastSkipReason}` : ""}`).join(" · ") : "הליד אינו באף רשימת חיוג" });
  const stale = rows.filter((r) => (r.status === "locked" || r.lockedByUserId) && r.lockExpiresAt && r.lockExpiresAt < new Date(Date.now() - 60_000));
  if (stale.length) {
    const live = await prisma.call.count({ where: { contactId: lead.contactId, endedAt: null, createdAt: { gt: new Date(Date.now() - 2 * 3600_000) } } });
    if (!live) { f.push({ check: "נעילה תקועה", ok: false, detail: `${stale.length} שורות נעולות שפג תוקפן ללא שיחה פעילה` }); repairs.push({ kind: "release_stale_lock", params: { listLeadIds: stale.map((r) => r.id), contactId: lead.contactId }, summary: `שחרור נעילה תקועה של ${lead.contact.fullName} בתור החיוג`, approval: false }); }
  }
  if (tasks.length && lead.ownerUserId) {
    const { personalListId } = await import("@/lib/crm/lead-ops");
    const pid = await personalListId(prisma, ctx.user.businessId, tasks[0].userId);
    const inPersonal = pid && rows.some((r) => r.list.id === pid && r.status === "callback");
    if (pid && !inPersonal && !dnc) { f.push({ check: "פולואפ בתור האישי", ok: false, detail: "יש פולואפ פתוח אבל הוא לא בתור האישי של הנציג" }); repairs.push({ kind: "resync_followups", params: { contactId: lead.contactId }, summary: `סנכרון הפולואפ של ${lead.contact.fullName} לתור החיוג`, approval: false }); }
    else if (!pid) f.push({ check: "תור אישי", ok: false, detail: "לנציג אין רשימת חיוג אישית – יש לפתוח חייגן פעם אחת או לשייך את הליד לקמפיין" });
  }
  const status: IncidentStatus = repairs.length ? (ctx.ai.autoRepairs ? "diagnosed" : "approval_required") : f.some((x) => x.ok === false) ? "diagnosed" : "no_issue";
  const incident = await saveIncident(ctx.user, "dialer", question, status, { lead: { id: lead.id, name: lead.contact.fullName }, findings: f });
  const actionIds = await proposeRepairs(ctx, incident.id, repairs);
  return { incidentId: incident.id, status: INCIDENT_STATUS[status], lead: lead.contact.fullName, findings: redact(f), repairs: repairs.map((r) => r.summary), actionIds };
}

/** "Why don't I see lead X?" – answered strictly inside the caller's scope; never reveals other agents' leads. */
export async function diagnoseMissingLead(ctx: AiCtx, q: string) {
  const digits = q.replace(/\D/g, "").replace(/^0/, "");
  const where: Prisma.LeadWhereInput = { businessId: ctx.user.businessId, OR: [{ contact: { fullName: { contains: q.trim(), mode: "insensitive" } } }, ...(digits.length >= 6 ? [{ contact: { phoneE164: { contains: digits } } }] : [])] };
  const ids = await visibleUserIds(ctx.user);
  const mine = await prisma.lead.findMany({ where: { ...where, ...ownerScope(ids) }, take: 5, select: { id: true, status: true, contact: { select: { fullName: true } } } });
  if (mine.length) {
    const closed = mine.filter((l) => ["converted", "lost", "unqualified"].includes(l.status));
    const incident = await saveIncident(ctx.user, "leads", q, "no_issue", { found: mine.length, closed: closed.length });
    return { incidentId: incident.id, found: mine.map((l) => ({ leadId: l.id, name: l.contact.fullName, status: l.status })), explanation: closed.length ? "הליד קיים בתחום שלך אך סגור (לא מופיע בתצוגת הלידים הפתוחים) – אפשר לסנן לפי סטטוס" : "הליד קיים ומשויך לתחום שלך – בדוק סינון/חיפוש במסך" };
  }
  if (ctx.user.role === "agent") {
    const incident = await saveIncident(ctx.user, "leads", q, "diagnosed", { found: 0, scope: "agent" });
    return { incidentId: incident.id, found: [], explanation: "לא נמצא ליד כזה ששייך לך. אם הוא אמור להיות שלך (למשל הועבר אליך), אפשר להעביר את הבדיקה למנהל (escalate_to_manager). הרשאות לא ישתנו מהצ׳אט." };
  }
  const any = await prisma.lead.count({ where });
  const incident = await saveIncident(ctx.user, "leads", q, "diagnosed", { found: 0, outsideScope: any });
  return { incidentId: incident.id, found: [], explanation: any ? "קיים ליד תואם מחוץ לצוות שבניהולך – תחום הניהול מוגדר בהגדרות ההרשאות; ההרשאות לא מורחבות מהצ׳אט." : "לא נמצא ליד כזה בעסק." };
}

// ─── repairs catalog ─────────────────────────────────────────────────────────────────────────────────────────────
async function proposeRepairs(ctx: AiCtx, incidentId: string, repairs: Array<{ kind: string; params: Record<string, unknown>; summary: string; impact?: string; approval: boolean }>) {
  const ids: string[] = [];
  for (const r of repairs) {
    const needsApproval = r.approval || !ctx.ai.autoRepairs;
    const a = await proposeAction(ctx.user, ctx.user.businessId, { kind: r.kind, params: r.params, summary: r.summary, impact: r.impact, requiresApproval: needsApproval, incidentId, conversationId: ctx.conversationId, channel: ctx.channel, dedupeKey: `repair:${incidentId}:${r.kind}:${JSON.stringify(r.params).slice(0, 120)}` });
    ids.push(a.id);
  }
  return ids;
}

async function seqUnchanged(id: string, versionAt: unknown) {
  const s = await prisma.marketingSequence.findUnique({ where: { id }, select: { updatedAt: true } });
  if (!s) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found");
  if (versionAt && s.updatedAt.toISOString() !== String(versionAt)) throw new ApiError("האוטומציה השתנתה מאז האבחון – יש לאבחן מחדש", 409, "changed");
}
/** After a config repair: re-validate the journey without sending anything. */
async function simulate(seqId: string) {
  const s = await prisma.marketingSequence.findUniqueOrThrow({ where: { id: seqId }, include: { steps: { include: { template: { select: { status: true, body: true } } } } } });
  const problems: string[] = [];
  for (const st of s.steps.filter((x) => x.action === "send")) {
    if (!st.template) { problems.push(`שלב ${st.position + 1}: אין תבנית`); continue; }
    if (st.template.status !== "APPROVED") problems.push(`שלב ${st.position + 1}: תבנית לא מאושרת`);
    const vars = (st.variables ?? {}) as Record<string, string>;
    const miss = templateParameterKeys(st.template.body).filter((k) => !String(vars[k] ?? "").trim()); if (miss.length) problems.push(`שלב ${st.position + 1}: חסרים ${miss.join(",")}`);
  }
  return { simulated: true, passed: problems.length === 0, problems, sent: 0 };
}
async function closeIncident(incidentId: string | null | undefined, verification: Record<string, unknown>, status: IncidentStatus) {
  if (incidentId) await prisma.aiIncident.update({ where: { id: incidentId }, data: { status, verification: verification as Prisma.InputJsonValue } }).catch(() => undefined);
}

registerExecutor("relink_template", async (_u, p, a) => {
  await seqUnchanged(String(p.automationId), p.versionAt);
  const step = await prisma.sequenceStep.findFirstOrThrow({ where: { sequenceId: String(p.automationId), position: Number(p.stepPosition) } });
  if (step.templateId !== p.fromTemplateId) throw new ApiError("השלב השתנה מאז האבחון", 409, "changed");
  const t = await prisma.template.findFirst({ where: { id: String(p.templateId), status: "APPROVED" }, select: { id: true } }); if (!t) throw new ApiError("התבנית אינה מאושרת עוד", 409, "changed");
  await prisma.sequenceStep.update({ where: { id: step.id }, data: { templateId: t.id } });
  const sim = await simulate(String(p.automationId));
  const inc = (await prisma.aiAction.findUnique({ where: { id: a.id }, select: { incidentId: true } }))?.incidentId;
  await closeIncident(inc, { config: "ההגדרה תוקנה", test: sim.passed ? "הבדיקה עברה" : "הבדיקה נכשלה", realSend: "שליחה אמיתית טרם אומתה", sim }, sim.passed ? "fixed_pending" : "diagnosed");
  return { before: { templateId: p.fromTemplateId }, after: { templateId: t.id }, verification: sim };
}, { managerOnly: true });

registerExecutor("set_step_variable", async (_u, p, a) => {
  await seqUnchanged(String(p.automationId), p.versionAt);
  const step = await prisma.sequenceStep.findFirstOrThrow({ where: { sequenceId: String(p.automationId), position: Number(p.stepPosition) } });
  const vars = { ...((step.variables ?? {}) as Record<string, string>) };
  if (String(vars[String(p.key)] ?? "") !== String(p.previous ?? "")) throw new ApiError("המשתנה השתנה מאז ההצעה", 409, "changed");
  vars[String(p.key)] = String(p.value);
  await prisma.sequenceStep.update({ where: { id: step.id }, data: { variables: vars } });
  const sim = await simulate(String(p.automationId));
  const inc = (await prisma.aiAction.findUnique({ where: { id: a.id }, select: { incidentId: true } }))?.incidentId;
  await closeIncident(inc, { config: "ההגדרה תוקנה", test: sim.passed ? "הבדיקה עברה" : "הבדיקה נכשלה", realSend: "שליחה אמיתית טרם אומתה", sim }, sim.passed ? "fixed_pending" : "diagnosed");
  return { before: { [String(p.key)]: p.previous ?? "" }, after: { [String(p.key)]: p.value }, verification: sim };
}, { managerOnly: true });

registerExecutor("retry_failed_run", async (_u, p) => {
  const run = await prisma.sequenceRun.findUniqueOrThrow({ where: { id: String(p.runId) } });
  if (run.status !== "FAILED") throw new ApiError("הריצה כבר אינה במצב כשל", 409, "changed");
  const sent = await prisma.message.count({ where: { requestKey: { startsWith: `seq:${run.id}:` }, status: { in: MSG_OK as never } } });
  if (sent) throw new ApiError("כבר נשלחה הודעה בריצה זו – לא תישלח שוב", 409, "already_sent");
  await prisma.sequenceRun.update({ where: { id: run.id }, data: { status: "PENDING", nextAt: new Date(), completedAt: null, lockedAt: null, stopReason: null } });
  return { requeued: true, note: "הריצה תעובד במחזור האוטומציות הבא; המסירה תאומת לפי דיווח הספק" };
}, { managerOnly: true });

registerExecutor("release_stale_lock", async (user, p) => {
  const ids = (p.listLeadIds as string[]) ?? [];
  const live = await prisma.call.count({ where: { contactId: String(p.contactId), endedAt: null, createdAt: { gt: new Date(Date.now() - 2 * 3600_000) } } });
  if (live) throw new ApiError("יש שיחה פעילה – הנעילה אינה תקועה", 409, "changed");
  const r = await prisma.listLead.updateMany({ where: { id: { in: ids }, businessId: user.businessId, lockExpiresAt: { lt: new Date() } }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
  const left = await prisma.listLead.count({ where: { id: { in: ids }, lockedByUserId: { not: null } } });
  return { released: r.count, verified: left === 0 };
});

registerExecutor("resync_followups", async (user, p) => {
  const { syncFollowUpQueue } = await import("@/lib/crm/lead-ops");
  const n = await syncFollowUpQueue(prisma, user.businessId, { contactId: String(p.contactId) });
  const inQueue = await prisma.listLead.count({ where: { contactId: String(p.contactId), status: "callback" } });
  return { synced: n, verified: inQueue > 0 };
});

// ─── tool runner ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function runDiagnoseTool(ctx: AiCtx, name: string, args: Record<string, unknown>): Promise<{ result: unknown; actionIds?: string[] }> {
  const q = String(args.question ?? "");
  switch (name) {
    case "diagnose_automation": { const r = await diagnoseAutomation(ctx, String(args.leadId), args.automationId ? String(args.automationId) : undefined, q); return { result: r, actionIds: "actionIds" in r ? r.actionIds : [] }; }
    case "diagnose_messaging": return { result: await diagnoseMessaging(ctx, String(args.leadId), q) };
    case "diagnose_lead": { const r = await diagnoseLead(ctx, String(args.leadId), q); return { result: r, actionIds: r.actionIds }; }
    case "diagnose_missing_lead": return { result: await diagnoseMissingLead(ctx, String(args.phoneOrName ?? "")) };
    case "apply_repair": {
      const a = await prisma.aiAction.findFirst({ where: { id: String(args.actionId), businessId: ctx.user.businessId, incidentId: { not: null } } });
      if (!a) throw new ApiError("התיקון לא נמצא", 404, "not_found");
      if (a.requiresApproval) return { result: { status: a.status, approval: "התיקון ממתין לאישור בכרטיס הפעולה – לא בוצע" }, actionIds: [a.id] };
      const done = await executeAction(ctx.user, a.id);
      return { result: { status: done.status, result: done.result, error: done.error }, actionIds: [a.id] };
    }
    case "propose_repair": {
      if (!canManage(ctx.user, ctx.ai)) throw new ApiError("תיקון הגדרה משותפת דורש מנהל – אפשר להעביר למנהל", 403, "forbidden");
      const inc = await prisma.aiIncident.findFirst({ where: { id: String(args.incidentId), businessId: ctx.user.businessId } }); if (!inc) throw new ApiError("האבחון לא נמצא", 404, "not_found");
      const p = (args.params ?? {}) as Record<string, unknown>;
      const seq = await prisma.marketingSequence.findFirst({ where: { id: String(p.automationId), businessId: ctx.user.businessId }, include: { steps: { include: { template: { select: { id: true, name: true } } } } } });
      if (!seq) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found");
      const step = seq.steps.find((s) => s.position === Number(p.stepPosition)); if (!step) throw new ApiError("השלב לא נמצא", 404, "not_found");
      if (args.repair === "set_step_variable") {
        const key = String(p.key ?? "").replace(/[{}]/g, ""); if (!key || !String(p.value ?? "").trim()) throw new ApiError("יש לציין משתנה וערך", 400, "invalid");
        const prev = ((step.variables ?? {}) as Record<string, string>)[key] ?? "";
        const ids = await proposeRepairs(ctx, inc.id, [{ kind: "set_step_variable", params: { automationId: seq.id, stepPosition: step.position, key, value: String(p.value).slice(0, 200), previous: prev, versionAt: seq.updatedAt.toISOString() }, summary: `מילוי {{${key}}} בשלב ${step.position + 1} של "${seq.name}": "${String(p.value).slice(0, 60)}"`, impact: "משנה את תוכן ההודעות הבאות של האוטומציה", approval: true }]);
        await prisma.aiIncident.update({ where: { id: inc.id }, data: { status: "approval_required" } });
        return { result: { approval: "נדרש אישור" }, actionIds: ids };
      }
      const t = await prisma.template.findFirst({ where: { businessId: ctx.user.businessId, channel: step.channel, name: String(p.templateName ?? ""), status: "APPROVED" }, select: { id: true, name: true } });
      if (!t) throw new ApiError("לא נמצאה תבנית מאושרת בשם הזה", 404, "not_found");
      const ids = await proposeRepairs(ctx, inc.id, [{ kind: "relink_template", params: { automationId: seq.id, stepPosition: step.position, templateId: t.id, fromTemplateId: step.templateId, versionAt: seq.updatedAt.toISOString() }, summary: `החלפת התבנית בשלב ${step.position + 1} של "${seq.name}" ל"${t.name}"`, impact: "משנה את ההודעה שהאוטומציה שולחת", approval: true }]);
      await prisma.aiIncident.update({ where: { id: inc.id }, data: { status: "approval_required" } });
      return { result: { approval: "נדרש אישור" }, actionIds: ids };
    }
    case "escalate_to_manager": {
      const inc = await prisma.aiIncident.findFirst({ where: { id: String(args.incidentId), businessId: ctx.user.businessId, requestedById: ctx.user.id } }); if (!inc) throw new ApiError("האבחון לא נמצא", 404, "not_found");
      await prisma.aiIncident.update({ where: { id: inc.id }, data: { status: "escalated", verification: { escalatedBy: ctx.user.id, note: String(args.note ?? "").slice(0, 500), at: new Date().toISOString() } } });
      return { result: { status: INCIDENT_STATUS.escalated, note: "הבקשה מופיעה למנהלים בהיסטוריית התקלות של עוזר ה-AI" } };
    }
    case "list_incidents": {
      const rows = await prisma.aiIncident.findMany({ where: { businessId: ctx.user.businessId, ...(ctx.user.role === "agent" ? { requestedById: ctx.user.id } : {}) }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, module: true, question: true, status: true, createdAt: true } });
      return { result: { incidents: rows.map((r) => ({ ...r, status: INCIDENT_STATUS[r.status as IncidentStatus] ?? r.status })) } };
    }
  }
  throw new ApiError("כלי לא מוכר", 400, "unknown_tool");
}
