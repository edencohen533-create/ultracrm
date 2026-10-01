/**
 * Automations from the chat. The model only fills a STRUCTURED spec from the catalog below; the journey engine
 * (sequence-service) validates it and executes it. No generated code / SQL. Life-cycle:
 *   create → saved INACTIVE (draft) + "activate" action that needs a manager's approval of that exact version
 *   update → proposed change (before/after) → approval → applied only if the automation did not change meanwhile
 *   pause  → immediate (reduces behaviour) · resume / apply-to-existing → approval (with impact count)
 * Activation affects NEW events only; running on existing records is a separate, approved "backfill".
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { templateParameterKeys } from "@/lib/campaigns";
import { proposeAction, registerExecutor } from "./actions";
import type { AiCtx, ToolDef } from "./tools";

const STATUS_HE: Record<string, string> = { new: "חדש", contacted: "נוצר קשר", follow_up: "פולואפ", qualified: "מתאים", unqualified: "לא מתאים", converted: "הומר לעסקה", lost: "אבוד" };
export const TRIGGERS = {
  LEAD_STATUS_CHANGED: "סטטוס ליד השתנה (leadStatus)",
  CALL_UNANSWERED: "ליד לא ענה אחרי X ניסיונות חיוג (minAttempts)",
  CONTACT_CREATED: "איש קשר חדש (contactSource אופציונלי)",
  TAG_ADDED: "תגית נוספה (tagName)",
  CART_ABANDONED: "עגלה ננטשה",
} as const;

const specSchemaDoc = {
  type: "object",
  properties: {
    name: { type: "string" }, description: { type: "string", description: "תיאור בעברית פשוטה" },
    trigger: { type: "object", properties: { type: { type: "string", enum: Object.keys(TRIGGERS) }, leadStatus: { type: "string", enum: Object.keys(STATUS_HE) }, minAttempts: { type: "number" }, tagName: { type: "string" }, contactSource: { type: "string" } }, required: ["type"] },
    steps: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["send_whatsapp", "send_sms", "wait", "add_tag", "create_task"] }, templateName: { type: "string" }, variables: { type: "object", description: "משתני התבנית, למשל {\"1\":\"{name}\"}" }, waitMinutes: { type: "number" }, tag: { type: "string" }, taskTitle: { type: "string" }, taskDueHours: { type: "number" } }, required: ["action"] } },
  },
  required: ["name", "trigger", "steps"],
};

export const AUTOMATION_TOOL_DEFS: ToolDef[] = [
  { name: "list_automations", description: "רשימת האוטומציות (מסעות לקוח) בעסק עם מצב, טריגר, זמן ריצה אחרון והצלחות/כשלים.", input_schema: { type: "object", properties: {} } },
  { name: "create_automation", description: `יצירת אוטומציה מתמשכת מקטלוג קבוע. נשמרת כטיוטה וממתינה לאישור מנהל. טריגרים: ${Object.entries(TRIGGERS).map(([k, v]) => `${k}=${v}`).join("; ")}. פעולות: send_whatsapp/send_sms (templateName של תבנית מאושרת + variables), wait, add_tag, create_task.`, input_schema: specSchemaDoc, managerOnly: true },
  { name: "update_automation", description: "הצעת שינוי לאוטומציה קיימת (מפרט מלא חדש). השינוי מוצג לאישור מנהל.", input_schema: { type: "object", properties: { automationId: { type: "string" }, spec: specSchemaDoc }, required: ["automationId", "spec"] }, managerOnly: true },
  { name: "pause_automation", description: "השהיית אוטומציה (מיידי).", input_schema: { type: "object", properties: { automationId: { type: "string" } }, required: ["automationId"] }, managerOnly: true },
  { name: "resume_automation", description: "הפעלה מחדש של אוטומציה מושהית (דורש אישור).", input_schema: { type: "object", properties: { automationId: { type: "string" } }, required: ["automationId"] }, managerOnly: true },
  { name: "apply_automation_to_existing", description: "הצעה להריץ אוטומציה גם על רשומות קיימות – מחשב היקף ומבקש אישור נפרד.", input_schema: { type: "object", properties: { automationId: { type: "string" } }, required: ["automationId"] }, managerOnly: true },
];

type Spec = { name: string; description?: string; trigger: { type: keyof typeof TRIGGERS; leadStatus?: string; minAttempts?: number; tagName?: string; contactSource?: string }; steps: Array<{ action: string; templateName?: string; variables?: Record<string, string>; waitMinutes?: number; tag?: string; taskTitle?: string; taskDueHours?: number }> };

/** Spec → journey input (validated against the business's approved templates). Throws a clear Hebrew error. */
export async function specToInput(businessId: string, spec: Spec, isActive: boolean) {
  if (!spec?.trigger?.type || !(spec.trigger.type in TRIGGERS)) throw new ApiError("טריגר לא נתמך", 400, "invalid_trigger");
  if (!Array.isArray(spec.steps) || !spec.steps.length) throw new ApiError("יש להגדיר לפחות פעולה אחת", 400, "invalid_steps");
  if (spec.trigger.type === "LEAD_STATUS_CHANGED" && !spec.trigger.leadStatus) throw new ApiError("יש לבחור לאיזה סטטוס", 400, "invalid_trigger");
  if (spec.trigger.type === "TAG_ADDED" && !spec.trigger.tagName) throw new ApiError("יש לבחור תגית", 400, "invalid_trigger");
  const steps = [];
  for (const [i, st] of spec.steps.entries()) {
    if (st.action === "send_whatsapp" || st.action === "send_sms") {
      const channel = st.action === "send_sms" ? "sms" : "whatsapp";
      const tpls = await prisma.template.findMany({ where: { businessId, channel, internal: false, name: st.templateName ?? "" }, select: { id: true, name: true, status: true, body: true } });
      if (!tpls.length) throw new ApiError(`שלב ${i + 1}: לא נמצאה תבנית ${channel === "sms" ? "SMS" : "WhatsApp"} בשם "${st.templateName ?? ""}"`, 400, "template_not_found", { templates: (await prisma.template.findMany({ where: { businessId, channel, internal: false, status: "APPROVED" }, select: { name: true } })).map((t) => t.name) });
      const tpl = tpls.find((t) => t.status === "APPROVED"); if (!tpl) throw new ApiError(`שלב ${i + 1}: התבנית "${st.templateName}" אינה מאושרת`, 400, "template_not_approved");
      const keys = templateParameterKeys(tpl.body); const vars = st.variables ?? {};
      const missing = keys.filter((k) => !vars[k]?.trim()); if (missing.length) throw new ApiError(`שלב ${i + 1}: חסרים ערכים למשתנים ${missing.map((k) => `{{${k}}}`).join(", ")} (אפשר {name} לשם הלקוח)`, 400, "missing_variables", { missing });
      steps.push({ action: "send" as const, channel, templateId: tpl.id, waitMinutes: Math.max(0, Math.round(st.waitMinutes ?? 0)), variables: Object.fromEntries(keys.map((k) => [k, vars[k]])), condition: { requireNoReply: false } });
    } else if (st.action === "wait") steps.push({ action: "wait" as const, channel: "whatsapp" as const, waitMinutes: Math.max(1, Math.round(st.waitMinutes ?? 60)), variables: {}, condition: { requireNoReply: false } });
    else if (st.action === "add_tag") steps.push({ action: "add_tag" as const, channel: "whatsapp" as const, waitMinutes: Math.max(0, Math.round(st.waitMinutes ?? 0)), actionTag: st.tag, variables: {}, condition: { requireNoReply: false } });
    else if (st.action === "create_task") steps.push({ action: "task" as const, channel: "whatsapp" as const, waitMinutes: Math.max(0, Math.round(st.waitMinutes ?? 0)), taskTitle: st.taskTitle ?? "משימת מעקב", taskDueHours: Math.max(1, Math.round(st.taskDueHours ?? 24)), variables: {}, condition: { requireNoReply: false } });
    else throw new ApiError(`שלב ${i + 1}: פעולה לא נתמכת (${st.action})`, 400, "invalid_action");
  }
  const { sequenceSchema } = await import("@/server/services/sequence-service");
  const parsed = sequenceSchema.safeParse({ name: spec.name.slice(0, 120), isActive, trigger: spec.trigger.type, triggerConfig: { marketingOnly: false, ...(spec.trigger.leadStatus ? { leadStatus: spec.trigger.leadStatus } : {}), ...(spec.trigger.minAttempts ? { minAttempts: Math.round(spec.trigger.minAttempts) } : {}), ...(spec.trigger.tagName ? { tagName: spec.trigger.tagName } : {}), ...(spec.trigger.contactSource ? { contactSource: spec.trigger.contactSource } : {}) }, stopOn: ["unsubscribe"], steps });
  if (!parsed.success) throw new ApiError(`הגדרה לא תקינה: ${parsed.error.issues[0]?.message ?? ""}`, 400, "invalid_spec");
  return parsed.data;
}

