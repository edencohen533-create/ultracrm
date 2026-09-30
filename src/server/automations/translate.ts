/**
 * Free text → a journey / automation-rule DRAFT (one engine for both screens).
 *
 *  • Output is data only: a definition in the sequence engine's own shape (trigger, triggerConfig, steps, stopOn),
 *    focused questions, parts that are NOT supported (never turned into a fake node), and existing settings that
 *    already do a part (e.g. lead distribution, the "available now" rule). Nothing the model writes is executed:
 *    the definition is re-validated by `sequenceSchema` and the publish checks before it can run.
 *  • With the AI connected the model proposes the structure; otherwise (and as a safety net) a conservative Hebrew
 *    parser recognises the supported triggers / actions. Either way the summary is generated in code from the result.
 *  • "Correction": the current draft is sent along; the result replaces only what the text changes.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { aiConnected } from "@/server/ai/settings";

export const TRIGGERS = ["CONTACT_CREATED", "CALL_UNANSWERED", "CART_ABANDONED", "TAG_ADDED", "LEAD_STATUS_CHANGED", "DELIVERY_FAILED", "SENT_NO_REPLY"] as const;
export const ACTIONS = ["send", "wait", "condition", "task", "add_tag", "remove_tag", "add_to_list", "remove_from_list", "webhook"] as const;
type Channel = "whatsapp" | "sms" | "email";
export interface DraftStep { action: (typeof ACTIONS)[number]; channel: Channel; templateId?: string; waitMinutes: number; variables: Record<string, string>; condition: Record<string, unknown>; taskTitle?: string; taskDueHours?: number; actionTag?: string; listId?: string; webhookUrl?: string }
export interface DraftDef { name: string; trigger: (typeof TRIGGERS)[number]; triggerConfig: Record<string, unknown>; stopOn: string[]; steps: DraftStep[] }
export interface Interpretation {
  definition: DraftDef | null;
  questions: Array<{ field: string; question: string; options?: Array<{ value: string; label: string }> }>;
  unsupported: Array<{ text: string; reason: string }>;
  related: Array<{ title: string; detail: string; href: string }>;
  summary: string[];
  analyzer: "ai" | "rules";
}
interface Ctx { templates: Array<{ id: string; name: string; channel: string }>; tags: string[]; lists: Array<{ id: string; name: string }>; availabilityRuleActive: boolean }

export async function loadContext(): Promise<Ctx> {
  const [templates, tags, lists, rule] = await Promise.all([
    prisma.template.findMany({ where: { status: "APPROVED", internal: false }, select: { id: true, name: true, channel: true }, orderBy: { name: "asc" } }),
    prisma.tag.findMany({ select: { name: true }, orderBy: { name: "asc" } }).then((r) => r.map((x) => x.name)),
    prisma.distributionList.findMany({ select: { id: true, name: true, segment: true } }).then((r) => r.filter((l) => l.segment === null).map(({ id, name }) => ({ id, name }))),
    prisma.opsRule.findFirst({ where: { kind: "availability", status: "active" }, select: { id: true } }).catch(() => null),
  ]);
  return { templates, tags, lists, availabilityRuleActive: Boolean(rule) };
}

const CH_LABEL: Record<Channel, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };
const TRIGGER_LABEL: Record<string, string> = { CONTACT_CREATED: "כשנוצר איש קשר חדש", CALL_UNANSWERED: "כשליד לא ענה לשיחה", CART_ABANDONED: "כשעגלה ננטשת באתר", TAG_ADDED: "כשנוספת תגית", LEAD_STATUS_CHANGED: "כשסטטוס ליד משתנה", DELIVERY_FAILED: "כשהודעה לא נמסרה", SENT_NO_REPLY: "כשנשלחה הודעה ולא התקבלה תשובה" };
const mins = (m: number) => (m % 1440 === 0 ? `${m / 1440} ימים` : m % 60 === 0 ? `${m / 60} שעות` : `${m} דקות`);
const step = (x: Partial<DraftStep> & Pick<DraftStep, "action">): DraftStep => ({ channel: "whatsapp", waitMinutes: 0, variables: {}, condition: { requireNoReply: x.action === "send" }, ...x });

/** Plain-language summary, written in code from the definition (never from the model). */
export function describe(def: DraftDef, ctx: Pick<Ctx, "templates">) {
  const lines = [`${TRIGGER_LABEL[def.trigger] ?? def.trigger}${def.trigger === "TAG_ADDED" && def.triggerConfig.tagName ? ` "${def.triggerConfig.tagName}"` : ""}${def.trigger === "CALL_UNANSWERED" && Number(def.triggerConfig.minAttempts ?? 1) > 1 ? ` (אחרי ${def.triggerConfig.minAttempts} ניסיונות)` : ""}:`];
  for (const s of def.steps) {
    const wait = s.waitMinutes > 0 && s.action !== "wait" ? `אחרי ${mins(s.waitMinutes)} – ` : "";
    if (s.action === "send") lines.push(`${wait}שליחת ${CH_LABEL[s.channel]}${s.templateId ? ` בתבנית "${ctx.templates.find((t) => t.id === s.templateId)?.name ?? "?"}"` : " (צריך לבחור תבנית מאושרת)"}${s.condition.requireNoReply !== false ? ", רק אם הלקוח לא השיב" : ""}`);
    else if (s.action === "wait") lines.push(`המתנה ${mins(s.waitMinutes)}`);
    else if (s.action === "task") lines.push(`${wait}משימה לנציג: ${s.taskTitle ?? ""}`);
    else if (s.action === "add_tag") lines.push(`${wait}הוספת תגית "${s.actionTag}"`);
    else if (s.action === "remove_tag") lines.push(`${wait}הסרת תגית "${s.actionTag}"`);
    else if (s.action === "condition") lines.push(`${wait}תנאי – ממשיכים רק אם מתקיים, אחרת המסע מסתיים`);
    else lines.push(`${wait}${s.action}`);
  }
  lines.push(`עצירה: ${[def.stopOn.includes("reply") ? "כשהלקוח משיב" : null, def.stopOn.includes("conversion") ? "כשהליד הופך לעסקה" : null, "כשהלקוח מסיר את עצמו מדיוור (תמיד)"].filter(Boolean).join(", ")}.`);
  lines.push("לפני כל שליחה נבדקים שוב הסכמה, הסרות, חסימות ותדירות. ההפעלה חלה רק על אירועים מרגע ההפעלה – לא רטרואקטיבית.");
  return lines;
}

