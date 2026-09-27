/**
 * Internal assistant tool catalog (app chat + WhatsApp of linked users). Each tool declares who may use it and runs
 * with the caller's permissions: every query is scoped on the server (visibleUserIds / owner scope) BEFORE any data
 * reaches the model. Actions become AiAction rows (auto-executed only when policy allows, otherwise proposed for
 * approval). Automations are built only from the catalog below and saved through the journey engine.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { zonedDateTime } from "@/lib/business-day";
import { OPEN_LEAD_STATUSES } from "@/lib/crm/labels";
import { runTool as runReadTool, TOOLS as READ_TOOLS, type ToolCtx } from "@/server/assistant/tools";
import { searchKnowledge } from "./knowledge";
import { executeAction, proposeAction, registerExecutor } from "./actions";
import { canManage, type AiSettings } from "./settings";
import { AUTOMATION_TOOL_DEFS, runAutomationTool } from "./automations";
import { DIAGNOSE_TOOL_DEFS, runDiagnoseTool } from "./diagnostics";

export interface AiCtx { user: SessionUser; read: ToolCtx; ai: AiSettings; tz: string; conversationId: string | null; channel: "app" | "whatsapp" }
type Json = Record<string, unknown>;
export interface ToolDef { name: string; description: string; input_schema: Json; managerOnly?: boolean }

// ─── executors for one-off actions (run through the regular services with the executing user's permissions) ───
registerExecutor("create_task", async (user, p) => {
  const { createTask } = await import("@/lib/crm/pipeline");
  const t = await createTask(user, { contactId: String(p.contactId), leadId: (p.leadId as string) ?? null, userId: String(p.userId), title: String(p.title ?? "משימה"), type: (p.type as "callback" | "todo") ?? "todo", dueAt: String(p.dueAt) });
  return { taskId: t.id, dueAt: t.dueAt };
});
registerExecutor("set_follow_up", async (user, p) => { const { scheduleFollowUp } = await import("@/lib/crm/lead-ops"); const r = await scheduleFollowUp(user, String(p.leadId), { date: String(p.date), time: String(p.time), note: p.note ? String(p.note) : undefined }); return { taskId: r.taskId, dueAt: r.dueAt }; });
registerExecutor("change_lead_status", async (user, p) => { const { updateLead } = await import("@/lib/crm/pipeline"); const l = await updateLead(user, String(p.leadId), { status: p.status as never }); return { leadId: l.id, status: l.status }; });
registerExecutor("transfer_lead", async (user, p) => { const { transferLeads } = await import("@/lib/crm/lead-ops"); const r = await transferLeads(user, { leadIds: [String(p.leadId)], toUserId: String(p.toUserId) }); if (r.notFound.length) throw new ApiError("הליד לא נמצא או שאין הרשאה", 404, "not_found"); return { transferred: r.transferred.length, pending: r.pending.length, to: r.to.fullName }; });

const ACTION_KINDS = ["create_task", "set_follow_up", "change_lead_status", "transfer_lead"] as const;

// ─── tool definitions ────────────────────────────────────────────────────────────────────────────────────────────
const READ_DEFS: ToolDef[] = Object.entries(READ_TOOLS).map(([name, t]) => ({ name, description: t.description, input_schema: t.input as Json }));
const CRM_DEFS: ToolDef[] = [
  { name: "my_queue_today", description: "כמה לידים ממתינים לשיחה היום אצל המשתמש (או אצל נציג/כל העסק למנהל): חדשים שטרם חויגו, פולואפים להיום, פולואפים באיחור. כל ליד נספר פעם אחת.", input_schema: { type: "object", properties: { agentName: { type: "string", description: "רק למנהל" } } } },
  { name: "find_lead", description: "חיפוש ליד לפי שם/טלפון בין הלידים שהמשתמש רשאי לראות. מחזיר עד 5 התאמות – אם יש יותר מאחת יש לשאול למי הכוונה.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "find_user", description: "חיפוש משתמש (נציג/מנהל) פעיל לפי שם, לצורך שיוך משימה או העברת ליד. אם יש כמה התאמות יש לשאול.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "search_knowledge", description: "שליפת ידע מאושר על העסק (מדיניות, מוצרים, הנחיות). לא מכיל נתונים חיים (מחירים עדכניים/מלאי/סטטוס הזמנה).", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "create_task", description: "פתיחת משימה לנציג על ליד/לקוח. זמן בשעון העסק.", input_schema: { type: "object", properties: { leadId: { type: "string" }, assigneeUserId: { type: "string" }, title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM" }, callback: { type: "boolean" } }, required: ["leadId", "title", "date", "time"] } },
  { name: "set_follow_up", description: "קביעת פולואפ (סטטוס פולואפ + מועד) לליד.", input_schema: { type: "object", properties: { leadId: { type: "string" }, date: { type: "string" }, time: { type: "string" }, note: { type: "string" } }, required: ["leadId", "date", "time"] } },
  { name: "change_lead_status", description: "שינוי סטטוס ליד (new/contacted/qualified/unqualified/lost). פולואפ – דרך set_follow_up; עסקה נסגרה – דרך המסך.", input_schema: { type: "object", properties: { leadId: { type: "string" }, status: { type: "string", enum: ["new", "contacted", "qualified", "unqualified", "lost"] } }, required: ["leadId", "status"] } },
  { name: "transfer_lead", description: "העברת ליד לנציג אחר (לפי הרשאות העברה).", input_schema: { type: "object", properties: { leadId: { type: "string" }, toUserId: { type: "string" } }, required: ["leadId", "toUserId"] } },
];

/** Tools this user may see. Agents: their own data + their own actions; no automations management / shared repairs. */
export function toolsFor(ctx: AiCtx): ToolDef[] {
  const manager = ctx.user.role !== "agent";
  const reads = READ_DEFS.filter((t) => manager || !["agents_performance", "compare_periods"].includes(t.name));
  const crm = CRM_DEFS;
  const autos = AUTOMATION_TOOL_DEFS.filter((t) => !t.managerOnly || canManage(ctx.user, ctx.ai));
  const diag = DIAGNOSE_TOOL_DEFS.filter((t) => !t.managerOnly || manager);
  return [...reads, ...crm, ...autos, ...diag];
}

