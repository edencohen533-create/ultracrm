/**
 * "תוסיף ליד: דנה כהן, 0501234567, מגנזיום, מקור פייסבוק" – an authorized, verified internal user creates a lead
 * from the WhatsApp assistant. Only reached for a verified AssistantLink of this business (customers never get here).
 *
 *  • Free text: labeled ("טלפון 050…", "מוצר …", "מקור …") or plain comma-separated parts, in any order.
 *  • A missing field → one focused question (the draft is kept on the link for 30 minutes; "בטל" drops it).
 *    Product / source may be answered "אין" – they are then left empty, never guessed.
 *  • Product: matched to the business's known products (coach knowledge, sold items, earlier leads). Several matches
 *    → the user picks one. Nothing known → the user's own words.
 *  • Source: a general source ("פייסבוק") is a source only – no campaign or ad is ever derived from it.
 *  • Phone normalized; the block list (DNC / do-not-contact / blocked contact) refuses; an existing open lead is not
 *    duplicated; a contact of another agent is not touched; the new lead goes through the existing assignment rules.
 *  • A retried webhook is dropped by the caller (inbound key); the message key is also remembered here.
 *  • The confirmation (with the link) is sent only after the lead was saved.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth";
import { normalizePhone, formatPhoneDisplay } from "@/lib/phone";
import { appBase } from "@/lib/store-urls";
import { withBusiness } from "@/lib/tenant";
import { OPEN_LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/crm/labels";

export interface LeadDraft {
  name?: string;
  phoneRaw?: string;
  /** undefined = not given yet; null = the user said there is none. */
  product?: string | null;
  source?: string | null;
  productOptions?: string[];
  awaiting?: "name" | "phone" | "product" | "product_choice" | "source";
  at: string;
}
type Memory = Record<string, unknown> & { leadDraft?: LeadDraft; lastLeadKey?: string };

const DRAFT_TTL_MS = 30 * 60_000;
const END = "(?=[\\s:,.\\-–]|$)";
const TRIGGER = new RegExp(`^\\s*(?:(?:תוסיף|תוסיפי|תוסיפו|הוסף|הוסיפי|להוסיף|צור|תיצור|תצור|צרי|פתח|תפתח|תפתחי|לפתוח|רשום|תרשום|תרשמי)\\s+(?:לי\\s+|בבקשה\\s+)?(?:ליד|לייד)|ליד\\s+חדש|add\\s+lead|new\\s+lead)${END}`, "i");
const NONE = /^(אין|אין לי|לא ידוע|לא יודע|לא יודעת|לא רלוונטי|ללא|-|none|n\/a)[.!]?$/i;
const CANCEL = /^(בטל|ביטול|תבטל|עזוב|לא משנה|cancel)[.!]?$/i;

const SOURCE_ALIASES: Array<[string, string[]]> = [
  ["פייסבוק", ["פייסבוק", "פיסבוק", "facebook", "fb", "מטא", "meta"]],
  ["אינסטגרם", ["אינסטגרם", "אינסטה", "instagram", "ig"]],
  ["גוגל", ["גוגל", "google"]],
  ["טיקטוק", ["טיקטוק", "tiktok"]],
  ["אתר", ["אתר", "האתר", "website", "site"]],
  ["המלצה", ["המלצה", "חבר מביא חבר", "referral"]],
  ["וואטסאפ", ["וואטסאפ", "ווטסאפ", "whatsapp"]],
  ["שיחה נכנסת", ["שיחה נכנסת", "טלפון נכנס"]],
];
const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s:,.\-–]+|[\s:,.\-–]+$/g, "").trim();
const norm = (s: string) => clean(s).toLowerCase();

/** A known source word ("פייסבוק", "מפייסבוק", "facebook") → its group, else null. */
function sourceGroup(value: string): [string, string[]] | null {
  const v = norm(value).replace(/^(מה|מ)(?=\S{3,})/, "");
  const w = norm(value);
  return SOURCE_ALIASES.find(([, aliases]) => aliases.includes(w) || aliases.includes(v)) ?? null;
}

