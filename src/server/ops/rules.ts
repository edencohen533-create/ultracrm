/**
 * "מנהל AI" rules: structured, typed configs per kind (trigger · conditions · action · scope · validity · limits ·
 * approval). Free text is translated into ONE of these kinds – by the model when connected, otherwise by a
 * conservative pattern parser – and is never saved before the manager saw the plain-language summary. Vague words
 * ("חזק", "הרבה") are never given a meaning silently: a concrete threshold is proposed as a question.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { aiConnected } from "@/server/ai/settings";

export const RULE_KINDS = ["momentum", "extra_leads_policy", "availability", "load_cap", "approval_policy"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type Autonomy = "insight" | "recommend" | "auto";

export const momentumConfig = z.object({
  minHandled: z.number().int().min(3).max(500).default(10),
  minWins: z.number().int().min(1).max(100).default(3),
  minBaselineHandled: z.number().int().min(5).max(5000).default(30),
  liftFactor: z.number().min(1).max(10).default(1.5),
  confidence: z.union([z.literal(0.8), z.literal(0.9), z.literal(0.95)]).default(0.9),
  compareToPeers: z.boolean().default(true),
  maxUntouched: z.number().int().min(0).max(200).default(5),
  mode: z.enum(["extra", "priority", "share"]).default("extra"),
  count: z.number().int().min(1).max(100).default(5),
  sharePct: z.number().int().min(10).max(100).default(60),
  source: z.string().max(120).nullable().default(null),
  listId: z.string().max(60).nullable().default(null),
});
export const extraLeadsPolicyConfig = z.object({
  askAgent: z.boolean().default(true),
  capToManagerApproved: z.literal(true).default(true),
  requestMinutes: z.number().int().min(5).max(480).default(60),
});
export const availabilityConfig = z.object({
  ttlMinutes: z.number().int().min(1).max(240).default(15),
  fallback: z.enum(["alert_manager", "transfer_to_available", "none"]).default("alert_manager"),
  unattendedAfterMinutes: z.number().int().min(1).max(60).default(3),
});
export const loadCapConfig = z.object({ maxUntouched: z.number().int().min(1).max(500).default(15) });
export const approvalPolicyConfig = z.object({ actions: z.array(z.enum(["assignment", "ownership"])).min(1).default(["assignment", "ownership"]) });

export const CONFIG_SCHEMAS = { momentum: momentumConfig, extra_leads_policy: extraLeadsPolicyConfig, availability: availabilityConfig, load_cap: loadCapConfig, approval_policy: approvalPolicyConfig } as const;
export type RuleConfig<K extends RuleKind> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

export const KIND_LABEL: Record<RuleKind, string> = { momentum: "נציג במומנטום", extra_leads_policy: "לידים נוספים באישור נציג", availability: "זמינות מוואטסאפ", load_cap: "עצירת הקצאה בעומס", approval_policy: "מדיניות אישור" };
export const AUTONOMY_LABEL: Record<Autonomy, string> = { insight: "תובנה בלבד", recommend: "המלצה באישור", auto: "ביצוע אוטומטי בגבולות" };
const DEFAULT_AUTONOMY: Record<RuleKind, Autonomy> = { momentum: "recommend", extra_leads_policy: "auto", availability: "auto", load_cap: "auto", approval_policy: "auto" };
/** Which autonomy levels make sense per kind. */
export const ALLOWED_AUTONOMY: Record<RuleKind, Autonomy[]> = { momentum: ["insight", "recommend", "auto"], extra_leads_policy: ["auto"], availability: ["recommend", "auto"], load_cap: ["insight", "auto"], approval_policy: ["auto"] };

export function parseConfig<K extends RuleKind>(kind: K, raw: unknown): RuleConfig<K> {
  const r = CONFIG_SCHEMAS[kind].safeParse(raw ?? {});
  if (!r.success) throw new ApiError(`הגדרת הכלל לא תקינה: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`, 400, "validation");
  return r.data as RuleConfig<K>;
}