export interface ToolRun { ok: boolean; result?: unknown; error?: string; code?: string; data?: unknown; ms: number; actionIds?: string[] }

/** Resolve a lead the user may see (server-side scope; re-checked on every call). */
async function visibleLead(user: SessionUser, leadId: string) {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId: user.businessId, ...ownerScope(ids) }, include: { contact: { select: { id: true, fullName: true, phoneE164: true } }, owner: { select: { id: true, fullName: true } } } });
  if (!lead) throw new ApiError("הליד לא נמצא או שאין הרשאה אליו", 404, "not_found");
  return lead;
}

async function act(ctx: AiCtx, kind: (typeof ACTION_KINDS)[number], params: Json, summary: string, impact?: string) {
  const policy = ctx.ai.actions[kind];
  if (policy === "off") throw new ApiError("הפעולה כבויה בהגדרות העוזר", 403, "action_disabled");
  const action = await proposeAction(ctx.user, ctx.user.businessId, { kind, params, summary, impact, requiresApproval: policy === "approve", conversationId: ctx.conversationId, channel: ctx.channel });
  const final = policy === "auto" ? await executeAction(ctx.user, action.id) : action;
  return { actionId: final.id, status: final.status, summary: final.summary, error: final.error, result: final.result, requiresApproval: final.requiresApproval };
}

