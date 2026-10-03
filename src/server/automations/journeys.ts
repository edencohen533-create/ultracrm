import { quickReplyButtons } from "@/lib/journey-buttons";
/**
 * Journeys (customer journeys / single automation rules – both are sequences) – save, publish, pause, simulate.
 *
 *  • "שמירה": new → a DRAFT that never runs; an active journey → its unpublished draft is saved, the live version keeps
 *    running unchanged (nothing is stopped silently).
 *  • "שמירה והפעלה": the checks below run on the server; any blocking one refuses. Otherwise the draft becomes a new
 *    published version (SequenceVersion: definition + checks + who approved).
 *  • Runs already in progress keep the version they started with; new events use the new version. Activation never
 *    replays past events on existing contacts – only events from the activation on start runs.
 *  • Pause (from the list) stops new runs AND the ones in progress (the engine stops a run of an inactive journey).
 *  • Simulation: walks the steps for test data or a real contact (read-only) and explains each decision – nothing is sent.
 * The model never produces anything executed here: only a definition that goes through `sequenceSchema` + these checks.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { sequenceSchema, stepRows, stepSkipReason, type SequenceInput } from "@/server/services/sequence-service";

export interface Check { key: string; label: string; ok: boolean; blocking: boolean; detail: string }
const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };
const TRIGGER_EVENTS: Record<string, string> = { CONTACT_CREATED: "איש קשר חדש", CALL_UNANSWERED: "שיחה שלא נענתה", CART_ABANDONED: "עגלה נטושה", TAG_ADDED: "תגית נוספה", LEAD_STATUS_CHANGED: "שינוי סטטוס ליד", DELIVERY_FAILED: "כשל מסירה", SENT_NO_REPLY: "נשלח ולא נענה" };

function parseDef(raw: unknown): { ok: true; def: SequenceInput } | { ok: false; error: string } {
  const r = sequenceSchema.safeParse(raw);
  return r.success ? { ok: true, def: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path[0] === "steps" && typeof i.path[1] === "number" ? `שלב ${i.path[1] + 1}` : i.path.join(".") || "הגדרה"}: ${i.message}`).slice(0, 3).join(" · ") };
}

/** Save without publishing. New → a draft journey (inactive); existing → only its draft changes. */
export async function saveDraft(user: SessionUser, raw: unknown, id?: string) {
  const def = (raw ?? {}) as Record<string, unknown>;
  const name = String(def.name ?? "").trim().slice(0, 120) || "מסע ללא שם";
  if (!id) {
    const trigger = sequenceSchema.shape.trigger.safeParse(def.trigger).success ? (def.trigger as SequenceInput["trigger"]) : "CONTACT_CREATED";
    const row = await prisma.marketingSequence.create({ data: { businessId: user.businessId, name, trigger, isActive: false, status: "draft", version: 0, draft: def as Prisma.InputJsonValue, createdById: user.id } });
    await audit(user.businessId, user.id, "sequence", row.id, "journey.draft_saved", { new: true });
    return { id: row.id, status: row.status };
  }
  const cur = await prisma.marketingSequence.findFirst({ where: { id }, select: { id: true, status: true } });
  if (!cur) throw new ApiError("המסע לא נמצא", 404, "not_found");
  // The live version is untouched: only the draft (and the draft-only name for a never-published journey).
  await prisma.marketingSequence.update({ where: { id }, data: { draft: def as Prisma.InputJsonValue, ...(cur.status === "draft" ? { name } : {}) } });
  await audit(user.businessId, user.id, "sequence", id, "journey.draft_saved", { status: cur.status });
  return { id, status: cur.status };
}