const SHORT: Record<string, string> = { CONTACT_CREATED: "איש קשר חדש", CALL_UNANSWERED: "לא ענה לשיחה", CART_ABANDONED: "עגלה נטושה", TAG_ADDED: "תגית נוספה", LEAD_STATUS_CHANGED: "שינוי סטטוס", DELIVERY_FAILED: "כשל מסירה", SENT_NO_REPLY: "לא השיב" };
const autoName = (trigger: string, steps: DraftStep[]) => `${SHORT[trigger] ?? trigger} → ${[...new Set(steps.map((s) => (s.action === "send" ? CH_LABEL[s.channel] : s.action === "task" ? "משימה" : s.action === "add_tag" ? "תגית" : null)).filter(Boolean))].join(" + ") || "פעולות"}`;
const NUM: Record<string, number> = { "שעה": 60, "שעתיים": 120, "חצי שעה": 30, "רבע שעה": 15, "יום": 1440, "יומיים": 2880, "שבוע": 10080 };
function waitOf(clause: string) {
  const m = clause.match(/(?:אחרי|לאחר|המתן|תמתין|חכה)\s+(\d+)\s*(דק(?:ות|ה)?|שעות|שעה|ימים|יום)/);
  if (m) { const n = Number(m[1]); return /דק/.test(m[2]) ? n : /שע/.test(m[2]) ? n * 60 : n * 1440; }
  const w = Object.entries(NUM).find(([k]) => new RegExp(`(?:אחרי|לאחר)\\s+${k}(\\s|$|,|\\.)`).test(clause));
  return w ? w[1] : 0;
}