/** Plain-Hebrew description of an automation (shown for approval of the exact version). */
export async function describe(seqId: string) {
  const s = await prisma.marketingSequence.findUnique({ where: { id: seqId }, include: { steps: { orderBy: { position: "asc" }, include: { template: { select: { name: true, status: true } } } } } });
  if (!s) return "";
  const cfg = (s.triggerConfig ?? {}) as { leadStatus?: string; minAttempts?: number; tagName?: string; contactSource?: string };
  const trig = s.trigger === "LEAD_STATUS_CHANGED" ? `כשסטטוס ליד משתנה ל"${STATUS_HE[cfg.leadStatus ?? ""] ?? cfg.leadStatus}"` : s.trigger === "CALL_UNANSWERED" ? `כשליד לא ענה ${cfg.minAttempts ?? 1} ניסיונות חיוג` : s.trigger === "CONTACT_CREATED" ? `כשנוצר איש קשר חדש${cfg.contactSource ? ` ממקור ${cfg.contactSource}` : ""}` : s.trigger === "TAG_ADDED" ? `כשנוספת התגית "${cfg.tagName}"` : s.trigger === "CART_ABANDONED" ? "כשעגלה ננטשת" : s.trigger;
  const steps = s.steps.map((st) => (st.action === "send" ? `שליחת ${st.channel === "sms" ? "SMS" : "WhatsApp"} "${st.template?.name}"${st.waitMinutes ? ` אחרי ${st.waitMinutes} דק׳` : ""}` : st.action === "wait" ? `המתנה ${st.waitMinutes} דק׳` : st.action === "add_tag" ? "הוספת תגית" : st.action === "task" ? "משימה לנציג" : st.action));
  return `${trig} → ${steps.join(" → ")}`;
}

