/**
 * "I didn't get the magnesium" – checking a missing-item complaint against the facts, never against a guess.
 *
 * 1. The customer is the conversation's contact (verified by the WhatsApp sender); only her orders in THIS business are
 *    read (store orders linked to the contact or her phone, and phone sales with items). Several possible orders and no
 *    way to tell → one focused question, no conclusion.
 * 2. Product + quantity are compared with the order AS SOLD: bundle components (component lines or the bundle's
 *    composition at purchase time), gifts / benefits, refunded / removed / cancelled quantities, split shipments.
 *    A product inside a bundle is ordered even when it is not a line of its own.
 * 3. Sources that disagree (receipt vs order, shipped more than ordered) → a person decides – no source is picked.
 * 4. "It was promised to me" → documented promises are searched (outgoing messages, notes, call promises /
 *    agreements / transcript / outcome note). Found → a person with the exact references. Not found → a person too:
 *    a missing record does not prove nothing was promised.
 * An order / receipt proves what was recorded or charged – not what was packed; "delivered" does not prove every
 * item arrived. The customer is never told she is wrong, nothing is sold during the check, and no replacement or
 * refund is promised – those need an authorized person and process.
 * The result is kept in the customer file as a ServiceCase (one per order + product – no duplicate cases).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { OrderItem, Shipment, Receipt, OrderChange } from "@/server/services/store-order-service";

export type Finding = "not_ordered" | "ordered_not_received" | "partial" | "shipped_separately" | "promised" | "conflict" | "needs_info";
export interface SourceRef { type: "order" | "receipt" | "shipment" | "change" | "message" | "note" | "call"; id: string; label: string; at?: string }
export interface MissingItemResult {
  finding: Finding;
  /** reply = answer the customer; ask = one focused question; handoff = a person continues (case open). */
  action: "reply" | "ask" | "handoff";
  customerMessage: string;
  agentSummary: string;
  claim: { product: string; quantity: number | null; promised: boolean };
  order: { id: string; number: string; placedAt: string | null; status: string; lines: string[] } | null;
  orderedQuantity: number | null;
  sources: SourceRef[];
  caseId: string | null;
  duplicateCase: boolean;
}
interface Candidate { id: string; storeOrderId: string | null; number: string; placedAt: Date | null; status: string; items: OrderItem[]; shipments: Shipment[]; receipt: Receipt | null; changes: OrderChange[]; label: string }