/** Conservative Hebrew parser for the supported pieces (also the fallback when the model is not connected). */
export function parseRules(text: string, ctx: Ctx, mode: "journey" | "rule", current?: DraftDef | null): Omit<Interpretation, "summary" | "analyzer"> {
  const t = text.replace(/[״"]/g, "").trim();
  const clauses = t.split(/[.\n]|,\s*(?=אם|כש|ואם|אחרי|ואחרי|ואז)/).map((c) => c.trim()).filter(Boolean);
  const questions: Interpretation["questions"] = []; const unsupported: Interpretation["unsupported"] = []; const related: Interpretation["related"] = [];
  let trigger: DraftDef["trigger"] | null = null; const triggerConfig: Record<string, unknown> = {};
  const steps: DraftStep[] = [];
  const stopOn = new Set<string>(["reply", "conversion", "unsubscribe"]);
  const pickTemplate = (ch: Channel) => {
    const opts = ctx.templates.filter((x) => x.channel === ch);
    if (opts.length === 1) return opts[0].id;
    // The step itself is supported – it stays in the draft, but can't be activated until a template is approved.
    if (opts.length === 0) questions.push({ field: `template:${ch}:${steps.length}`, question: `אין עדיין תבנית ${CH_LABEL[ch]} מאושרת – השלב נוסף לטיוטה, ואפשר יהיה להפעיל רק אחרי שתאושר תבנית (ניהול תבניות).` });
    else questions.push({ field: `template:${ch}:${steps.length}`, question: `באיזו תבנית ${CH_LABEL[ch]} לשלוח?`, options: opts.map((o) => ({ value: o.id, label: o.name })) });
    return undefined;
  };
  for (const c of clauses) {
    let used = false;
    // Parts done elsewhere – never nodes.
    if (/(הקצ[הא]|לשייך|שייך|תשייך|הקצאה).*(נציג)|(נציג).*(הקצ[הא]|שייך)/.test(c)) { related.push({ title: "הקצאת ליד חדש לנציג", detail: "קורית אוטומטית לכל ליד חדש לפי חלוקת הלידים (סבב / עומס, מכסות, זמינות) – לא כצומת במסע.", href: "/leads" }); used = true; }
    if (/(פנוי|פנויה|זמין|זמינה)\s*עכשיו/.test(c) && /(קדם|תקדם|תור|ראש)/.test(c)) { related.push({ title: "״פנוי עכשיו״ בוואטסאפ – לראש תור החיוג", detail: ctx.availabilityRuleActive ? "הכלל ״זמינות מוואטסאפ״ כבר פעיל במנהל AI: לקוח שכותב שהוא זמין עכשיו עובר לראש התור של הנציג שלו." : "הכלל ״זמינות מוואטסאפ״ במנהל AI עושה את זה – כרגע הוא לא פעיל. אפשר להפעיל אותו שם.", href: "/ai" }); used = true; }
    if (/(תענה|יענה|לענות|בוט|ענה אוטומטית|תשובה אוטומטית).*(AI|בינה|אוטומטי)|AI.*(יענה|תענה)/i.test(c)) { unsupported.push({ text: c, reason: "תשובת AI אוטומטית ללקוח אינה פעולה במסע – כדי למנוע תגובות בלי סוף ושליחות שלא אושרו." }); used = true; }
    // Trigger.
    const tr: DraftDef["trigger"] | null = /(לא\s*ענה|לא\s*עונה|אין\s*מענה|לא\s*נענ)/.test(c) ? "CALL_UNANSWERED" : /עגלה/.test(c) ? "CART_ABANDONED" : /(לא\s*נמסר|כשל\s*מסירה)/.test(c) ? "DELIVERY_FAILED" : /(לא\s*הגיב|לא\s*השיב).*(להודעה|לדיוור|לקמפיין)/.test(c) ? "SENT_NO_REPLY" : /(נוספה|הוספה|מקבל)\s*תגית/.test(c) ? "TAG_ADDED" : /סטטוס/.test(c) ? "LEAD_STATUS_CHANGED" : /((ליד|איש\s*קשר|לקוח)\s*חדש|נכנס\s*ליד|נרשם)/.test(c) ? "CONTACT_CREATED" : null;
    // A journey has one trigger; an action tied to "didn't answer" makes that the trigger (it can't be a condition).
    const hasSend = /(שלח|שלחו|תשלח|לשלוח)/.test(c);
    if (tr && (!trigger || (tr === "CALL_UNANSWERED" && trigger === "CONTACT_CREATED" && hasSend))) {
      if (trigger === "CONTACT_CREATED" && tr === "CALL_UNANSWERED") related.push({ title: "איש קשר חדש", detail: "המסע מתחיל מ״לא ענה לשיחה״ – שם יש פעולה. ליד חדש כבר מוקצה ונכנס לחייגן אוטומטית.", href: "/leads" });
      trigger = tr; used = true;
      const n = c.match(/(\d+)\s*(ניסיונות|פעמים)/); if (tr === "CALL_UNANSWERED" && n) triggerConfig.minAttempts = Number(n[1]);
      const tag = c.match(/תגית\s+([^\s,]+)/); if (tr === "TAG_ADDED" && tag) triggerConfig.tagName = tag[1];
    }
    // Actions.
    const wait = waitOf(c);
    if (hasSend) {
      const ch: Channel = /(SMS|מסרון|סמס)/i.test(c) ? "sms" : /(מייל|אימייל|דוא)/.test(c) ? "email" : "whatsapp";
      steps.push(step({ action: "send", channel: ch, waitMinutes: wait, templateId: pickTemplate(ch) })); used = true;
    } else if (/(משימה|תזכורת|התראה)\s*(ל|אל)?\s*נציג/.test(c)) { steps.push(step({ action: "task", waitMinutes: wait, taskTitle: "לחזור ללקוח", taskDueHours: 24, condition: { requireNoReply: false } })); used = true; }
    else if (/הוסף\s*תגית\s+([^\s,]+)/.test(c)) { steps.push(step({ action: "add_tag", waitMinutes: wait, actionTag: c.match(/הוסף\s*תגית\s+([^\s,]+)/)![1], condition: { requireNoReply: false } })); used = true; }
    else if (wait && !tr) { steps.push(step({ action: "wait", waitMinutes: wait, condition: { requireNoReply: false } })); used = true; }
    if (/(אל\s*תעצור|גם\s*אם\s*(ענה|השיב))/.test(c)) stopOn.delete("reply");
    if (!used && c.length > 3) unsupported.push({ text: c, reason: "לא זוהתה פעולה או אירוע נתמכים בחלק הזה – אפשר לנסח מחדש או לבנות ידנית." });
  }
  // A correction keeps what the new text didn't change.
  const def: DraftDef | null = trigger || steps.length || current ? {
    name: current?.name ?? autoName(trigger ?? "CONTACT_CREATED", steps),
    trigger: trigger ?? current?.trigger ?? "CONTACT_CREATED",
    triggerConfig: Object.keys(triggerConfig).length ? triggerConfig : trigger ? {} : current?.triggerConfig ?? {},
    stopOn: [...stopOn],
    steps: steps.length ? steps : current?.steps ?? [],
  } : null;
  if (def && !trigger && !current) questions.push({ field: "trigger", question: "מה מתחיל את המסע? (למשל: איש קשר חדש, שיחה שלא נענתה, תגית שנוספה)", options: TRIGGERS.map((x) => ({ value: x, label: TRIGGER_LABEL[x] })) });
  if (def && mode === "rule" && def.steps.filter((s) => s.action !== "wait").length > 1) questions.push({ field: "mode", question: "יש כאן יותר מפעולה אחת – אולי עדיף מסע לקוח? (חוק בודד = טריגר ופעולה אחת)" });
  if (def?.trigger === "SENT_NO_REPLY" && def.steps[0] && def.steps[0].waitMinutes < 30) def.steps[0].waitMinutes = 30;
  return { definition: def && def.steps.length ? def : def && current ? def : null, questions, unsupported, related };
}

const modelSchema = z.object({
  definition: z.object({ name: z.string().max(120), trigger: z.enum(TRIGGERS), triggerConfig: z.record(z.string(), z.unknown()).default({}), stopOn: z.array(z.string()).default(["reply", "conversion", "unsubscribe"]), steps: z.array(z.object({ action: z.string(), channel: z.enum(["whatsapp", "sms", "email"]).default("whatsapp"), templateId: z.string().optional(), waitMinutes: z.number().int().min(0).max(43200).default(0), condition: z.record(z.string(), z.unknown()).default({}), taskTitle: z.string().optional(), actionTag: z.string().optional() })).max(30) }).nullable(),
  questions: z.array(z.object({ field: z.string(), question: z.string() })).default([]),
  unsupported: z.array(z.object({ text: z.string(), reason: z.string() })).default([]),
});

async function parseModel(text: string, ctx: Ctx, mode: "journey" | "rule", current?: DraftDef | null): Promise<Omit<Interpretation, "summary" | "analyzer"> | null> {
  const system = [
    "אתה ממיר תיאור בעברית של מסע לקוח / חוק אוטומציה להגדרה מובנית. החזר JSON בלבד. אל תמציא יכולות.",
    `טריגרים מותרים בלבד: ${TRIGGERS.join(", ")}. פעולות מותרות בלבד: ${ACTIONS.join(", ")}. תנאי (condition) = ממשיכים רק אם מתקיים, אחרת המסע מסתיים (אין הסתעפות לשני כיוונים).`,
    "הקצאת ליד לנציג, קידום בתור החיוג ותשובות AI אוטומטיות אינן פעולות במסע – שים אותן ב-unsupported עם הסבר.",
    `תבניות מאושרות (id:name:channel): ${ctx.templates.map((x) => `${x.id}:${x.name}:${x.channel}`).join("; ").slice(0, 3000)}. אם לא ברור איזו תבנית – השאר ריק והוסף שאלה.`,
    mode === "rule" ? "זה חוק בודד: טריגר אחד ופעולה אחת (אפשר המתנה לפניה)." : "זה מסע לקוח: אפשר כמה פעולות, המתנות ותנאים.",
    current ? `טיוטה נוכחית (שנה רק מה שהטקסט מבקש): ${JSON.stringify(current).slice(0, 4000)}` : "",
    'פורמט: {"definition":{"name","trigger","triggerConfig":{},"stopOn":[],"steps":[{"action","channel","templateId","waitMinutes","condition":{},"taskTitle","actionTag"}]} | null,"questions":[{"field","question"}],"unsupported":[{"text","reason"}]}',
  ].join("\n");
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: process.env.AI_SERVICE_MODEL ?? "claude-sonnet-5", max_tokens: 1500, temperature: 0, system, messages: [{ role: "user", content: `<request>${text.slice(0, 2000)}</request>` }] }), signal: AbortSignal.timeout(25_000) });
  if (!res.ok) return null;
  const raw = ((await res.json()) as { content: Array<{ type: string; text?: string }> }).content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const parsed = modelSchema.safeParse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
  if (!parsed.success) return null;
  const unsupported = [...parsed.data.unsupported];
  const d = parsed.data.definition;
  // Anything outside the engine's vocabulary becomes "not supported" – never a node; unknown template ids are dropped.
  const steps = (d?.steps ?? []).filter((s) => { const ok = (ACTIONS as readonly string[]).includes(s.action); if (!ok) unsupported.push({ text: s.action, reason: "פעולה שאינה נתמכת במנוע האוטומציות" }); return ok; })
    .map((s) => step({ ...s, action: s.action as DraftStep["action"], templateId: s.templateId && ctx.templates.some((x) => x.id === s.templateId && x.channel === s.channel) ? s.templateId : undefined }));
  const def = d ? { name: d.name || "מסע חדש", trigger: d.trigger, triggerConfig: d.triggerConfig, stopOn: [...new Set([...d.stopOn.filter((x) => ["reply", "conversion", "unsubscribe"].includes(x)), "unsubscribe"])], steps } : null;
  const rules = parseRules(text, ctx, mode, current); // related settings are recognised in code
  return { definition: def, questions: parsed.data.questions, unsupported, related: rules.related };
}

export async function interpret(text: string, mode: "journey" | "rule", current?: DraftDef | null): Promise<Interpretation> {
  const ctx = await loadContext();
  let r: Omit<Interpretation, "summary" | "analyzer"> | null = null; let analyzer: Interpretation["analyzer"] = "rules";
  if (aiConnected()) { try { r = await parseModel(text, ctx, mode, current); if (r) analyzer = "ai"; } catch { r = null; } }
  if (!r) r = parseRules(text, ctx, mode, current);
  // Every send step without a template gets a question (never a guess).
  if (r.definition) for (const [i, s] of r.definition.steps.entries()) if (s.action === "send" && !s.templateId && !r.questions.some((q) => q.field.startsWith(`template:${s.channel}`))) {
    const opts = ctx.templates.filter((x) => x.channel === s.channel);
    if (opts.length) r.questions.push({ field: `template:${s.channel}:${i}`, question: `באיזו תבנית ${CH_LABEL[s.channel]} לשלוח בשלב ${i + 1}?`, options: opts.map((o) => ({ value: o.id, label: o.name })) });
  }
  return { ...r, summary: r.definition ? describe(r.definition, ctx) : [], analyzer };
}