// ─── executors ───────────────────────────────────────────────────────────────────────────────────────────────────
async function assertUnchanged(id: string, versionAt: unknown) {
  const s = await prisma.marketingSequence.findUnique({ where: { id }, select: { updatedAt: true } });
  if (!s) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found");
  if (versionAt && s.updatedAt.toISOString() !== String(versionAt)) throw new ApiError("האוטומציה השתנתה מאז שהוצגה לאישור – יש לבקש סיכום מחדש", 409, "changed");
}
registerExecutor("activate_automation", async (u, p) => { await assertUnchanged(String(p.automationId), p.versionAt); await (await import("@/server/automations/journeys")).setJourneyStatus(u, String(p.automationId), "active"); return { active: true }; }, { managerOnly: true });
registerExecutor("resume_automation", async (u, p) => { await assertUnchanged(String(p.automationId), p.versionAt); await (await import("@/server/automations/journeys")).setJourneyStatus(u, String(p.automationId), "active"); return { active: true }; }, { managerOnly: true });
registerExecutor("pause_automation", async (u, p) => { await (await import("@/server/automations/journeys")).setJourneyStatus(u, String(p.automationId), "paused"); return { active: false }; }, { managerOnly: true });
registerExecutor("update_automation", async (user, p) => {
  await assertUnchanged(String(p.automationId), p.versionAt);
  const { saveSequence } = await import("@/server/services/sequence-service");
  const input = await specToInput(user.businessId, p.spec as Spec, Boolean(p.keepActive));
  const s = await saveSequence(user, input, String(p.automationId));
  return { updated: true, versionAt: s.updatedAt };
}, { managerOnly: true });
registerExecutor("backfill_automation", async (_u, p) => {
  await assertUnchanged(String(p.automationId), p.versionAt);
  const seq = await prisma.marketingSequence.findUniqueOrThrow({ where: { id: String(p.automationId) }, include: { steps: { orderBy: { position: "asc" }, take: 1 } } });
  if (!seq.isActive) throw new ApiError("יש להפעיל את האוטומציה לפני החלה על רשומות קיימות", 409, "inactive");
  const contacts = await affectedContacts(seq.businessId, seq.id);
  const pinned = await prisma.sequenceVersion.findFirst({ where: { sequenceId: seq.id, version: seq.version }, select: { id: true } });
  const r = await prisma.sequenceRun.createMany({ data: contacts.map((contactId) => ({ businessId: seq.businessId, sequenceId: seq.id, contactId, versionId: pinned?.id ?? null, sourceKey: `backfill:${contactId}`, nextAt: new Date(Date.now() + (seq.steps[0]?.waitMinutes ?? 0) * 60_000), log: [] })), skipDuplicates: true });
  return { started: r.count, candidates: contacts.length };
}, { managerOnly: true });