const LABELS: Array<[keyof LeadDraft, RegExp]> = [
  ["name", /^(?:שם|בשם|שם מלא|name)\s*[:\-–]?\s*/i],
  ["phoneRaw", /^(?:טלפון|טל'?|נייד|מספר טלפון|מספר|phone)\s*[:\-–]?\s*/i],
  ["product", /^(?:מוצר|המוצר|product)\s*[:\-–]?\s*/i],
  ["source", /^(?:מקור|המקור|הגיע(?:ה)? מ|source)\s*[:\-–]?\s*/i],
];
const PHONE = /\+?\d[\d\s\-().]{6,}\d/;

/** Parse the free text after the trigger into draft fields (only what is actually written). */
export function parseLeadText(text: string): Omit<LeadDraft, "at"> {
  const out: Omit<LeadDraft, "at"> = {};
  const segments = text.split(/[,\n;،]+/).flatMap((s) => s.split(/\s+(?=(?:מוצר|מקור|טלפון|נייד|product|source|phone)(?:\s|:))/i)).map(clean).filter(Boolean);
  const plain: string[] = [];
  for (const seg of segments) {
    const labeled = LABELS.find(([, re]) => re.test(seg));
    if (labeled) {
      let value = clean(seg.replace(labeled[1], ""));
      // "בשם שירה 0521112233" – a phone written inside another labeled value is still the phone.
      const inner = labeled[0] !== "phoneRaw" ? value.match(PHONE) : null;
      if (inner && !out.phoneRaw) { out.phoneRaw = clean(inner[0]); value = clean(value.replace(inner[0], " ")); }
      if (!value) continue;
      if (labeled[0] === "product" || labeled[0] === "source") (out as Record<string, unknown>)[labeled[0]] = NONE.test(value) ? null : value;
      else (out as Record<string, unknown>)[labeled[0]] = value;
      continue;
    }
    const m = seg.match(PHONE);
    if (m && !out.phoneRaw) {
      out.phoneRaw = clean(m[0]);
      for (const rest of [seg.slice(0, m.index), seg.slice((m.index ?? 0) + m[0].length)].map(clean)) if (rest) plain.push(rest);
      continue;
    }
    plain.push(seg);
  }
  for (const seg of plain) {
    const src = sourceGroup(seg);
    if (src && out.source === undefined) { out.source = src[0]; continue; }
    if (out.name === undefined) { out.name = seg; continue; }
    if (out.product === undefined) { out.product = seg; continue; }
    if (out.source === undefined) { out.source = seg; continue; }
  }
  if (out.source) { const g = sourceGroup(out.source); if (g) out.source = g[0]; }
  return out;
}

/** Products the business already knows: coach knowledge, sold items, earlier leads' product field. */
async function knownProducts(businessId: string): Promise<string[]> {
  const [k, items, contacts] = await Promise.all([
    prisma.coachKnowledge.findUnique({ where: { businessId }, select: { products: true } }),
    prisma.dealItem.findMany({ where: { businessId }, distinct: ["name"], select: { name: true }, take: 200 }),
    prisma.$queryRaw<Array<{ p: string }>>`SELECT DISTINCT custom_fields->>'product' AS p FROM contacts WHERE business_id = ${businessId} AND custom_fields ? 'product' LIMIT 200`,
  ]);
  const fromKnowledge = (Array.isArray(k?.products) ? k!.products : []).map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).name : null)).filter((n): n is string => typeof n === "string");
  const all = [...fromKnowledge, ...items.map((i) => i.name), ...contacts.map((c) => c.p)].map(clean).filter((n) => n.length >= 2);
  const seen = new Map<string, string>();
  for (const n of all) if (!seen.has(norm(n))) seen.set(norm(n), n);
  return [...seen.values()];
}

/** Exact known product → it; one partial match → it; several → ask; none known → the user's words as given. */
export function matchProduct(input: string, catalog: string[]): { value: string } | { options: string[] } {
  const q = norm(input);
  const exact = catalog.find((p) => norm(p) === q);
  if (exact) return { value: exact };
  const partial = catalog.filter((p) => { const n = norm(p); return n.includes(q) || (q.length >= 3 && q.includes(n)); });
  if (partial.length === 1) return { value: partial[0] };
  if (partial.length > 1) return { options: partial.slice(0, 8) };
  return { value: clean(input) };
}

async function preferredSource(businessId: string, source: string) {
  const g = SOURCE_ALIASES.find(([canon]) => canon === source);
  if (!g) return source;
  const existing = await prisma.lead.findMany({ where: { businessId, source: { not: null } }, distinct: ["source"], select: { source: true }, take: 200 });
  return existing.map((e) => e.source!).find((s) => g[1].includes(norm(s)) || norm(s) === norm(g[0])) ?? source;
}

const QUESTION: Record<NonNullable<LeadDraft["awaiting"]>, (d: LeadDraft) => string> = {
  name: () => "📝 ליד חדש – מה שם הליד?",
  phone: (d) => `📝 ליד חדש${d.name ? ` ל${d.name}` : ""} – מה מספר הטלפון?`,
  product: (d) => `📝 ליד חדש${d.name ? ` ל${d.name}` : ""} – איזה מוצר? (אם אין – השב "אין")`,
  product_choice: (d) => `📝 יש כמה מוצרים מתאימים. איזה מהם?\n${(d.productOptions ?? []).map((o, i) => `${i + 1}. ${o}`).join("\n")}\nהשב במספר או בשם המוצר.`,
  source: (d) => `📝 ליד חדש${d.name ? ` ל${d.name}` : ""} – מה המקור? (למשל פייסבוק, אתר, המלצה; אם לא ידוע – השב "אין")`,
};