// ─── Product matching (Hebrew aware, no catalog lookup – the order text as sold) ─────────────────────────────────
const STOP = new Set(["של", "את", "עם", "לא", "קיבלתי", "הגיע", "הגיעה", "הגיעו", "חסר", "חסרה", "חסרים", "יחידות", "יחידה", "מוצר", "המוצר", "לי", "גם", "אחד", "אחת", "שני", "שתי", "בקבוק", "בקבוקים", "קופסה", "קופסאות"]);
const norm = (s: string) => s.toLowerCase().replace(/[֑-ׇ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function tokens(s: string) {
  return norm(s).split(" ").filter((t) => t.length >= 2 && !STOP.has(t));
}
/** A Hebrew word may carry a one / two letter prefix (ה, ו, ב, ל, מ, ש, כ; "וה", "שה"…) – but "מגנזיום" / "ויטמין"
 *  start with those letters too, so both forms are tried instead of always stripping. */
function variants(t: string) {
  const out = [t];
  if (/^[והבלמשכ][\u05D0-\u05EA]{3,}$/.test(t)) out.push(t.slice(1));
  if (/^[וש][הבלמ][\u05D0-\u05EA]{3,}$/.test(t)) out.push(t.slice(2));
  return out;
}
const tokenHit = (c: string, n: string) => variants(c).some((cv) => variants(n).some((nv) => nv.startsWith(cv) || (nv.length >= 3 && cv.startsWith(nv) && cv.length - nv.length <= 2)));
export function productMatches(claim: string, name: string, sku?: string) {
  if (sku && norm(claim).split(" ").includes(norm(sku))) return true;
  const ct = tokens(claim); const nt = tokens(name);
  return ct.length > 0 && ct.every((c) => nt.some((n) => tokenHit(c, n)));
}
/** Stable key for "the same product" across wordings: the matching line of the order when there is one. */
function productKey(product: string, items: OrderItem[]) {
  const hit = items.find((i) => productMatches(product, i.name, i.sku)) ?? items.flatMap((i) => (i.components ?? []).map((c) => ({ ...c, key: "" }))).find((c) => productMatches(product, c.name, c.sku));
  if (hit) return norm(hit.name).replace(/ /g, "-");
  return tokens(product).map((t) => (/^ה[\u05D0-\u05EA]{3,}$/.test(t) ? t.slice(1) : t)).join("-");
}

/** Quantity of `product` in an order as sold (components counted inside their bundles once; refunds deducted). */
export function orderedQuantity(c: Pick<Candidate, "items" | "status">, product: string) {
  if (c.status === "cancelled") return { qty: 0, lines: [] as string[], cancelled: true };
  const parents = new Set(c.items.filter((i) => i.parentKey).map((i) => i.parentKey));
  const byKey = new Map(c.items.map((i) => [i.key, i]));
  let qty = 0; const lines: string[] = [];
  for (const i of c.items) {
    const eff = Math.max(0, i.quantity - (i.refundedQuantity ?? 0));
    if (i.kind === "bundle" && !parents.has(i.key)) {
      for (const comp of i.components ?? []) if (productMatches(product, comp.name, comp.sku)) { qty += comp.quantity * eff; lines.push(`${comp.quantity * eff} × ${comp.name} (בתוך המארז "${i.name}")`); }
      continue;
    }
    if (i.kind === "bundle") continue; // its components are separate lines
    if (!productMatches(product, i.name, i.sku)) continue;
    qty += eff;
    const parent = i.parentKey ? byKey.get(i.parentKey) : undefined;
    lines.push(`${eff} × ${i.name}${parent ? ` (בתוך המארז "${parent.name}")` : i.kind === "gift" ? " (מתנה)" : i.kind === "benefit" ? " (הטבה)" : ""}${i.refundedQuantity ? ` – ${i.refundedQuantity} זוכו` : ""}`);
  }
  return { qty, lines, cancelled: false };
}

/** Human list of what the order contains (as sold). */
export function describeOrder(c: Pick<Candidate, "items">) {
  const parents = new Set(c.items.filter((i) => i.parentKey).map((i) => i.parentKey));
  const byParent = new Map<string, OrderItem[]>();
  for (const i of c.items) if (i.parentKey) byParent.set(i.parentKey, [...(byParent.get(i.parentKey) ?? []), i]);
  const out: string[] = [];
  for (const i of c.items) {
    if (i.parentKey) continue;
    const eff = Math.max(0, i.quantity - (i.refundedQuantity ?? 0));
    if (i.kind === "bundle") {
      const comps = parents.has(i.key) ? (byParent.get(i.key) ?? []).map((x) => `${x.quantity} ${x.name}`) : (i.components ?? []).map((x) => `${x.quantity * Math.max(1, eff)} ${x.name}`);
      out.push(`${eff} × מארז ${i.name}${comps.length ? ` (כולל: ${comps.join(", ")})` : ""}`);
    } else out.push(`${eff} × ${i.name}${i.kind === "gift" ? " (מתנה)" : i.kind === "benefit" ? " (הטבה)" : ""}`);
  }
  return out;
}

const fmtDate = (d: Date | null, tz: string) => (d ? new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "numeric", month: "numeric", year: "2-digit" }).format(d) : "");
const units = (n: number) => (n === 1 ? "יחידה אחת" : `${n} יחידות`);
const PROMISE = /(מתנה|במתנה|הבטח|נוסיף|נצרף|נשלח לך|נשלח לכם|אשלח לך|יישלח|תישלח|בונוס|חינם|ללא עלות|ללא תשלום|תקבל|מקבל[תים]? גם|כלול)/;