/** Contacts an automation would reach if applied to existing data (only for status / unanswered triggers). */
async function affectedContacts(businessId: string, seqId: string) {
  const s = await prisma.marketingSequence.findUniqueOrThrow({ where: { id: seqId } });
  const cfg = (s.triggerConfig ?? {}) as { leadStatus?: string; minAttempts?: number };
  if (s.trigger === "LEAD_STATUS_CHANGED" && cfg.leadStatus) return (await prisma.lead.findMany({ where: { businessId, status: cfg.leadStatus as never }, distinct: ["contactId"], select: { contactId: true } })).map((l) => l.contactId);
  if (s.trigger === "CALL_UNANSWERED") {
    const rows = await prisma.call.groupBy({ by: ["contactId"], where: { businessId, direction: "outbound", leadDialedAt: { not: null }, answeredAt: null, contactId: { not: null } }, _count: { _all: true } });
    return rows.filter((r) => r._count._all >= (cfg.minAttempts ?? 1)).map((r) => r.contactId!);
  }
  throw new ApiError("החלה על רשומות קיימות נתמכת רק לאוטומציות לפי סטטוס או לפי ניסיונות חיוג", 400, "unsupported");
}

// ─── listing ─────────────────────────────────────────────────────────────────────────────────────────────────────
export async function listAutomations(businessId: string) {
  const seqs = await prisma.marketingSequence.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 100 });
  const since = new Date(Date.now() - 7 * 86400_000);
  const [stats, last, everOn] = await Promise.all([
    prisma.sequenceRun.groupBy({ by: ["sequenceId", "status"], where: { businessId }, _count: { _all: true } }),
    prisma.sequenceRun.groupBy({ by: ["sequenceId"], where: { businessId }, _max: { startedAt: true } }),
    prisma.aiAction.findMany({ where: { businessId, kind: { in: ["activate_automation", "resume_automation"] }, status: "executed" }, select: { params: true } }),
  ]);
  const recentFailed = await prisma.sequenceRun.groupBy({ by: ["sequenceId"], where: { businessId, status: "FAILED", startedAt: { gte: since } }, _count: { _all: true } });
  const activated = new Set(everOn.map((a) => String((a.params as { automationId?: string }).automationId)));
  return Promise.all(seqs.map(async (s) => {
    const c = (st: string) => stats.find((x) => x.sequenceId === s.id && x.status === st)?._count._all ?? 0;
    const runs = ["COMPLETED", "FAILED", "STOPPED", "PENDING", "RUNNING"].reduce((n, st) => n + c(st), 0);
    const failing = (recentFailed.find((x) => x.sequenceId === s.id)?._count._all ?? 0) > 0;
    const state = s.isActive ? (failing ? "needs_attention" : "active") : runs || activated.has(s.id) ? "paused" : "draft";
    return { id: s.id, name: s.name, description: await describe(s.id), state, trigger: s.trigger, lastRunAt: last.find((x) => x.sequenceId === s.id)?._max.startedAt ?? null, completed: c("COMPLETED"), failed: c("FAILED"), skipped: c("STOPPED"), pending: c("PENDING") + c("RUNNING"), updatedAt: s.updatedAt };
  }));
}

export async function automationRuns(businessId: string, seqId: string) {
  return prisma.sequenceRun.findMany({ where: { businessId, sequenceId: seqId }, orderBy: { startedAt: "desc" }, take: 30, select: { id: true, status: true, startedAt: true, completedAt: true, stopReason: true, log: true, stepIndex: true, contact: { select: { fullName: true } } } });
}

