import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audienceRules, audienceSchema, type AudienceNode } from "@/lib/audiences";
import { MARKETING_INTERVAL_MS } from "@/lib/message-policy";

export class AudienceError extends Error {}
export function marketingEligibilityWhere(now: Date): Prisma.ContactWhereInput {
  return { isBlocked: false, consentStatus: "OPTED_IN", OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lte: new Date(now.getTime() - MARKETING_INTERVAL_MS) } }] };
}
/** Translate only validated, bounded rules into Prisma predicates. Never interpolate SQL. */
export function audienceWhere(node: AudienceNode, now = new Date()): Prisma.ContactWhereInput {
  if ("conditions" in node) return { [node.operator]: node.conditions.map((child) => audienceWhere(child, now)) };
  switch (node.field) {
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
    const ids = [...new Set(rules.filter((rule) => rule.field === field).map((rule) => rule.value).filter((v): v is string => typeof v === "string" && v.length > 0))];
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
  return audienceWhere(parsed.data, now);
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
    if (input.segment) { await validateAudienceReferences(tx, input.segment); base = audienceWhere(input.segment, now); }
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