/** Everything that must hold before a journey goes live (and what it will do). */
export async function publishChecks(user: SessionUser, raw: unknown) {
  const checks: Check[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string, blocking = true) => checks.push({ key, label, ok, blocking, detail });
  const p = parseDef(raw);
  if (!p.ok) { add("schema", "הגדרה תקינה ושדות חובה", false, p.error); return { checks, def: null, summary: null }; }
  const def = p.def;
  add("schema", "הגדרה תקינה ושדות חובה", true, `${def.steps.length} פעולות`);
  const { effectiveAccess, can, businessCanUse } = await import("@/lib/access/engine");
  const access = await effectiveAccess(user.businessId, user.id);
  const sends = def.steps.filter((s) => s.action === "send");
  const channels = [...new Set(sends.map((s) => s.channel))];
  // Permission to run automations on each channel used (and CRM work for tasks / tags / lists).
  const perm = (ch: string) => (ch === "whatsapp" ? "whatsapp.automations" : `${ch}.send`) as never;
  const denied = channels.filter((ch) => !can(access, perm(ch)));
  add("permissions", "הרשאות", denied.length === 0, denied.length ? `אין לך הרשאה לאוטומציות ב-${denied.map((c) => CHANNEL_LABEL[c]).join(", ")}` : "יש הרשאה לכל הפעולות");
  // Package + provider connection per channel.
  for (const ch of channels) {
    const inPlan = await businessCanUse(user.businessId, ch as never);
    const conn = await prisma.providerCredential.findFirst({ where: { channel: ch as never, isActive: true }, select: { id: true, provider: true } });
    add(`channel:${ch}`, `חיבור ${CHANNEL_LABEL[ch]}`, inPlan && Boolean(conn), !inPlan ? `${CHANNEL_LABEL[ch]} אינו כלול בחבילה` : conn ? `מחובר (${conn.provider === "mock" ? "הדמיה" : conn.provider})` : `אין חיבור ${CHANNEL_LABEL[ch]} פעיל – יש לחבר בהגדרות ← חיבורים`);
  }
  // Templates: approved for the channel.
  const tpls = await prisma.template.findMany({ where: { id: { in: sends.flatMap((s) => (s.templateId ? [s.templateId] : [])) } }, select: { id: true, name: true, channel: true, status: true, internal: true, category: true, buttons: true } });
  const badTpl = sends.filter((s) => { const t = tpls.find((x) => x.id === s.templateId); return !t || t.internal || t.channel !== s.channel || t.status !== "APPROVED"; });
  add("templates", "תבניות הודעה מאושרות", badTpl.length === 0, badTpl.length ? `${badTpl.length} שלבי שליחה בלי תבנית מאושרת לערוץ` : sends.length ? "כל התבניות מאושרות" : "אין שליחת הודעות", sends.length > 0);
  const badButtons = def.steps.filter(step => {
    const b = step.condition.whatsappButton;
    if (!b) return false;
    const source = def.steps[b.sourceStep];
    return !quickReplyButtons(tpls.find(t => t.id === source?.templateId)?.buttons).includes(b.buttonText);
  });
  if (def.steps.some(step => step.condition.whatsappButton)) add('whatsappButtons', 'כפתורי תשובה מהירה', badButtons.length === 0, badButtons.length ? 'הכפתור שנבחר אינו קיים בתבנית המקור; בחרו כפתור תשובה מהירה' : 'כל הכפתורים קיימים בתבניות המקור');
  if (def.steps.some(step => step.condition.whatsappButton)) {
    const sender = await prisma.providerCredential.findFirst({ where: { channel: 'whatsapp', isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { provider: true, sendingBlocked: true } });
    add('buttonProvider', 'קליטת לחיצות WhatsApp', sender?.provider === 'meta_whatsapp_cloud_api' && !sender.sendingBlocked, sender?.provider === 'meta_whatsapp_cloud_api' && !sender.sendingBlocked ? 'המספר השולח מחובר ל־Meta' : 'תנאי לחיצה דורש מספר שולח פעיל בחיבור Meta; חיבור הדמיה אינו מקבל לחיצות אמיתיות');
  }
  if (def.steps.some(step => step.condition.emailEvent)) {
    const sender = await prisma.providerCredential.findFirst({ where: { channel: 'email', isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { provider: true, sendingBlocked: true } });
    add('emailEventProvider', 'קליטת אירועי אימייל', sender?.provider === 'resend' && !sender.sendingBlocked, sender?.provider === 'resend' && !sender.sendingBlocked ? 'חיבור Resend פעיל' : 'תנאי אירוע דורש חיבור Resend פעיל; ספק הדמיה אינו מדווח אירועים אמיתיים');
    add('emailTracking', 'הגדרת מעקב אצל הספק', false, 'יש להפעיל ב־Resend מעקב פתיחות ולחיצות ו־Webhooks לאירועי האימייל. החיבור לבדו אינו מאמת שהמעקב הוגדר. היעדר דיווח אינו הוכחה שהנמען לא קרא.', false);
  }
  // Lists: exist and are static.
  const listIds = [...new Set(def.steps.flatMap((s) => (s.listId ? [s.listId] : [])))];
  if (listIds.length) { const lists = await prisma.distributionList.findMany({ where: { id: { in: listIds } }, select: { id: true, segment: true } }); add("lists", "רשימות", lists.length === listIds.length && lists.every((l) => l.segment === null), lists.length !== listIds.length ? "רשימה שנבחרה אינה קיימת" : lists.some((l) => l.segment !== null) ? "אפשר לעבוד רק עם רשימה רגילה (לא דינמית)" : "תקין"); }
  // A CRM status trigger: a system meaning or an active status of this business (custom statuses are chosen by id).
  if (def.trigger === "LEAD_STATUS_CHANGED" && def.triggerConfig.leadStatus) {
    const v = def.triggerConfig.leadStatus;
    const kinds = ["new", "contacted", "follow_up", "qualified", "unqualified", "converted", "lost"];
    const known = kinds.includes(v) || Boolean(await prisma.leadStatusDef.findFirst({ where: { id: v, deletedAt: null }, select: { id: true } }));
    add("status", "סטטוס CRM", known, known ? "תקין" : "הסטטוס שנבחר אינו קיים יותר – יש לבחור סטטוס אחר");
  }
  // Loops: a step that re-fires the trigger of the same journey.
  const loop = def.trigger === "TAG_ADDED" && def.steps.some((s) => s.action === "add_tag" && s.actionTag && s.actionTag === def.triggerConfig.tagName);
  add("loops", "ללא לולאות", !loop, loop ? `הפעולה "הוספת תגית ${def.triggerConfig.tagName}" מפעילה שוב את אותו מסע – יש לבחור תגית אחרת` : "אין פעולה שמפעילה מחדש את אותו מסע; הודעה שנשלחה ממסע לעולם לא מתחילה מסע נוסף");
  // Duplicate sends: the same template twice with less than an hour in between.
  const dup = sends.some((s, i) => sends.slice(i + 1).some((o) => o.templateId === s.templateId && def.steps.slice(def.steps.indexOf(s) + 1, def.steps.indexOf(o) + 1).reduce((m, x) => m + x.waitMinutes, 0) < 60));
  add("duplicates", "ללא שליחה כפולה", !dup, dup ? "אותה תבנית נשלחת פעמיים בהפרש של פחות משעה" : "כל אירוע מתחיל ריצה אחת בלבד לכל איש קשר (מפתח ייחודי), ושליחה לא חוזרת פעמיים");
  // What it will do outside the system + who / how much (honest when unknown).
  const external = [
    ...channels.map((ch) => `שליחת ${CHANNEL_LABEL[ch]} (${sends.filter((s) => s.channel === ch).length})`),
    ...(def.steps.some((s) => s.action === "webhook") ? ["Webhook לכתובת חיצונית"] : []),
  ];
  const since = new Date(Date.now() - 30 * 86400_000);
  const estimate = def.trigger === "CONTACT_CREATED" ? await prisma.contact.count({ where: { createdAt: { gte: since }, ...(def.triggerConfig.contactSource ? { source: def.triggerConfig.contactSource } : {}) } })
    : def.trigger === "CALL_UNANSWERED" ? await prisma.call.groupBy({ by: ["contactId"], where: { createdAt: { gte: since }, direction: "outbound", answeredAt: null, leadDialedAt: { not: null } } }).then((r) => r.length)
    : def.trigger === "CART_ABANDONED" ? await prisma.cart.count({ where: { createdAt: { gte: since } } }).catch(() => null)
    : null;
  const cost = channels.map((ch) => ch === "whatsapp" ? "WhatsApp: לפי התמחור של Meta לכל שיחה (נגבה ישירות על ידי Meta)" : `${CHANNEL_LABEL[ch]}: לפי תעריף השימוש של העסק (אם הוגדר)`);
  return { checks, def, summary: { trigger: TRIGGER_EVENTS[def.trigger] ?? def.trigger, external, audience: estimate === null ? "לא ניתן לאמוד מראש – לפי אירועים חדשים מרגע ההפעלה" : `בערך ${estimate} אנשי קשר ב-30 הימים האחרונים עמדו בטריגר – ההפעלה חלה רק על אירועים מעכשיו`, cost, running: "ריצות שכבר בדרך ממשיכות לפי הגרסה שבה התחילו; אירועים חדשים יעברו בגרסה החדשה." } };
}

/** "שמירה והפעלה": checks on the server, then publish the draft as a new version. */
export async function publish(user: SessionUser, id: string, raw?: unknown) {
  const seq = await prisma.marketingSequence.findFirst({ where: { id } });
  if (!seq) throw new ApiError("המסע לא נמצא", 404, "not_found");
  const def = raw ?? seq.draft;
  if (!def) throw new ApiError("אין שינויים לפרסם", 409, "nothing_to_publish");
  const r = await publishChecks(user, def);
  const failed = r.checks.filter((c) => c.blocking && !c.ok);
  if (failed.length || !r.def) throw new ApiError(failed.map((c) => c.detail).join(" · ") || "ההגדרה אינה תקינה", 409, "checks_failed", { checks: r.checks });
  const d = r.def;
  const stopOn = [...new Set([...d.stopOn, "unsubscribe"])];
  const version = seq.version + 1;
  const rows = stepRows(seq.id, d);
  try { await prisma.$transaction(async (tx) => {
    await tx.sequenceStep.deleteMany({ where: { sequenceId: seq.id } });
    await tx.sequenceStep.createMany({ data: rows as Prisma.SequenceStepCreateManyInput[] });
    await tx.marketingSequence.update({ where: { id: seq.id }, data: { name: d.name, trigger: d.trigger, triggerConfig: d.triggerConfig as Prisma.InputJsonValue, stopOn, isActive: true, status: "active", version, publishedAt: new Date(), draft: Prisma.DbNull } });
    await tx.sequenceVersion.create({ data: { businessId: user.businessId, sequenceId: seq.id, version, definition: { name: d.name, trigger: d.trigger, triggerConfig: d.triggerConfig, stopOn, steps: rows } as Prisma.InputJsonValue, checks: r.checks as unknown as Prisma.InputJsonValue, publishedById: user.id } });
  }); } catch (e) {
    // Two publishes at the same moment: the second one meets the unique (sequence, version) – a clear message, not a crash.
    if ((e as { code?: string }).code === "P2002") throw new ApiError("גרסה חדשה פורסמה הרגע – רעננו ונסו שוב", 409, "conflict");
    throw e;
  }
  await audit(user.businessId, user.id, "sequence", seq.id, "journey.published", { version, checks: r.checks.map((c) => ({ key: c.key, ok: c.ok })) });
  return { id: seq.id, version, checks: r.checks, summary: r.summary };
}

/** The live (published) steps back in the editor / checks shape. */
export async function liveDefinition(id: string) {
  const seq = await prisma.marketingSequence.findFirstOrThrow({ where: { id }, include: { steps: { orderBy: { position: "asc" } } } });
  return {
    name: seq.name, trigger: seq.trigger, triggerConfig: (seq.triggerConfig ?? {}) as Record<string, unknown>, stopOn: seq.stopOn.filter((x) => x !== "unsubscribe"),
    steps: seq.steps.map((st) => { const v = (st.variables ?? {}) as Record<string, string>; return { action: st.action, channel: st.channel, templateId: st.templateId ?? undefined, waitMinutes: st.waitMinutes, variables: Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("__"))), condition: st.condition ?? {}, taskTitle: v.__taskTitle, taskDueHours: v.__taskDueHours ? Number(v.__taskDueHours) : undefined, actionTag: v.__tag, listId: v.__listId, webhookUrl: v.__webhook }; }),
  };
}

