/**
 * "מנהל AI" rules: structured, typed configs per kind (trigger · conditions · action · scope · validity · limits ·
 * approval). Free text is translated into ONE of these kinds – by the model when connected, otherwise by a
 * conservative pattern parser – and is never saved before the manager saw the plain-language summary. Vague words
 * ("חזק", "הרבה") are never given a meaning silently: a concrete threshold is proposed as a question.
 */
import { knownProductGap, UNSUPPORTED_REQUEST } from "@/server/ai/capabilities";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { aiConnected } from "@/server/ai/settings";

export const RULE_KINDS = ["momentum", "extra_leads_policy", "availability", "lead_response_sla", "followup_checkin", "load_cap", "approval_policy"] as const;
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
export const leadResponseSlaConfig = z.object({ minutes: z.number().int().min(1).max(1440).default(5), businessHoursOnly: z.boolean().default(false), onBreach: z.enum(["alert","transfer_to_available"]).default("alert") });
export const followupCheckinConfig = z.object({
  requestMinutes: z.number().int().min(2).max(120).default(10),
  connectMinutes: z.number().int().min(1).max(60).default(5),
});
export const loadCapConfig = z.object({ maxUntouched: z.number().int().min(1).max(500).default(15) });
export const approvalPolicyConfig = z.object({ actions: z.array(z.enum(["assignment", "ownership"])).min(1).default(["assignment", "ownership"]) });

export const CONFIG_SCHEMAS = { momentum: momentumConfig, extra_leads_policy: extraLeadsPolicyConfig, availability: availabilityConfig, lead_response_sla: leadResponseSlaConfig, followup_checkin: followupCheckinConfig, load_cap: loadCapConfig, approval_policy: approvalPolicyConfig } as const;
export type RuleConfig<K extends RuleKind> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