async function candidates(businessId: string, contact: { id: string; phoneE164: string }): Promise<Candidate[]> {
  const since = new Date(Date.now() - 180 * 86400_000);
  const [orders, deals] = await Promise.all([
    prisma.storeOrder.findMany({ where: { businessId, NOT: { status: "pending" }, AND: [{ OR: [{ contactId: contact.id }, { phoneE164: contact.phoneE164 }] }, { OR: [{ placedAt: { gte: since } }, { placedAt: null }] }] }, orderBy: { placedAt: "desc" }, take: 20 }),
    prisma.deal.findMany({ where: { businessId, contactId: contact.id, status: "won", closedAt: { gte: since }, items: { some: {} } }, orderBy: { closedAt: "desc" }, take: 10, select: { id: true, title: true, closedAt: true, items: { select: { id: true, name: true, quantity: true, unitPrice: true } } } }),
  ]);
  return [
    ...orders.map((o) => ({ id: o.id, storeOrderId: o.id, number: o.orderNumber, placedAt: o.placedAt, status: o.status, items: o.items as unknown as OrderItem[], shipments: o.shipments as unknown as Shipment[], receipt: (o.receipt ?? null) as unknown as Receipt | null, changes: o.changes as unknown as OrderChange[], label: `הזמנה ${o.orderNumber}` })),
    ...deals.map((d) => ({ id: `deal:${d.id}`, storeOrderId: null, number: `מכירה טלפונית ${d.id.slice(-6)}`, placedAt: d.closedAt, status: "completed", items: d.items.map((i) => ({ key: i.id, name: i.name, quantity: i.quantity, price: Number(i.unitPrice), kind: "product" as const })), shipments: [], receipt: null, changes: [], label: `מכירה טלפונית (${d.title})` })),
  ];
}

async function documentedPromises(businessId: string, contactId: string, product: string): Promise<SourceRef[]> {
  const refs: SourceRef[] = [];
  const hit = (text: string | null | undefined) => Boolean(text && PROMISE.test(text) && tokens(product).some((t) => tokens(text).some((n) => tokenHit(t, n))));
  const snippet = (t: string) => t.replace(/\s+/g, " ").slice(0, 140);
  const [messages, notes, calls, sessions] = await Promise.all([
    prisma.message.findMany({ where: { businessId, direction: "OUTBOUND", conversation: { contactId }, body: { not: null } }, orderBy: { createdAt: "desc" }, take: 300, select: { id: true, body: true, createdAt: true, conversationId: true } }),
    prisma.note.findMany({ where: { businessId, contactId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, body: true, createdAt: true } }),
    prisma.call.findMany({ where: { businessId, contactId, outcomeNote: { not: null } }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, outcomeNote: true, createdAt: true } }),
    prisma.coachSession.findMany({ where: { businessId, contactId }, orderBy: { lastSegmentAt: "desc" }, take: 30, select: { callId: true, promises: true, documentation: true, lastSegmentAt: true } }),
  ]);
  for (const m of messages) if (hit(m.body)) refs.push({ type: "message", id: m.id, label: `הודעה יוצאת: "${snippet(m.body!)}"`, at: m.createdAt.toISOString() });
  for (const n of notes) if (hit(n.body)) refs.push({ type: "note", id: n.id, label: `הערה: "${snippet(n.body)}"`, at: n.createdAt.toISOString() });
  for (const c of calls) if (hit(c.outcomeNote)) refs.push({ type: "call", id: c.id, label: `תיעוד שיחה: "${snippet(c.outcomeNote!)}"`, at: c.createdAt.toISOString() });
  for (const s of sessions) {
    const promised = (Array.isArray(s.promises) ? s.promises : []) as Array<{ text?: string }>;
    const agreements = ((s.documentation as { agreements?: unknown } | null)?.agreements ?? []) as unknown;
    const texts = [...promised.map((p) => p?.text ?? ""), ...(Array.isArray(agreements) ? agreements.map(String) : typeof agreements === "string" ? [agreements] : [])];
    for (const t of texts) if (t && tokens(product).some((p) => tokens(t).some((n) => tokenHit(p, n)))) refs.push({ type: "call", id: s.callId, label: `התחייבות בשיחה: "${snippet(t)}"`, at: s.lastSegmentAt?.toISOString() });
  }
  if (!refs.some((r) => r.type === "call")) {
    const segs = await prisma.coachSegment.findMany({ where: { businessId, session: { contactId }, speaker: "agent" }, orderBy: { createdAt: "desc" }, take: 400, select: { id: true, callId: true, text: true, createdAt: true } });
    for (const g of segs) if (hit(g.text)) refs.push({ type: "call", id: g.callId, label: `בתמלול השיחה: "${snippet(g.text)}"`, at: g.createdAt.toISOString() });
  }
  return refs.slice(0, 10);
}