/** Built-in rules every business starts with (visible and editable; the momentum rule is a recommendation only). */
export async function ensureDefaultRules(businessId: string) {
  const existing = await prisma.opsRule.findMany({ where: { businessId }, select: { kind: true } });
  const have = new Set(existing.map((r) => r.kind));
  const { getBusinessSettings } = await import("@/lib/settings");
  const s = await getBusinessSettings(businessId);
  const defaults: Array<{ kind: RuleKind; name: string; config: unknown; priority: number }> = [
    { kind: "approval_policy", name: "שינוי חלוקה והעברת בעלות – רק באישור מנהל", config: {}, priority: 10 },
    { kind: "momentum", name: "המלצה על לידים נוספים לנציג במומנטום", config: {}, priority: 50 },
    { kind: "extra_leads_policy", name: "לידים נוספים – לשאול את הנציג בוואטסאפ לפני הקצאה", config: {}, priority: 60 },
    { kind: "availability", name: "״זמינה עכשיו״ בוואטסאפ – לראש התור של הנציג", config: { ttlMinutes: s.availableNowTtlMinutes }, priority: 70 },
  ];
  for (const d of defaults) if (!have.has(d.kind)) await prisma.opsRule.create({ data: { businessId, kind: d.kind, name: d.name, config: parseConfig(d.kind, d.config) as object, autonomy: DEFAULT_AUTONOMY[d.kind], priority: d.priority } });
}