// ─── tool runner ─────────────────────────────────────────────────────────────────────────────────────────────────
async function findSeq(user: SessionUser, id: string) { const s = await prisma.marketingSequence.findFirst({ where: { id, businessId: user.businessId } }); if (!s) throw new ApiError("האוטומציה לא נמצאה", 404, "not_found"); return s; }

export async function runAutomationTool(ctx: AiCtx, name: string, args: Record<string, unknown>): Promise<{ result: unknown; actionIds?: string[] }> {
  const user = ctx.user; const base = { conversationId: ctx.conversationId, channel: ctx.channel };
  if (name === "list_automations") return { result: { automations: (await listAutomations(user.businessId)).slice(0, 30) } };
  if (name === "create_automation") {
    const spec = args as unknown as Spec;
    const { saveSequence } = await import("@/server/services/sequence-service");
    const input = await specToInput(user.businessId, spec, false);
    const seq = await saveSequence(user, input);
    const text = await describe(seq.id);
    const a = await proposeAction(user, user.businessId, { ...base, kind: "activate_automation", params: { automationId: seq.id, versionAt: seq.updatedAt.toISOString() }, summary: `הפעלת האוטומציה "${seq.name}": ${text}`, impact: "תפעל על אירועים חדשים בלבד מרגע האישור. הודעות יישלחו רק ללקוחות שלא הסירו את עצמם.", requiresApproval: true });
    return { result: { automationId: seq.id, state: "draft", description: text, approval: "נדרש אישור מנהל להפעלה" }, actionIds: [a.id] };
  }
  if (name === "update_automation") {
    const seq = await findSeq(user, String(args.automationId));
    const input = await specToInput(user.businessId, args.spec as Spec, seq.isActive); void input;
    const before = { description: await describe(seq.id), isActive: seq.isActive };
    const a = await proposeAction(user, user.businessId, { ...base, kind: "update_automation", params: { automationId: seq.id, versionAt: seq.updatedAt.toISOString(), spec: args.spec as Record<string, unknown>, keepActive: seq.isActive }, summary: `עדכון האוטומציה "${seq.name}"`, impact: `לפני: ${before.description}`, before, requiresApproval: true });
    return { result: { approval: "השינוי ממתין לאישור", before: before.description }, actionIds: [a.id] };
  }
  if (name === "pause_automation") {
    const seq = await findSeq(user, String(args.automationId));
    const { executeAction } = await import("./actions");
    const a = await proposeAction(user, user.businessId, { ...base, kind: "pause_automation", params: { automationId: seq.id }, summary: `השהיית "${seq.name}"`, requiresApproval: false, before: { isActive: seq.isActive } });
    const done = await executeAction(user, a.id);
    return { result: { status: done.status, error: done.error }, actionIds: [a.id] };
  }
  if (name === "resume_automation") {
    const seq = await findSeq(user, String(args.automationId));
    const a = await proposeAction(user, user.businessId, { ...base, kind: "resume_automation", params: { automationId: seq.id, versionAt: seq.updatedAt.toISOString() }, summary: `הפעלה מחדש של "${seq.name}": ${await describe(seq.id)}`, impact: "תפעל על אירועים חדשים מרגע האישור.", requiresApproval: true });
    return { result: { approval: "נדרש אישור" }, actionIds: [a.id] };
  }
  if (name === "apply_automation_to_existing") {
    const seq = await findSeq(user, String(args.automationId));
    const n = (await affectedContacts(user.businessId, seq.id)).length;
    const a = await proposeAction(user, user.businessId, { ...base, kind: "backfill_automation", params: { automationId: seq.id, versionAt: seq.updatedAt.toISOString() }, summary: `החלת "${seq.name}" על רשומות קיימות`, impact: `${n} אנשי קשר יתחילו את התהליך (הודעות יישלחו רק למי שלא הסיר את עצמו). פעולה זו אינה הפיכה לגבי הודעות שנשלחו.`, requiresApproval: true });
    return { result: { affected: n, approval: "נדרש אישור נפרד" }, actionIds: [a.id] };
  }
  throw new ApiError("כלי לא מוכר", 400, "unknown_tool");
}
export type { Spec as AutomationSpec };