async function saveCase(input: { businessId: string; contactId: string; conversationId: string | null; orderId: string | null; product: string; productKey?: string; finding: Finding; status: "open" | "informed"; claim: object; summary: string; sources: SourceRef[]; reply: string; by: string }) {
  const dedupeKey = `missing_item:${input.contactId}:${input.orderId ?? "none"}:${input.productKey || tokens(input.product).join("-") || norm(input.product)}`;
  const existing = await prisma.serviceCase.findUnique({ where: { businessId_dedupeKey: { businessId: input.businessId, dedupeKey } } });
  const data = { finding: input.finding, claim: input.claim as Prisma.InputJsonValue, summary: input.summary.slice(0, 4000), sources: input.sources as unknown as Prisma.InputJsonValue, suggestedReply: input.reply.slice(0, 2000), conversationId: input.conversationId };
  if (existing) {
    const updated = await prisma.serviceCase.update({ where: { id: existing.id }, data: { ...data, ...(existing.status === "resolved" ? {} : { status: input.status === "open" || existing.status === "open" ? "open" : "informed" }) } });
    return { id: updated.id, duplicate: true };
  }
  try {
    const c = await prisma.serviceCase.create({ data: { businessId: input.businessId, contactId: input.contactId, orderId: input.orderId, kind: "missing_item", status: input.status, dedupeKey, createdBy: input.by, ...data } });
    await audit(input.businessId, input.by === "ai" ? null : input.by, "contact", input.contactId, "service_case.opened", { caseId: c.id, finding: input.finding, orderId: input.orderId });
    return { id: c.id, duplicate: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") { const again = await prisma.serviceCase.findUniqueOrThrow({ where: { businessId_dedupeKey: { businessId: input.businessId, dedupeKey } } }); return { id: again.id, duplicate: true }; }
    throw e;
  }
}

/**
 * Check a missing-item claim for the conversation's customer. `orderNumber` narrows to one of HER orders (another
 * customer's number is treated as not found – nothing is revealed). `by` = "ai" or the acting user id.
 */
export async function checkMissingItem(input: { businessId: string; contact: { id: string; phoneE164: string }; conversationId?: string | null; product: string; quantity?: number | null; orderNumber?: string | null; promised?: boolean; tz?: string; by?: string; claimText?: string }): Promise<MissingItemResult> {
  const tz = input.tz ?? "Asia/Jerusalem";
  const product = (input.product ?? "").trim().slice(0, 120);
  const claimQty = input.quantity && input.quantity > 0 ? Math.round(input.quantity) : null;
  const claim = { product, quantity: claimQty, promised: Boolean(input.promised) };
  const base = { claim, sources: [] as SourceRef[], caseId: null as string | null, duplicateCase: false, orderedQuantity: null as number | null, order: null as MissingItemResult["order"] };
  const by = input.by ?? "ai";
  if (!tokens(product).length) return { ...base, finding: "needs_info", action: "ask", customerMessage: "כדי שאוכל לבדוק – איזה מוצר חסר, וכמה יחידות?", agentSummary: "הלקוח/ה דיווח/ה על חוסר בלי לציין מוצר." };

  const all = await candidates(input.businessId, input.contact);
  let pool = all;
  if (input.orderNumber) {
    const n = input.orderNumber.replace(/[#\s]/g, "");
    pool = all.filter((c) => c.number.replace(/[#\s]/g, "") === n || c.number.replace(/[#\s]/g, "").endsWith(n));
    if (!pool.length) return { ...base, finding: "needs_info", action: "ask", customerMessage: "לא מצאתי הזמנה עם המספר הזה שמשויכת למספר הטלפון שממנו נשלחה ההודעה. אפשר לבדוק את מספר ההזמנה, או שאעביר לנציג שיבדוק.", agentSummary: `הלקוח/ה מסר/ה מספר הזמנה ${input.orderNumber} שלא נמצא בהזמנות המשויכות אליו/ה.` };
  }
  if (!pool.length) {
    const summary = `טענה: חסר ${product}${claimQty ? ` (${units(claimQty)})` : ""}. לא נמצאו הזמנות המשויכות לאיש הקשר / למספר ב-180 הימים האחרונים.`;
    const saved = await saveCase({ businessId: input.businessId, contactId: input.contact.id, conversationId: input.conversationId ?? null, orderId: null, product, finding: "needs_info", status: "open", claim: { ...claim, text: input.claimText ?? null }, summary, sources: [], reply: "", by });
    return { ...base, finding: "needs_info", action: "handoff", caseId: saved.id, duplicateCase: saved.duplicate, customerMessage: "לא מצאתי הזמנה המשויכת למספר הזה. העברתי את הפנייה לנציג שיבדוק ויחזור אליך 🙏", agentSummary: summary };
  }
  // Which order? The one that contains the product; otherwise the only one; otherwise ask.
  const containing = pool.filter((c) => orderedQuantity(c, product).qty > 0);
  let chosen: Candidate | null = containing.length === 1 ? containing[0] : pool.length === 1 ? pool[0] : null;
  if (!chosen && containing.length === 0) {
    // Not in any of her orders: a conclusion only when there is a single recent order to talk about.
    const recent = pool.filter((c) => c.placedAt && c.placedAt.getTime() > Date.now() - 45 * 86400_000);
    if (recent.length === 1) chosen = recent[0];
  }
  if (!chosen) {
    const list = (containing.length ? containing : pool).slice(0, 4).map((c) => `${c.label}${c.placedAt ? ` מ-${fmtDate(c.placedAt, tz)}` : ""}`).join(", ");
    return { ...base, finding: "needs_info", action: "ask", customerMessage: `כדי לבדוק במדויק – על איזו הזמנה מדובר? מצאתי: ${list}.`, agentSummary: `כמה הזמנות אפשריות (${list}) – נשאלה שאלת הבהרה.` };
  }

  const o = chosen;
  const q = orderedQuantity(o, product);
  const lines = describeOrder(o);
  const orderRef: SourceRef = { type: "order", id: o.id, label: `${o.label}${o.placedAt ? ` מ-${fmtDate(o.placedAt, tz)}` : ""} (${o.status})`, at: o.placedAt?.toISOString() };
  const sources: SourceRef[] = [orderRef];
  const order = { id: o.id, number: o.number, placedAt: o.placedAt?.toISOString() ?? null, status: o.status, lines };
  for (const ch of o.changes) if (ch.kind !== "created" && (!ch.name || productMatches(product, ch.name))) sources.push({ type: "change", id: o.id, label: `שינוי בהזמנה: ${ch.kind}${ch.name ? ` – ${ch.name}` : ""}${ch.from !== undefined ? ` מ-${ch.from}` : ""}${ch.to !== undefined ? ` ל-${ch.to}` : ""}`, at: ch.at });

  // Sources that disagree → a person, with both sides.
  const conflicts: string[] = [];
  if (o.receipt?.items?.length) {
    const r = o.receipt.items.filter((i) => productMatches(product, i.name, i.sku)).reduce((s, i) => s + i.quantity, 0);
    sources.push({ type: "receipt", id: o.id, label: `קבלה${o.receipt.number ? ` ${o.receipt.number}` : ""}: ${r} × ${product}` });
    if (r !== q.qty) conflicts.push(`בקבלה ${r} יחידות של ${product}, ובהזמנה ${q.qty}`);
  }
  const shippedWithItems = o.shipments.filter((s) => s.items.length);
  const shippedQty = shippedWithItems.reduce((sum, s) => sum + s.items.filter((i) => productMatches(product, i.name)).reduce((a, i) => a + i.quantity, 0), 0);
  if (shippedQty > q.qty) conflicts.push(`במשלוחים נרשמו ${shippedQty} יחידות של ${product}, ובהזמנה ${q.qty}`);
  for (const s of o.shipments) sources.push({ type: "shipment", id: s.key, label: `משלוח ${s.carrier ?? ""} ${s.tracking ?? ""} – ${s.status}${s.items.length ? `: ${s.items.map((i) => `${i.quantity} ${i.name}`).join(", ")}` : " (ללא פירוט פריטים)"}`.replace(/\s+/g, " "), at: s.deliveredAt ?? s.shippedAt });

  const header = `טענה: חסר ${product}${claimQty ? ` (${units(claimQty)})` : ""}${input.promised ? " – לטענת הלקוח/ה הובטח" : ""}. נבדק: ${orderRef.label}. בהזמנה: ${lines.join("; ") || "אין פריטים"}. כמות ${product} בהזמנה: ${q.qty}${q.cancelled ? " (ההזמנה בוטלה)" : ""}.`;
  const finish = async (finding: Finding, action: MissingItemResult["action"], customerMessage: string, next: string, status: "open" | "informed", extra: SourceRef[] = []) => {
    const all = [...sources, ...extra];
    const agentSummary = `${header} ממצא: ${FINDING_LABEL[finding]}. צעד הבא: ${next}`;
    const saved = await saveCase({ businessId: input.businessId, contactId: input.contact.id, conversationId: input.conversationId ?? null, orderId: o.storeOrderId, product, productKey: productKey(product, o.items), finding, status, claim: { ...claim, text: input.claimText ?? null }, summary: agentSummary, sources: all, reply: customerMessage, by });
    return { claim, order, orderedQuantity: q.qty, sources: all, finding, action, customerMessage, agentSummary, caseId: saved.id, duplicateCase: saved.duplicate };
  };

  if (conflicts.length) return finish("conflict", "handoff", "יש אי-התאמה בין נתוני ההזמנה לנתונים נוספים שבידינו, ולכן העברתי את הפנייה לנציג שיבדוק ויחזור אליך. לא נסיק מסקנה בלי בדיקה 🙏", `סתירה בין המקורות – ${conflicts.join("; ")}. לבדוק ידנית, לא לבחור מקור.`, "open");

  if (q.qty === 0) {
    const promises = await documentedPromises(input.businessId, input.contact.id, product);
    if (promises.length) return finish("promised", "handoff", "מצאתי תיעוד קודם שקשור לזה. העברתי את הפנייה לנציג שיבדוק אותו מול ההזמנה ויחזור אליך 🙏", "נמצא תיעוד הבטחה שאינו תואם להזמנה – לבדוק מול ההפניות המצורפות.", "open", promises);
    if (input.promised) return finish("promised", "handoff", "לא מצאתי תיעוד לכך אצלי, אבל זה לא אומר שזה לא נאמר. העברתי את הפנייה לנציג שיבדוק ויחזור אליך 🙏", "הלקוח/ה טוען/ת שהמוצר הובטח; לא נמצא תיעוד בהודעות / בהערות / בשיחות. היעדר תיעוד אינו מוכיח שלא הובטח – לבדוק.", "open");
    const msg = `בדקתי את ${o.label}${o.placedAt ? ` מ-${fmtDate(o.placedAt, tz)}` : ""}. ${q.cancelled ? "ההזמנה הזו בוטלה. " : ""}מופיעים בה: ${lines.join(", ") || "אין פריטים רשומים"}. המוצר „${product}" לא מופיע בהזמנה הזו. אם המוצר הובטח לך בשיחה או בהודעה, או שמדובר בהזמנה אחרת – אשמח לבדוק גם את זה. אפשר גם לשלוח לך את פירוט ההזמנה.`;
    return finish("not_ordered", "reply", msg, "הוסבר ללקוח/ה מה כלול בהזמנה; אין צורך בפעולה נוספת אלא אם תטען להבטחה או להזמנה אחרת.", "informed");
  }

  // The product was ordered. What do we know about its shipping (verified data only)?
  const missing = claimQty ?? null;
  const itsParcels = shippedWithItems.filter((s) => s.items.some((i) => productMatches(product, i.name)));
  const open = itsParcels.find((s) => s.status === "pending" || s.status === "shipped");
  const parcelText = (s: Shipment) => `${s.carrier ? `${s.carrier} ` : ""}${s.tracking ? `(מספר מעקב ${s.tracking}) ` : ""}– ${SHIP_LABEL[s.status]}`;
  const caseLine = `פתחתי בירור על ${missing ? units(Math.min(missing, q.qty)) : "המוצר"} של ${product} מהזמנה ${o.number}`;
  if (open && itsParcels.length && o.shipments.length > 1) {
    return finish("shipped_separately", "handoff", `בדקתי את ${o.label}: מופיעות בה ${units(q.qty)} של ${product}. לפי נתוני המשלוח, „${product}" נשלח בחבילה נפרדת ${parcelText(open)}. ${caseLine}, ונציג יעדכן אותך 🙏`, `חבילה נפרדת (${open.key}) במצב ${open.status} – לעקוב; לא להבטיח מועד או משלוח חלופי ללא הרשאה.`, "open");
  }
  if (missing && missing > q.qty) {
    return finish("partial", "handoff", `בדקתי את ${o.label}: מופיעות בה ${units(q.qty)} של ${product}. ${caseLine}, ונציג יבדוק ויחזור אליך 🙏`, `הלקוח/ה טוען/ת ל-${missing} חסרות, בהזמנה ${q.qty}. לבדוק כמה הגיעו בפועל; לא להבטיח השלמה / החזר ללא הרשאה ותהליך.`, "open");
  }
  return finish("ordered_not_received", "handoff", `בדקתי את ${o.label}: מופיעות בה ${units(q.qty)} של ${product}. ${caseLine}, ונציג יבדוק ויחזור אליך. מצטערים על אי הנוחות 🙏`, `בירור חוסר באספקה: ${missing ? units(missing) : "כמות לא צוינה"} של ${product}, הזמנה ${o.number}. הזמנה / "נמסר" אינם מוכיחים שהפריט נארז – לבדוק ליקוט ומשלוח. לא להבטיח משלוח חלופי או החזר ללא הרשאה ותהליך.`, "open");
}

export const FINDING_LABEL: Record<Finding, string> = {
  not_ordered: "המוצר לא הוזמן בהזמנה שנבדקה", ordered_not_received: "הוזמן – נפתח בירור חוסר באספקה", partial: "כמות חלקית – נפתח בירור",
  shipped_separately: "נשלח בחבילה נפרדת – בירור פתוח", promised: "טענה להבטחה – לבדיקת נציג", conflict: "סתירה בין מקורות – לבדיקת נציג", needs_info: "חסר מידע",
};
const SHIP_LABEL: Record<Shipment["status"], string> = { pending: "טרם נשלח", shipped: "בדרך", delivered: "נמסר", returned: "הוחזר", failed: "משלוח נכשל" };