/** The rule in force for a kind: active, not expired, strongest priority first. */
export async function ruleFor<K extends RuleKind>(businessId: string, kind: K) {
  const r = await prisma.opsRule.findFirst({ where: { businessId, kind, status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
  return r ? { ...r, kind, autonomy: r.autonomy as Autonomy, config: parseConfig(kind, r.config) } : null;
}

/** Actions the approval policy reserves for the manager (default when no policy rule: both). */
export async function requiresManager(businessId: string, action: "assignment" | "ownership") {
  const p = await ruleFor(businessId, "approval_policy");
  return p ? p.config.actions.includes(action) : true;
}

// ─── plain language ───────────────────────────────────────────────────────────────────────────────────────────────
export function describeRule(kind: RuleKind, config: unknown, autonomy: Autonomy): { trigger: string; conditions: string; action: string; scope: string; validity: string; limits: string; approval: string } {
  const a = AUTONOMY_LABEL[autonomy];
  if (kind === "momentum") {
    const c = parseConfig("momentum", config);
    const act = c.mode === "extra" ? `להציע ${c.count} לידים נוספים היום מעבר לחלקו הרגיל` : c.mode === "priority" ? `להציע שהוא יקבל את ${c.count} הלידים החדשים הבאים` : `להציע ${c.sharePct}% מ-${c.count} הלידים החדשים הבאים`;
    return { trigger: "בדיקה אוטומטית כל 2 דקות", conditions: `שיעור סגירה היום ≥ פי ${c.liftFactor} מהממוצע האישי (ברמת ביטחון ${Math.round(c.confidence * 100)}%)${c.compareToPeers ? " ומעל נציגים על לידים דומים" : ""}; לפחות ${c.minHandled} לידים שטופלו ו-${c.minWins} סגירות היום, ${c.minBaselineHandled}+ לידים בבסיס ההשוואה; פחות מ-${c.maxUntouched} לידים שטרם טופלו ושעות משמרת ידועות עם קיבולת פנויה`, action: act, scope: `${c.source ? `לידים ממקור "${c.source}"` : "כל הלידים החדשים"}${c.listId ? " + לקמפיין שנבחר" : ""}`, validity: "עד סוף המשמרת של הנציג", limits: "המלצה אחת לנציג לכל תקופת צינון; חלוקה זמנית אחת פעילה בכל פעם; רק לידים חדשים – לידים של נציגים אחרים לא מועברים", approval: a };
  }
  if (kind === "extra_leads_policy") {
    const c = parseConfig("extra_leads_policy", config);
    return { trigger: "מנהל אישר לידים נוספים לנציג", conditions: "—", action: c.askAgent ? "לשאול את הנציג בוואטסאפ אם יספיק לטפל בהם היום; להקצות רק אחרי שאישר, ועד הכמות שהמנהל אישר" : "להקצות מיד אחרי אישור המנהל", scope: "הבקשה המסוימת", validity: `עד ${c.requestMinutes} דקות לתשובה, ולא אחרי סוף המשמרת`, limits: "אי-מענה אינו אישור; תשובה עמומה → בקשת הבהרה", approval: a };
  }
  if (kind === "availability") {
    const c = parseConfig("availability", config);
    const fb = c.fallback === "alert_manager" ? "להתריע למנהל" : c.fallback === "transfer_to_available" ? "להציע העברה לנציג זמין (באישור מנהל לפי מדיניות האישור)" : "לא לעשות דבר";
    return { trigger: "לקוח/ה כתב/ה בוואטסאפ שהוא/היא זמין/ה עכשיו", conditions: "ליד פתוח שהחייגן כבר ניסה להשיג; לא ב-DNC/הסרה", action: `לקדם לראש התור של הנציג המשויך ל-${c.ttlMinutes} דקות; אם הנציג לא מחובר ${c.unattendedAfterMinutes} דק׳ – ${fb}`, scope: "הנציג המשויך בלבד", validity: `${c.ttlMinutes} דקות`, limits: "לא עוקף הסרה, DNC, חלון חיוג ומכסות", approval: a };
  }
  if (kind === "load_cap") {
    const c = parseConfig("load_cap", config);
    return { trigger: "הקצאת ליד חדש", conditions: `לנציג יותר מ-${c.maxUntouched} לידים שטרם טופלו`, action: autonomy === "auto" ? "לדלג עליו בחלוקה עד שהעומס יורד" : "להתריע בלבד", scope: "כל הנציגים בחלוקה", validity: "קבוע עד שינוי", limits: "אם כל הנציגים עמוסים הליד נשאר ללא שיוך", approval: a };
  }
  const c = parseConfig("approval_policy", config);
  return { trigger: "כל פעולה של מנהל AI", conditions: "—", action: `חובת אישור מנהל ל: ${c.actions.map((x) => (x === "assignment" ? "שינוי חלוקת לידים" : "העברת בעלות")).join(", ")}`, scope: "כל הכללים", validity: "קבוע", limits: "גובר על ״ביצוע אוטומטי״ בכללים אחרים", approval: a };
}

// ─── free text → rule ───────────────────────────────────────────────────────────────────────────────────────────
export interface Interpretation {
  kind: RuleKind | null; name: string; config: Record<string, unknown>; autonomy: Autonomy;
  questions: Array<{ field: string; question: string; proposed: number | string | boolean }>;
  summary: ReturnType<typeof describeRule> | null; analyzer: "ai" | "rules"; note: string | null;
}
const VAGUE = /(חזק|חזקים|הרבה|מעט|קצת|גבוה|נמוך|טוב במיוחד|מהר|לאט|מדי)/;
const num = (s: string, re: RegExp) => { const m = s.match(re); return m ? Number(m[1]) : null; };

export function parseRuleBasic(text: string): Omit<Interpretation, "summary" | "analyzer"> {
  const t = text.replace(/[״"]/g, "").trim();
  const q: Interpretation["questions"] = [];
  const minutes = num(t, /(\d+)\s*דק/) ?? (/עשר דקות/.test(t) ? 10 : /חמש דקות/.test(t) ? 5 : /רבע שעה/.test(t) ? 15 : /חצי שעה/.test(t) ? 30 : null);
  const words: Record<string, number> = { "חמישה": 5, "חמש": 5, "שלושה": 3, "ארבעה": 4, "עשרה": 10, "עשר": 10, "שישה": 6, "שבעה": 7, "שמונה": 8, "תשעה": 9, "חמישה עשר": 15, "עשרים": 20 };
  const count = (re: RegExp) => { const m = t.match(re); if (!m) return null; return /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1]] ?? null; };
  const W = `(\\d+|${Object.keys(words).sort((a, b) => b.length - a.length).join("|")})`;

  if (/בלי אישור|ללא אישור|רק באישור|רק אחרי אישור/.test(t) && /(חלוק|הקצא|העבר)/.test(t) && !/(וואטסאפ|ווטסאפ|whatsapp)/i.test(t)) {
    const actions = [/(חלוק|הקצא)/.test(t) ? "assignment" : null, /(בעלות|העבר)/.test(t) ? "ownership" : null].filter(Boolean);
    return { kind: "approval_policy", name: "שינויים רק באישור מנהל", config: { actions }, autonomy: "auto", questions: [], note: null };
  }
  if (/(זמינה|זמין|פנויה|פנוי)\s*עכשיו/.test(t) && /(תור|תקדם|קדם|ראש)/.test(t)) {
    if (!minutes) q.push({ field: "ttlMinutes", question: "לכמה זמן לקדם את הלקוח/ה לראש התור?", proposed: 15 });
    return { kind: "availability", name: "״זמינה עכשיו״ – לראש התור", config: { ttlMinutes: minutes ?? 15 }, autonomy: "auto", questions: q, note: null };
  }
  if (/(לידים נוספים|עוד לידים|תוספת לידים)/.test(t) && /(שאל|תשאל|לשאול).*(נציג|אותו)/.test(t)) {
    return { kind: "extra_leads_policy", name: "לידים נוספים – באישור הנציג", config: { askAgent: true }, autonomy: "auto", questions: [], note: null };
  }
  const cap = count(new RegExp(`(?:יותר מ|מעל)[-־\\s]*${W}\\s*לידים\\s*(?:שטרם|שלא|ממתינים|פתוחים)`));
  if (cap && /(עצור|תעצור|הפסק|לא לתת|אל תקצה|תפסיק)/.test(t)) {
    return { kind: "load_cap", name: `עצירת הקצאה מעל ${cap} לידים שטרם טופלו`, config: { maxUntouched: cap }, autonomy: "auto", questions: [], note: null };
  }
  if (/(סוגר|סגירות|ביצועים|מומנטום)/.test(t) && /(לידים|הקצ)/.test(t)) {
    const pending = count(new RegExp(`(?:פחות מ|עד)[-־\\s]*${W}\\s*לידים`));
    const cfg: Record<string, unknown> = {};
    if (pending) cfg.maxUntouched = pending; else q.push({ field: "maxUntouched", question: "מה נחשב ״מעט לידים ממתינים״?", proposed: 5 });
    if (VAGUE.test(t) && !/מעל הממוצע/.test(t)) q.push({ field: "liftFactor", question: `מה נחשב ביצועים "${t.match(VAGUE)![1]}"? מוצע: שיעור סגירה של פי 1.5 מהממוצע האישי`, proposed: 1.5 });
    if (/מעל הממוצע/.test(t)) { cfg.liftFactor = 1.2; q.push({ field: "liftFactor", question: "״מעל הממוצע״ – בכמה? מוצע: לפחות פי 1.2 מהממוצע האישי (ובביטחון סטטיסטי, לא על סמך עסקה אחת)", proposed: 1.2 }); }
    const extra = count(new RegExp(`${W}\\s*לידים\\s*(?:נוספים|חדשים)`));
    if (extra) cfg.count = extra;
    const autonomy: Autonomy = /(תציע|הצע|תמליץ|תתריע)/.test(t) ? "recommend" : /(תעביר|תקצה|תן לו|תבצע)/.test(t) ? "auto" : "recommend";
    return { kind: "momentum", name: "נציג במומנטום – לידים נוספים", config: cfg, autonomy, questions: q, note: autonomy === "auto" ? "ביצוע אוטומטי של שינוי חלוקה כפוף למדיניות האישור (ברירת מחדל: אישור מנהל)." : null };
  }
  return { kind: null, name: "", config: {}, autonomy: "recommend", questions: [{ field: "kind", question: "לא הצלחתי להבין את הכלל. אפשר לנסח מחדש: מתי (טריגר), באיזה מצב (תנאי), ומה לעשות (פעולה)?", proposed: "" }], note: null };
}

async function parseRuleAi(text: string): Promise<Omit<Interpretation, "summary" | "analyzer"> | null> {
  const system = [
    "אתה מתרגם כללי תפעול של מנהל מכירות לכלל מובנה אחד. החזר JSON בלבד. אל תמציא ערכים לביטויים עמומים (חזק, הרבה, מעט) – במקום זה הוסף שאלה עם סף מוצע.",
    "סוגים ושדות config (השמט שדה שלא נאמר):",
    "momentum: {minHandled,minWins,liftFactor,confidence(0.8|0.9|0.95),compareToPeers,maxUntouched,mode(extra|priority|share),count,sharePct,source}",
    "extra_leads_policy: {askAgent,requestMinutes}",
    "availability: {ttlMinutes,fallback(alert_manager|transfer_to_available|none),unattendedAfterMinutes}",
    "load_cap: {maxUntouched}",
    "approval_policy: {actions:[assignment|ownership]}",
    'פורמט: {"kind":..., "name":"שם קצר בעברית", "config":{...}, "autonomy":"insight|recommend|auto", "questions":[{"field","question","proposed"}], "note":null}. אם אין התאמה: kind=null ושאלה.',
  ].join("\n");
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: process.env.AI_SERVICE_MODEL ?? "claude-sonnet-5", max_tokens: 600, temperature: 0, system, messages: [{ role: "user", content: `<rule>${text.slice(0, 1000)}</rule>` }] }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const raw = ((await res.json()) as { content: Array<{ type: string; text?: string }> }).content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Partial<Interpretation>;
  const kind = RULE_KINDS.includes(j.kind as RuleKind) ? (j.kind as RuleKind) : null;
  const autonomy = (["insight", "recommend", "auto"].includes(String(j.autonomy)) ? j.autonomy : "recommend") as Autonomy;
  return { kind, name: String(j.name ?? "").slice(0, 120), config: (j.config ?? {}) as Record<string, unknown>, autonomy, questions: Array.isArray(j.questions) ? j.questions.slice(0, 5) : [], note: j.note ?? null };
}

/** Translate a manager's sentence into a rule proposal (not saved). */
export async function interpretRule(text: string): Promise<Interpretation> {
  let r: Omit<Interpretation, "summary" | "analyzer"> | null = null; let analyzer: Interpretation["analyzer"] = "rules";
  if (aiConnected()) { try { r = await parseRuleAi(text); if (r) analyzer = "ai"; } catch { r = null; } }
  if (!r || !r.kind) { const b = parseRuleBasic(text); if (!r || b.kind) { r = b; analyzer = "rules"; } }
  if (!r.kind) return { ...r, summary: null, analyzer };
  // Keep only what the schema knows; a value the schema rejects becomes a question instead of a guess.
  const kind = r.kind;
  let config: Record<string, unknown>;
  try { config = parseConfig(kind, r.config) as Record<string, unknown>; }
  catch (e) { config = parseConfig(kind, {}) as Record<string, unknown>; r.questions.push({ field: "config", question: `ערך לא תקין: ${(e as Error).message}. יוצגו ערכי ברירת המחדל לאישור.`, proposed: "" }); }
  const autonomy: Autonomy = ALLOWED_AUTONOMY[kind].includes(r.autonomy) ? r.autonomy : ALLOWED_AUTONOMY[kind].includes("recommend") ? "recommend" : ALLOWED_AUTONOMY[kind][0];
  return { ...r, kind, config, autonomy, name: r.name || KIND_LABEL[kind], summary: describeRule(kind, config, autonomy), analyzer };
}