export interface LeadCommandResult { handled: boolean; reply?: string; memory: Memory; leadId?: string }

/**
 * Called for every message of a verified, permitted link. Returns handled=false when the message is not about
 * creating a lead (and no draft is waiting), so the normal assistant answers it.
 */
export async function handleLeadCommand(input: { user: SessionUser; text: string; memory: Memory; messageKey: string | null; mayCreate: boolean; isOtherQuestion: (text: string) => boolean }): Promise<LeadCommandResult> {
  const { user, text } = input;
  const memory: Memory = { ...input.memory };
  const trimmed = text.trim();
  let draft = memory.leadDraft && Date.now() - Date.parse(memory.leadDraft.at) < DRAFT_TTL_MS ? { ...memory.leadDraft } : undefined;
  const isTrigger = TRIGGER.test(trimmed);
  if (!isTrigger && !draft) {
    if (memory.leadDraft) { delete memory.leadDraft; return { handled: false, memory }; }
    return { handled: false, memory };
  }
  const done = (reply: string, extra: Partial<LeadCommandResult> = {}): LeadCommandResult => { delete memory.leadDraft; return { handled: true, reply, memory, ...extra }; };
  if (!input.mayCreate) return done("⛔ אין לך הרשאה ליצור לידים בעסק הזה.");
  if (input.messageKey && memory.lastLeadKey === input.messageKey) return { handled: true, memory }; // the same message again

  if (isTrigger) {
    draft = { ...parseLeadText(trimmed.replace(TRIGGER, "")), at: new Date().toISOString() };
  } else if (draft) {
    if (CANCEL.test(trimmed)) return done("בוטל – לא נוצר ליד.");
    const answer = clean(trimmed);
    const labeled = parseLeadText(trimmed);
    const hasLabel = LABELS.some(([, re]) => trimmed.split(/[,\n]+/).some((s) => re.test(clean(s))));
    if (hasLabel) Object.assign(draft, Object.fromEntries(Object.entries(labeled).filter(([, v]) => v !== undefined)));
    else switch (draft.awaiting) {
      case "phone":
        if (!PHONE.test(answer)) { if (input.isOtherQuestion(trimmed)) { delete memory.leadDraft; return { handled: false, memory }; } return { handled: true, reply: `⚠️ לא זיהיתי מספר טלפון. ${QUESTION.phone(draft)} (או "בטל")`, memory: { ...memory, leadDraft: draft } }; }
        draft.phoneRaw = answer.match(PHONE)![0];
        break;
      case "name":
        if (input.isOtherQuestion(trimmed) || answer.length > 80 || /\?/.test(answer)) { delete memory.leadDraft; return { handled: false, memory }; }
        draft.name = answer;
        break;
      case "product_choice": {
        const opts = draft.productOptions ?? [];
        const n = Number(answer);
        const pick = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1] : opts.find((o) => norm(o) === norm(answer));
        if (!pick) return { handled: true, reply: `⚠️ לא זיהיתי את הבחירה. ${QUESTION.product_choice(draft)}`, memory: { ...memory, leadDraft: draft } };
        draft.product = pick; draft.productOptions = undefined;
        break;
      }
      case "product":
        if (input.isOtherQuestion(trimmed)) { delete memory.leadDraft; return { handled: false, memory }; }
        draft.product = NONE.test(answer) ? null : answer;
        break;
      case "source":
        if (input.isOtherQuestion(trimmed)) { delete memory.leadDraft; return { handled: false, memory }; }
        draft.source = NONE.test(answer) ? null : (sourceGroup(answer)?.[0] ?? answer);
        break;
      default:
        delete memory.leadDraft; return { handled: false, memory };
    }
  }
  if (!draft) return { handled: false, memory };
  draft.at = new Date().toISOString();

  return withBusiness(user.businessId, async () => {
    const ask = (next: NonNullable<LeadDraft["awaiting"]>): LeadCommandResult => { draft!.awaiting = next; return { handled: true, reply: QUESTION[next](draft!), memory: { ...memory, leadDraft: draft! } }; };
    // Identity first (name, a valid phone), then the product (resolved against what the business knows), then source.
    if (draft!.phoneRaw && !normalizePhone(draft!.phoneRaw)) {
      const bad = draft!.phoneRaw; draft!.phoneRaw = undefined; draft!.awaiting = "phone";
      return { handled: true, reply: `⚠️ המספר ${bad} אינו מספר טלפון תקין. ${QUESTION.phone(draft!)}`, memory: { ...memory, leadDraft: draft! } };
    }
    if (!draft!.name) return ask("name");
    if (!draft!.phoneRaw) return ask("phone");
    if (typeof draft!.product === "string" && draft!.awaiting !== "product_choice") {
      const m = matchProduct(draft!.product, await knownProducts(user.businessId));
      if ("options" in m) { draft!.productOptions = m.options; return ask("product_choice"); }
      draft!.product = m.value;
    }
    if (draft!.product === undefined) return ask("product");
    if (draft!.source === undefined) return ask("source");
    const r = await createLeadFromDraft(user, draft!);
    delete memory.leadDraft;
    if (input.messageKey) memory.lastLeadKey = input.messageKey;
    return { handled: true, reply: r.reply, memory, leadId: r.leadId };
  }, user);
}

