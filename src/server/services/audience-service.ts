import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { audienceRules, audienceSchema, type AudienceNode, type AudienceRule } from "@/lib/audiences";
import { MARKETING_INTERVAL_MS } from "@/lib/message-policy";

export class AudienceError extends Error {}
export function marketingEligibilityWhere(now: Date): Prisma.ContactWhereInput {
  return { isBlocked: false, consentStatus: "OPTED_IN", OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lte: new Date(now.getTime() - MARKETING_INTERVAL_MS) } }] };
}
// ─── Purchases (real facts, computed in SQL – parameters only, never interpolated) ────────────────────────────────
const T = (t: string) => Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."${t}"`);
const likeTerms = (terms: string[]) => terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
/** One row per purchased item: store orders as sold (lines, bundle lines and their components, refunds deducted,
 *  cancelled / refunded / pending orders excluded), phone sales with items, and paid carts not already an order. */
function purchaseEvents(businessId: string) {
  return Prisma.sql`
    SELECT so.contact_id, COALESCE(so.placed_at, so.created_at) AS at, it->>'name' AS name FROM ${T("store_orders")} so CROSS JOIN LATERAL jsonb_array_elements(so.items) it
      WHERE so.business_id = ${businessId} AND so.contact_id IS NOT NULL AND so.status NOT IN ('pending', 'cancelled', 'refunded')
        AND COALESCE((it->>'quantity')::numeric, 0) - COALESCE((it->>'refundedQuantity')::numeric, 0) > 0
    UNION ALL
    SELECT so.contact_id, COALESCE(so.placed_at, so.created_at), comp->>'name' FROM ${T("store_orders")} so CROSS JOIN LATERAL jsonb_array_elements(so.items) it CROSS JOIN LATERAL jsonb_array_elements(COALESCE(it->'components', '[]'::jsonb)) comp
      WHERE so.business_id = ${businessId} AND so.contact_id IS NOT NULL AND so.status NOT IN ('pending', 'cancelled', 'refunded')
    UNION ALL
    SELECT d.contact_id, COALESCE(d.closed_at, d.created_at), di.name FROM ${T("deals")} d JOIN ${T("deal_items")} di ON di.deal_id = d.id
      WHERE d.business_id = ${businessId} AND d.status = 'won'
    UNION ALL
    SELECT c.contact_id, COALESCE(c.converted_at, c.updated_at), it->>'name' FROM ${T("carts")} c CROSS JOIN LATERAL jsonb_array_elements(c.items) it
      WHERE c.business_id = ${businessId} AND c.contact_id IS NOT NULL AND c.status IN ('converted', 'recovered')
        AND NOT EXISTS (SELECT 1 FROM ${T("store_orders")} so2 WHERE so2.business_id = c.business_id AND so2.order_number = c.order_id)`;
}
type PurchaseRule = Extract<AudienceRule, { field: "purchase" | "purchaseSequence" }>;
async function purchaseContacts(tx: Prisma.TransactionClient, businessId: string, rule: PurchaseRule, now: Date): Promise<string[]> {
  const ev = purchaseEvents(businessId);
  const match = (alias: string, terms: string[]) => (terms.length ? Prisma.sql`${Prisma.raw(alias)}.name ILIKE ANY(${likeTerms(terms)}::text[])` : Prisma.sql`TRUE`);
  const since = (d: number | undefined) => (d ? new Date(now.getTime() - d * 86400_000) : null);
  if (rule.field === "purchase") {
    const s = since(rule.withinDays);
    const rows = await tx.$queryRaw<Array<{ contact_id: string }>>(Prisma.sql`WITH ev AS (${ev}) SELECT DISTINCT e.contact_id FROM ev e WHERE ${match("e", rule.products)} ${s ? Prisma.sql`AND e.at >= ${s}` : Prisma.empty} AND e.at <= ${now}`);
    return rows.map((r) => r.contact_id);
  }
  const s = since(rule.first.withinDays)!;
  const rows = await tx.$queryRaw<Array<{ contact_id: string }>>(Prisma.sql`WITH ev AS (${ev})
    SELECT DISTINCT a.contact_id FROM ev a JOIN ev b ON b.contact_id = a.contact_id
    WHERE a.at >= ${s} AND a.at <= ${now} AND ${match("a", rule.first.products)}
      AND b.at >= a.at + make_interval(days => ${rule.then.minDaysAfter}) AND b.at <= ${now}
      ${rule.then.maxDaysAfter !== undefined ? Prisma.sql`AND b.at <= a.at + make_interval(days => ${rule.then.maxDaysAfter})` : Prisma.empty}
      AND ${match("b", rule.then.products)}
      ${rule.then.otherThanFirst ? Prisma.sql`AND NOT (b.name ILIKE ANY(${likeTerms(rule.first.products)}::text[]))` : Prisma.empty}`);
  return rows.map((r) => r.contact_id);
}
/** Product names actually sold (for the AI builder's vocabulary). */
export async function soldProductNames(tx: Prisma.TransactionClient, businessId: string, limit = 150) {
  const rows = await tx.$queryRaw<Array<{ name: string; n: bigint }>>(Prisma.sql`WITH ev AS (${purchaseEvents(businessId)}) SELECT name, count(*) AS n FROM ev WHERE name IS NOT NULL GROUP BY name ORDER BY n DESC LIMIT ${limit}`);
  return rows.map((r) => r.name);
}
export type ResolvedRules = Map<AudienceRule, string[]>;
/** Resolve purchase rules (SQL) first, then build the Prisma predicate. The business comes from the request scope. */
export async function resolveAudienceWhere(tx: Prisma.TransactionClient, node: AudienceNode, now = new Date()) {
  const rules = audienceRules(node).filter((r): r is PurchaseRule => r.field === "purchase" || r.field === "purchaseSequence");
  const resolved: ResolvedRules = new Map();
  if (rules.length) {
    const { requireBusinessId } = await import("@/lib/tenant");
    const businessId = requireBusinessId();
    for (const r of rules) resolved.set(r, await purchaseContacts(tx, businessId, r, now));
  }
  return audienceWhere(node, now, resolved);
}

/** Translate only validated, bounded rules into Prisma predicates. Never interpolate SQL. */
export function audienceWhere(node: AudienceNode, now = new Date(), resolved?: ResolvedRules): Prisma.ContactWhereInput {
  if ("conditions" in node) return { [node.operator]: node.conditions.map((child) => audienceWhere(child, now, resolved)) };
  switch (node.field) {
    case "purchase":
    case "purchaseSequence": {
      const ids = resolved?.get(node);
      if (!ids) throw new AudienceError("תנאי רכישה דורשים חישוב מקדים");
      return node.field === "purchase" && node.operator === "did_not" ? { id: { notIn: ids } } : { id: { in: ids } };
    }
    case "tag": return { tags: { [node.operator === "is" ? "some" : "none"]: { tagId: node.value } } };
    // Explicit non-null guard keeps NOT/exclusions two-valued: a missing source must not disappear.
    case "source": return { AND: [{ source: { not: null } }, { source: { [node.operator]: node.value, mode: "insensitive" } }] };
    case "custom": return node.operator === "equals" ? { customFields: { path: [node.key], equals: node.value } } : { customFields: { path: [node.key], string_contains: node.value } };
    case "agent": return { conversations: { some: { assignedAgentId: node.value } } };
    case "owner": {
      if (node.operator === "is") return { ownerUserId: node.value };
      // "is not X" must keep unowned contacts (SQL NOT would drop NULL owners).
      return node.value === null ? { ownerUserId: { not: null } } : { OR: [{ ownerUserId: null }, { ownerUserId: { not: node.value } }] };
    }
    case "leadStatus": {
      const w: Prisma.ContactWhereInput = node.value === "none" ? { leads: { none: {} } } : { leads: { some: { status: node.value } } };
      return node.operator === "is" ? w : { NOT: w };
    }
    case "consent": return { consentStatus: node.value };
    case "blocked": return { isBlocked: node.value };
    case "marketingEligible": return node.value ? marketingEligibilityWhere(now) : { NOT: marketingEligibilityWhere(now) };
    case "campaign": {
      // Delivery outcomes come from the provider status of the recipient's message (not just "handed over").
      if (node.result === "DELIVERED") return { campaignRecipients: { some: { campaignId: node.value, message: { status: { in: ["DELIVERED", "READ"] } } } } };
      if (node.result === "READ") return { campaignRecipients: { some: { campaignId: node.value, message: { status: "READ" } } } };
      if (node.result === "NOT_DELIVERED") return { campaignRecipients: { some: { campaignId: node.value, OR: [{ status: { in: ["FAILED", "UNKNOWN"] } }, { message: { status: { in: ["FAILED", "BOUNCED", "CANCELLED"] } } }] } } };
      if (node.result === "REPLIED") return { campaignRecipients: { some: { campaignId: node.value, message: { conversation: { messages: { some: { direction: "INBOUND", createdAt: { gte: new Date(0) } } } } } } }, conversations: { some: { messages: { some: { direction: "INBOUND" } } } } };
      return { campaignRecipients: { some: { campaignId: node.value, ...(node.result === "ANY" ? {} : { status: node.result }) } } };
    }
    default: {
      const direction = node.field === "lastInbound" ? "INBOUND" : node.field === "lastOutbound" ? "OUTBOUND" : undefined;
      const hasMessage = (createdAt?: Prisma.DateTimeFilter): Prisma.ContactWhereInput => ({ conversations: { some: { messages: { some: { ...(direction ? { direction } : {}), ...(createdAt ? { createdAt } : {}) } } } } });
      if (node.operator === "never") return { NOT: hasMessage() };
      if (node.operator === "after") return hasMessage({ gte: new Date(node.value!) });
      // "Last before" means at least one message, and no newer message in any thread/number.
      return { AND: [hasMessage(), { NOT: hasMessage({ gte: new Date(node.value!) }) }] };
    }
  }
}
export async function validateAudienceReferences(tx: Prisma.TransactionClient, node: AudienceNode) {
  const rules = audienceRules(node);
  for (const field of ["tag", "agent", "owner", "campaign"] as const) {
    const ids = [...new Set(rules.filter((rule) => rule.field === field).map((rule) => ("value" in rule ? rule.value : null)).filter((v): v is string => typeof v === "string" && v.length > 0))];
    if (!ids.length) continue;
    const count = field === "tag" ? await tx.tag.count({ where: { id: { in: ids } } }) : field === "agent" || field === "owner" ? await tx.user.count({ where: { id: { in: ids } } }) : await tx.campaign.count({ where: { id: { in: ids } } });
    if (count !== ids.length) throw new AudienceError("אחד מפריטי הקהל אינו נגיש בעסק זה");
  }
}
export async function listAudienceWhere(tx: Prisma.TransactionClient, list: { id: string; segment: Prisma.JsonValue | null }, now: Date) {
  if (list.segment === null) return { listMemberships: { some: { listId: list.id } } } satisfies Prisma.ContactWhereInput;
  const parsed = audienceSchema.safeParse(list.segment);
  if (!parsed.success) throw new AudienceError("תנאי הקהל אינם תקינים. יש לערוך ולשמור אותם מחדש");
  await validateAudienceReferences(tx, parsed.data);
  return resolveAudienceWhere(tx, parsed.data, now);
}
/** One or several audiences (union – a contact in two lists is counted once) minus the excluded ones. */
export async function resolveAudience(tx: Prisma.TransactionClient, listIdOrIds: string | string[], excludedListIds: string[], now: Date) {
  const includeIds = [...new Set(Array.isArray(listIdOrIds) ? listIdOrIds : [listIdOrIds])].filter(Boolean);
  if (!includeIds.length) throw new AudienceError("יש לבחור לפחות קהל אחד");
  const excludeIds = excludedListIds.filter((id) => !includeIds.includes(id));
  const ids = [...new Set([...includeIds, ...excludeIds])];
  const lists = await tx.distributionList.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, segment: true } });
  if (lists.length !== ids.length) throw new AudienceError("רשימת תפוצה או קהל מוחרג אינם נגישים");
  const primary = lists.find((list) => list.id === includeIds[0])!;
  const included = await Promise.all(includeIds.map((id) => listAudienceWhere(tx, lists.find((l) => l.id === id)!, now)));
  const base: Prisma.ContactWhereInput = included.length === 1 ? included[0] : { OR: included };
  const excluded = await Promise.all(excludeIds.map((id) => listAudienceWhere(tx, lists.find((l) => l.id === id)!, now)));
  return { base, exclusion: excluded.length ? { OR: excluded } satisfies Prisma.ContactWhereInput : null, lists, primary, includeIds, excludeIds };
}
/** Channel reachability on top of marketing eligibility: email needs a deliverable address, SMS/WhatsApp a phone. */
export function channelReachableWhere(channel: "whatsapp" | "sms" | "email"): Prisma.ContactWhereInput {
  return channel === "email" ? { email: { not: null }, OR: [{ emailStatus: null }, { emailStatus: { not: "hard_bounce" } }] } : { phoneE164: { not: "" } };
}
export async function previewAudience(input: { segment?: AudienceNode; listId?: string; listIds?: string[]; excludedListIds?: string[]; channel?: "whatsapp" | "sms" | "email"; marketing?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    let base: Prisma.ContactWhereInput; let exclusion: Prisma.ContactWhereInput | null = null;
    const lists = input.listIds?.length ? input.listIds : input.listId ? [input.listId] : [];
    if (input.segment) { await validateAudienceReferences(tx, input.segment); base = await resolveAudienceWhere(tx, input.segment, now); }
    else if (lists.length) ({ base, exclusion } = await resolveAudience(tx, lists, input.excludedListIds ?? [], now));
    else throw new AudienceError("יש לבחור קהל");
    const included = exclusion ? { AND: [base, { NOT: exclusion }] } : base;
    const eligibility: Prisma.ContactWhereInput = { AND: [input.marketing === false ? { isBlocked: false } : marketingEligibilityWhere(now), ...(input.channel ? [channelReachableWhere(input.channel)] : [])] };
    const [matched, remaining, eligible, samples] = await Promise.all([
      tx.contact.count({ where: base }), tx.contact.count({ where: included }),
      tx.contact.count({ where: { AND: [included, eligibility] } }),
      tx.contact.findMany({ where: included, orderBy: { id: "asc" }, take: 5, select: { fullName: true, phoneE164: true, consentStatus: true, isBlocked: true } }),
    ]);
    return { matched, excluded: matched - remaining, remaining, eligible, ineligible: remaining - eligible, checkedAt: now.toISOString(), samples, policy: "הקהל מחושב ביצירת טיוטה ומוקפא בה. זכאות נבדקת שוב לפני כל שליחה" };
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
}

/** Contact counts per audience list (members or segment matches) – for the audience picker. */
export async function listAudienceCounts() {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const lists = await tx.distributionList.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, segment: true, createdAt: true } });
    const out: Array<{ id: string; name: string; dynamic: boolean; count: number | null; createdAt: Date }> = [];
    for (const list of lists) {
      try { out.push({ id: list.id, name: list.name, dynamic: list.segment !== null, count: await tx.contact.count({ where: await listAudienceWhere(tx, list, now) }), createdAt: list.createdAt }); }
      catch { out.push({ id: list.id, name: list.name, dynamic: list.segment !== null, count: null, createdAt: list.createdAt }); }
    }
    return out;
  }, { timeout: 30000 });
}