export const KIND_LABEL: Record<RuleKind, string> = { momentum: "נציג במומנטום", extra_leads_policy: "לידים נוספים באישור נציג", availability: "זמינות מוואטסאפ", lead_response_sla: "יעד זמן לחיוג ראשון", followup_checkin: "פולואפ לנציג שאינו מחובר", load_cap: "עצירת הקצאה בעומס", approval_policy: "מדיניות אישור" };
export const AUTONOMY_LABEL: Record<Autonomy, string> = { insight: "תובנה בלבד", recommend: "המלצה באישור", auto: "ביצוע אוטומטי בגבולות" };
const DEFAULT_AUTONOMY: Record<RuleKind, Autonomy> = { momentum: "recommend", extra_leads_policy: "auto", availability: "auto", lead_response_sla: "insight", followup_checkin: "recommend", load_cap: "auto", approval_policy: "auto" };
/** Which autonomy levels make sense per kind. */
export const ALLOWED_AUTONOMY: Record<RuleKind, Autonomy[]> = { momentum: ["insight", "recommend", "auto"], extra_leads_policy: ["auto"], availability: ["recommend", "auto"], lead_response_sla: ["insight", "auto"], followup_checkin: ["recommend", "auto"], load_cap: ["insight", "auto"], approval_policy: ["auto"] };

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
  if (kind === "lead_response_sla") {
    const c = parseConfig("lead_response_sla", config);
    return { trigger: "ליד חדש שנכנס אחרי יצירת הכלל או עדכונו; בדיקה כל 2 דקות", conditions: "ליד פתוח, ללא חסימה או הסרה", action: `יעד לחיוג ראשון: ${c.minutes} דקות מקבלת הליד. בחריגה: התראה לנציג ולמנהל ומעקב עד ניסיון חיוג בפועל.`, scope: "כל הלידים החדשים בעסק", validity: c.businessHoursOnly ? "זמן עבודה בלבד, לפי חלון החיוג של העסק כפי שהיה בעת כניסת הליד" : "דקות שעון, כולל מחוץ לשעות העבודה; הכלל פועל רק כשמנהל AI פעיל", limits: "נמדד ניסיון חיוג ולא מענה או מכירה. שינוי סטטוס אינו חיוג. העברה, אם נבחרה, אפשרית פעם אחת בלבד לנציג מחובר ופנוי עם קיבולת ובהתאם למדיניות אישור בעלות. אחרת נשלחת התראה.", approval: c.onBreach === "transfer_to_available" ? "נבחרה העברה: נדרש מצב אוטומטי והיתר במדיניות הבעלות; אחרת טיפול מנהל" : "התראה ומדידה בלבד" };
  }
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
  if (kind === "followup_checkin") {
    const c = parseConfig("followup_checkin", config);
    return { trigger: "הגיע זמן פולואפ (בדיקה כל 2 דקות; עד 24 שעות איחור)", conditions: "הפולואפ פתוח והנציג אינו מחובר לחייגן", action: "לשאול את הנציג בוואטסאפ ובמערכת: מתחבר או להעביר? התחברות → להמתין ולבדוק; העברה מפורשת → נציג מחובר ומורשה, בכפוף למדיניות אישור מנהל", scope: "כל פולואפ פעם אחת למועדו; ללא שינוי בתור העבודה", validity: "תשובה תוך " + c.requestMinutes + " דקות; התחברות תוך " + c.connectMinutes + " דקות", limits: "אין תשובה, תשובה עמומה או הבטחה שלא קוימה אינם אישור העברה; במקרה הצורך מתריעים למנהל. שינוי כלל/פולואפ מבטל בקשה ישנה", approval: autonomy === "auto" ? "אחרי בקשת העברה מפורשת של הנציג, ובכפוף למדיניות אישור מנהל" : "הנציג מתבקש לענות; העברה דורשת גם אישור מנהל" };
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
  allowedAutonomy?: Autonomy[]; kind: RuleKind | null; name: string; config: Record<string, unknown>; autonomy: Autonomy;
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

  if (/(ליד|לידים)/.test(t) && /(חיוג ראשון|תגובה ראשונה|זמן תגובה|לא חייג|לא טופל|בלי טיפול)/.test(t)) {
    if (/(תחייג אוטומטית)/.test(t)) return { kind: null, name: "", config: {}, autonomy: "insight", questions: [], note: "חיוג אוטומטי מתוך כלל זמן תגובה אינו נתמך. אפשר להגדיר התראה או העברה מוגבלת לפי מדיניות הבעלות." };
    const transferRequested=/(תעביר|העבר|להעביר)/.test(t)&&!/(?:לא|אל)\s+(?:תעביר|העבר|להעביר)|בלי העברה/.test(t);
    if(transferRequested&&/(רק אם|בתנאי|למעט|חוץ מ|לצוות|לנציג בשם)/.test(t))return {kind:null,name:"",config:{},autonomy:"insight",questions:[],note:"תנאי ההעברה הנוספים אינם נתמכים בכלל זה. אין להפעיל העברה בלי התנאים שביקשת."};
    if (!minutes) q.push({ field: "minutes", question: "כמה דקות מקבלת הליד עד לחיוג ראשון?", proposed: 5 });
    return { kind: "lead_response_sla", name: "יעד זמן לחיוג ראשון", config: { minutes: minutes ?? 5, businessHoursOnly: /(בשעות העבודה|שעות פעילות|שעות עבודה בלבד)/.test(t), onBreach: transferRequested?"transfer_to_available":"alert" }, autonomy: transferRequested?"auto":"insight", questions: q, note: "נמדד ניסיון חיוג אמיתי בלבד. אפשר לבקש מדידה בשעות העבודה בלבד." };
  }
  if (/(פולואפ|פולו.?אפ|follow.?up|חזרה מתוזמנת)/i.test(t) && /(לא מחובר|אינו מחובר|מנותק|לא עולה)/.test(t)) {
    q.push({ field: "requestMinutes", question: "כמה דקות להמתין לתשובת הנציג?", proposed: 10 }, { field: "connectMinutes", question: "כמה דקות להמתין אם הנציג אומר שהוא מתחבר?", proposed: 5 });
    return { kind: "followup_checkin", name: "פולואפ הגיע – לשאול נציג שאינו מחובר", config: {}, autonomy: "recommend", questions: q, note: "אם אין תשובה או שאין נציג יעד זמין, נתריע למנהל בלי להעביר. מצב אוטומטי עדיין כפוף למדיניות אישור מנהל." };
  }
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
    "lead_response_sla: {minutes(1..1440),businessHoursOnly(boolean=false),onBreach(alert|transfer_to_available)} – מדידת חיוג ראשון. insight להתראה, auto רק אם ביקשו במפורש העברה בחריגה. העברה כפופה למדיניות אישור בעלות ולנציג מחובר עם קיבולת. חיוג אוטומטי לא נתמך בכלי זה.",
    "followup_checkin: {requestMinutes(2..120),connectMinutes(1..60)} – פולואפ מתוזמן שהגיע כשהנציג אינו מחובר; שואלים אותו אם מתחבר או להעביר. אין תשובה אינה אישור העברה.",
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
  const gap = knownProductGap(text);
  if (gap) return { kind: null, name: "", config: {}, autonomy: "recommend", questions: [], summary: null, analyzer: "rules", note: UNSUPPORTED_REQUEST + " חסר: " + gap + "." };
  let r: Omit<Interpretation, "summary" | "analyzer"> | null = null; let analyzer: Interpretation["analyzer"] = "rules";
  if (aiConnected()) { try { r = await parseRuleAi(text); if (r) analyzer = "ai"; } catch { r = null; } }
  // Respect an explicit model refusal: a keyword fallback could silently drop unsupported clauses.
  if (!r) { r = parseRuleBasic(text); analyzer = "rules"; }
  if (!r.kind) return { ...r, summary: null, analyzer, note: r.note ?? "אין כרגע כלל נתמך שמתאים לבקשה הזו. לא נשמר ולא הופעל דבר. אם זו הפעולה שהתכוונת אליה, נדרש לפתח תמיכה בה; אם חסר פרט אפשר לנסח מחדש." };
  // Keep only what the schema knows; a value the schema rejects becomes a question instead of a guess.
  const kind = r.kind;
  let config: Record<string, unknown>;
  try { config = parseConfig(kind, r.config) as Record<string, unknown>; }
  catch (e) { config = parseConfig(kind, {}) as Record<string, unknown>; r.questions.push({ field: "config", question: `ערך לא תקין: ${(e as Error).message}. יוצגו ערכי ברירת המחדל לאישור.`, proposed: "" }); }
  const autonomy: Autonomy = ALLOWED_AUTONOMY[kind].includes(r.autonomy) ? r.autonomy : ALLOWED_AUTONOMY[kind].includes("recommend") ? "recommend" : ALLOWED_AUTONOMY[kind][0];
  return { ...r, kind, config, autonomy, allowedAutonomy: ALLOWED_AUTONOMY[kind], name: r.name || KIND_LABEL[kind], summary: describeRule(kind, config, autonomy), analyzer };
}