/** Pause / resume from the list. Resume needs a published version. */
export async function setJourneyStatus(user: SessionUser, id: string, status: "active" | "paused") {
  const seq = await prisma.marketingSequence.findFirst({ where: { id }, select: { id: true, version: true, status: true } });
  if (!seq) throw new ApiError("המסע לא נמצא", 404, "not_found");
  if (status === "active" && seq.version < 1) throw new ApiError("המסע עוד לא פורסם – יש לפתוח אותו ולבחור \"שמירה והפעלה\"", 409, "not_published");
  if (status === "active") {
    // Resuming re-runs the checks on the live version (a connection / permission may have changed since).
    const r = await publishChecks(user, await liveDefinition(id));
    const failed = r.checks.filter((c) => c.blocking && !c.ok);
    if (failed.length) throw new ApiError(failed.map((c) => c.detail).join(" · "), 409, "checks_failed", { checks: r.checks });
  }
  await prisma.marketingSequence.update({ where: { id }, data: { status, isActive: status === "active" } });
  await audit(user.businessId, user.id, "sequence", id, status === "paused" ? "journey.paused" : "journey.resumed", {});
  return { id, status };
}

export interface TestData { tags?: string[]; leadStatus?: string; consent?: "OPTED_IN" | "UNKNOWN" | "OPTED_OUT"; replied?: boolean; converted?: boolean }
/** Walk the journey for test data or a real contact (read-only) and explain every decision. Nothing is sent. */
export async function simulate(user: SessionUser, raw: unknown, input: { contactId?: string; data?: TestData }) {
  // A draft may still lack templates – simulate it anyway; such a step is explained as "won't be sent".
  const r0 = (raw ?? {}) as { steps?: Array<Record<string, unknown>> };
  const p = parseDef({ ...r0, steps: (r0.steps ?? []).map((s) => (s.action === "send" && !s.templateId ? { ...s, templateId: "__missing__" } : s)) });
  if (!p.ok) throw new ApiError(p.error, 400, "validation");
  const def = p.def;
  const real = input.contactId ? await prisma.contact.findFirst({ where: { id: input.contactId }, select: { id: true, fullName: true } }) : null;
  if (input.contactId && !real) throw new ApiError("איש הקשר לא נמצא", 404, "not_found");
  const td = input.data ?? {};
  const tpls = await prisma.template.findMany({ where: { id: { in: def.steps.flatMap((s) => (s.templateId ? [s.templateId] : [])) } }, select: { id: true, name: true, status: true } });
  const out: Array<{ step: number; title: string; result: "done" | "skipped" | "stop"; why: string; at: string }> = [];
  let minutes = 0;
  if (def.stopOn.includes("reply") && td.replied) return { steps: [{ step: 0, title: "תנאי עצירה", result: "stop" as const, why: "הלקוח השיב – המסע נעצר לפני הפעולה הראשונה (תנאי יציאה: תגובה)", at: "0" }], contact: real?.fullName ?? null };
  for (const [i, s] of def.steps.entries()) {
    minutes += s.waitMinutes;
    const at = minutes === 0 ? "מיד" : minutes < 60 ? `אחרי ${minutes} דק׳` : minutes % 1440 === 0 ? `אחרי ${minutes / 1440} ימים` : `אחרי ${Math.round(minutes / 6) / 10} שעות`;
    const title = s.action === "send" ? `שליחת ${CHANNEL_LABEL[s.channel]}` : s.action === "condition" ? "תנאי" : s.action === "wait" ? "המתנה" : s.action === "task" ? "משימה לנציג" : s.action === "add_tag" ? `הוספת תגית ${s.actionTag}` : s.action === "remove_tag" ? `הסרת תגית ${s.actionTag}` : s.action === "webhook" ? "Webhook" : s.action;
    const c = s.condition;
    if (c.emailEvent) {
      out.push({ step: i + 1, title, result: 'stop', why: `תנאי אימייל (${c.emailEvent.event}) מהודעה ${c.emailEvent.sourceStep + 1}, בחלון ${c.emailEvent.timeoutMinutes} דקות. בסימולציה לא נשלחה הודעה ולכן אין אירוע ספק לאימות התנאי.`, at }); break;
    }
    if (c.whatsappButton) {
      out.push({ step: i + 1, title, result: 'stop', why: `כאן ממתינים עד ${c.whatsappButton.timeoutMinutes} דקות משליחת הודעה ${c.whatsappButton.sourceStep + 1}, לכפתור "${c.whatsappButton.buttonText}". הסימולציה אינה ממציאה לחיצה; בהיעדר לחיצה המסע מסתיים.`, at });
      break;
    }
    if (s.action === "condition" || s.action === "send") {
      // Why the condition holds or not – real contact: the engine's own check; test data: the same rules on the values given.
      let reason: string | null = null;
      if (real) { const r = await stepSkipReason({ contactId: real.id, startedAt: new Date() }, c); reason = r ? `לא מתקיים: ${r}` : null; }
      else {
        if (c.requireNoReply !== false && td.replied) reason = "לא מתקיים: הלקוח השיב";
        else if (c.tagName && !(td.tags ?? []).includes(c.tagName)) reason = `לא מתקיים: אין תגית ${c.tagName}`;
        else if (c.notTagName && (td.tags ?? []).includes(c.notTagName)) reason = `לא מתקיים: יש תגית ${c.notTagName}`;
        else if (c.leadStatus && td.leadStatus !== c.leadStatus) reason = `לא מתקיים: סטטוס הליד ${td.leadStatus ?? "לא ידוע"} (נדרש ${c.leadStatus})`;
        else if (c.consent === "OPTED_IN" && td.consent !== "OPTED_IN") reason = "לא מתקיים: אין הסכמה לדיוור";
      }
      if (reason) { out.push({ step: i + 1, title, result: s.action === "condition" ? "stop" : "skipped", why: s.action === "condition" ? `${reason} – המסע מסתיים כאן` : `${reason} – השליחה מדולגת`, at }); if (s.action === "condition") break; continue; }
      if (s.action === "condition") { out.push({ step: i + 1, title, result: "done", why: "כל התנאים מתקיימים – ממשיכים", at }); continue; }
      const t = tpls.find((x) => x.id === s.templateId);
      if (!t || t.status !== "APPROVED") { out.push({ step: i + 1, title, result: "skipped", why: s.templateId === "__missing__" ? "לא נבחרה תבנית מאושרת – לא יישלח (וגם לא ניתן להפעיל)" : "התבנית אינה מאושרת – לא יישלח", at }); continue; }
      if (real) { const { sendBlockReason } = await import("@/lib/suppression"); const b = await sendBlockReason(user.businessId, real.id, "marketing"); if (b) { out.push({ step: i + 1, title, result: "skipped", why: `חסום: ${b}`, at }); continue; } }
      else if (td.consent === "OPTED_OUT") { out.push({ step: i + 1, title, result: "skipped", why: "הסיר את עצמו מדיוור – לא יישלח", at }); continue; }
      out.push({ step: i + 1, title, result: "done", why: `יישלח "${t.name}" (בסימולציה – לא נשלח באמת)`, at });
      continue;
    }
    out.push({ step: i + 1, title, result: "done", why: s.action === "wait" ? "ממתינים" : "יבוצע (בסימולציה – לא בוצע באמת)", at });
  }
  return { steps: out, contact: real?.fullName ?? null };
}