export async function runAiTool(ctx: AiCtx, name: string, args: Json): Promise<ToolRun> {
  const t0 = Date.now();
  try {
    if (name in READ_TOOLS) { const r = await runReadTool(ctx.read, name, args); return { ...r, ms: Date.now() - t0 }; }
    const auto = AUTOMATION_TOOL_DEFS.find((t) => t.name === name); if (auto) { if (auto.managerOnly && !canManage(ctx.user, ctx.ai)) throw new ApiError("ניהול אוטומציות דורש הרשאת ניהול", 403, "forbidden"); const r = await runAutomationTool(ctx, name, args); return { ok: true, result: r.result, actionIds: r.actionIds, ms: Date.now() - t0 }; }
    const diag = DIAGNOSE_TOOL_DEFS.find((t) => t.name === name); if (diag) { const r = await runDiagnoseTool(ctx, name, args); return { ok: true, result: r.result, actionIds: r.actionIds, ms: Date.now() - t0 }; }
    switch (name) {
      case "my_queue_today": {
        const { waitingToday } = await import("@/lib/crm/lead-ops");
        let agent: string | null = ctx.user.role === "agent" ? ctx.user.id : null;
        if (args.agentName && ctx.user.role !== "agent") agent = (await findUsers(ctx.user, String(args.agentName)))[0]?.id ?? null;
        // Agents: always their own leads (the service filters owner = self); managers: a named agent or their whole scope.
        const w = await waitingToday(ctx.user, agent);
        return { ok: true, result: { scope: agent ? (agent === ctx.user.id ? "שלי" : "נציג") : "כל העסק", total: w.counts.total, newNotDialed: w.counts.new, followUpsToday: w.counts.today, followUpsOverdue: w.counts.overdue, followUpsWithoutTime: w.counts.schedule, ...(ctx.user.role !== "agent" ? { unassigned: w.counts.unassigned } : {}) }, ms: Date.now() - t0 };
      }
      case "find_lead": {
        const q = String(args.query ?? "").trim(); if (q.length < 2) throw new ApiError("יש לציין שם או טלפון", 400, "invalid");
        const ids = await visibleUserIds(ctx.user); const digits = q.replace(/\D/g, "").replace(/^0/, "");
        const rows = await prisma.lead.findMany({ where: { businessId: ctx.user.businessId, status: { in: [...OPEN_LEAD_STATUSES, "unqualified", "lost", "converted"] }, AND: [ownerScope(ids), { OR: [{ contact: { fullName: { contains: q, mode: "insensitive" } } }, ...(digits.length >= 4 ? [{ contact: { phoneE164: { contains: digits } } }] : [])] }] }, take: 5, orderBy: { createdAt: "desc" }, select: { id: true, status: true, contact: { select: { fullName: true, phoneE164: true } }, owner: { select: { fullName: true } } } });
        return { ok: true, result: { matches: rows.map((r) => ({ leadId: r.id, name: r.contact.fullName, phoneLast4: r.contact.phoneE164.slice(-4), status: r.status, owner: r.owner?.fullName ?? "ללא שיוך" })) }, ms: Date.now() - t0 };
      }
      case "find_user": return { ok: true, result: { matches: (await findUsers(ctx.user, String(args.name ?? ""))).map((u) => ({ userId: u.id, name: u.fullName, role: u.role })) }, ms: Date.now() - t0 };
      case "search_knowledge": {
        const hits = await searchKnowledge(ctx.user.businessId, String(args.query ?? ""), { audience: "internal", limit: 4 });
        return { ok: true, result: hits.length ? { sources: hits.map((h) => ({ title: h.title, category: h.category, type: h.kind === "conversation" ? (h.learnMode === "style" ? "style_example" : "conversation_example") : "policy", text: h.text })) } : { sources: [], note: "לא נמצא ידע מאושר מתאים" }, ms: Date.now() - t0 };
      }
      case "create_task": {
        const lead = await visibleLead(ctx.user, String(args.leadId));
        const assignee = String(args.assigneeUserId ?? ctx.user.id);
        if (ctx.user.role === "agent" && assignee !== ctx.user.id) throw new ApiError("נציג יכול לפתוח משימה רק לעצמו", 403, "forbidden");
        const dueAt = zonedDateTime(ctx.tz, String(args.date), String(args.time)); if (!dueAt) throw new ApiError("מועד לא תקין", 400, "invalid_time");
        const who = await prisma.user.findFirst({ where: { id: assignee, businessId: ctx.user.businessId, isActive: true }, select: { fullName: true } }); if (!who) throw new ApiError("המשתמש לא נמצא", 404, "not_found");
        const r = await act(ctx, "create_task", { contactId: lead.contactId, leadId: lead.id, userId: assignee, title: String(args.title ?? "לחזור ללקוח"), type: args.callback === false ? "todo" : "callback", dueAt: dueAt.toISOString() }, `משימה ל${who.fullName}: "${String(args.title ?? "לחזור ללקוח")}" על ${lead.contact.fullName} · ${args.date} ${args.time}`);
        return { ok: true, result: r, actionIds: [r.actionId], ms: Date.now() - t0 };
      }
      case "set_follow_up": {
        const lead = await visibleLead(ctx.user, String(args.leadId));
        const r = await act(ctx, "set_follow_up", { leadId: lead.id, date: args.date, time: args.time, note: args.note }, `פולואפ ל${lead.contact.fullName} · ${args.date} ${args.time}`);
        return { ok: true, result: r, actionIds: [r.actionId], ms: Date.now() - t0 };
      }
      case "change_lead_status": {
        const lead = await visibleLead(ctx.user, String(args.leadId));
        const r = await act(ctx, "change_lead_status", { leadId: lead.id, status: args.status }, `שינוי סטטוס של ${lead.contact.fullName}: ${lead.status} → ${args.status}`);
        return { ok: true, result: r, actionIds: [r.actionId], ms: Date.now() - t0 };
      }
      case "transfer_lead": {
        const lead = await visibleLead(ctx.user, String(args.leadId));
        const to = await prisma.user.findFirst({ where: { id: String(args.toUserId), businessId: ctx.user.businessId, isActive: true }, select: { id: true, fullName: true } });
        if (!to) throw new ApiError("הנציג לא נמצא", 404, "not_found");
        const r = await act(ctx, "transfer_lead", { leadId: lead.id, toUserId: to.id }, `העברת ${lead.contact.fullName} מ${lead.owner?.fullName ?? "ללא שיוך"} ל${to.fullName}`, "הליד, המשימות והפולואפים יעברו לנציג החדש; הנציג הקודם יאבד גישה אליו.");
        return { ok: true, result: r, actionIds: [r.actionId], ms: Date.now() - t0 };
      }
    }
    return { ok: false, error: `כלי לא מוכר: ${name}`, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message, code: e.code, data: (e as { details?: unknown }).details, ms: Date.now() - t0 };
    console.warn("[ai] tool failed", name, (e as Error).message.slice(0, 200));
    return { ok: false, error: "הפעולה נכשלה בשרת", code: "failed", ms: Date.now() - t0 };
  }
}

/** Active users matching a name. Agents only see names (for hand-offs), never other users' data. */
export async function findUsers(user: SessionUser, name: string) {
  const q = name.trim(); if (!q) return [];
  const ids = user.role === "agent" ? null : await visibleUserIds(user);
  const rows = await prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true, role: true } });
  const exact = rows.filter((u) => u.fullName === q);
  return exact.length ? exact : rows.filter((u) => u.fullName.split(/\s+/).some((w) => w.startsWith(q)) || u.fullName.includes(q)).slice(0, 5);
}