async function createLeadFromDraft(user: SessionUser, d: LeadDraft): Promise<{ reply: string; leadId?: string }> {
  const [{ callBlockReason, contactForIdentifier }, { canAccessContact }, { findOrCreateContactByPhone }, { createLead }] = await Promise.all([
    import("@/lib/suppression"), import("@/lib/crm/lead-ops"), import("@/lib/crm/contacts"), import("@/lib/crm/pipeline"),
  ]);
  const e164 = normalizePhone(d.phoneRaw!)!;
  const shown = formatPhoneDisplay(e164);
  const existingId = await contactForIdentifier(user.businessId, e164);
  const blocked = await callBlockReason(user.businessId, e164, undefined, { contactId: existingId });
  if (blocked) return { reply: `⛔ לא נוצר ליד: ${blocked} (${shown}).` };
  const existing = existingId ? await prisma.contact.findFirst({ where: { id: existingId, businessId: user.businessId }, select: { id: true, fullName: true, ownerUserId: true, customFields: true } }) : null;
  if (existing && !(await canAccessContact(user, existing))) return { reply: `⚠️ המספר ${shown} שייך ללקוח קיים שמשויך לנציג אחר. לא נוצר ליד – פנה למנהל.` };
  if (existing) {
    const open = await prisma.lead.findFirst({ where: { businessId: user.businessId, contactId: existing.id, status: { in: [...OPEN_LEAD_STATUSES] } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, owner: { select: { fullName: true } } } });
    if (open) return { reply: `ℹ️ כבר קיים ליד פתוח ל${existing.fullName} (${shown}) – סטטוס: ${LEAD_STATUS_LABEL[open.status]}, נציג: ${open.owner?.fullName ?? "טרם שויך"}. לא נוצר ליד כפול.\n🔗 ${appBase()}/leads/${open.id}` };
  }
  const source = d.source ? await preferredSource(user.businessId, d.source) : null;
  const contact = existing ?? await findOrCreateContactByPhone(user.businessId, e164, { fullName: d.name!, phoneRaw: d.phoneRaw!, source: source ?? "עוזר וואטסאפ" });
  if (d.product) {
    const cf = (contact.customFields && typeof contact.customFields === "object" ? contact.customFields : {}) as Record<string, unknown>;
    await prisma.contact.update({ where: { id: contact.id }, data: { customFields: { ...cf, product: d.product } as Prisma.InputJsonValue } });
  }
  const lead = await createLead(user, { contactId: contact.id, ...(source ? { source } : {}), notes: `נוצר דרך העוזר בוואטסאפ על ידי ${user.fullName}` }, "user", { channel: "manual", dataSource: "assistant" });
  // Assignment runs through the existing rules (lead.created handler); run it now so the reply can name the agent.
  const { processDomainEvents } = await import("@/lib/events");
  await processDomainEvents({ businessId: user.businessId, limit: 10, deadline: Date.now() + 8_000 }).catch(() => undefined);
  const saved = await prisma.lead.findUnique({ where: { id: lead.id }, select: { source: true, owner: { select: { fullName: true } } } });
  const lines = [
    "✅ הליד נשמר",
    ...(lead.existingCustomer ? [lead.reviewReason ? "👤 לקוח קיים – אין נציג מטפל פעיל, ממתין לשיוך על ידי מנהל" : "👤 לקוח קיים – נפתחה הזדמנות חדשה אצל הנציג המטפל (לא ליד חדש)"] : []),
    `שם: ${contact.fullName}${existing && existing.fullName !== d.name ? ` (איש קשר קיים; נכתב: ${d.name})` : ""}`,
    `טלפון: ${shown}`,
    `מוצר: ${d.product ?? "לא צוין"}`,
    `מקור: ${saved?.source ?? "לא צוין"}`,
    "קמפיין / מודעה: לא ידוע",
    `נציג: ${saved?.owner?.fullName ?? "טרם שויך (ישויך לפי כללי החלוקה)"}`,
    `🔗 ${appBase()}/leads/${lead.id}`,
  ];
  return { reply: lines.join("\n"), leadId: lead.id };
}
