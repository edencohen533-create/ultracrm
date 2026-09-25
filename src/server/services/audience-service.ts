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
    case "campaign": return { campaignRecipients: { some: { campaignId: node.value, ...(node.result === "ANY" ? {} : { status: node.result }) } } };
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
export async function resolveAudience(tx: Prisma.TransactionClient, listId: string, excludedListIds: string[], now: Date) {
  const ids = [...new Set([listId, ...excludedListIds])];
  const lists = await tx.distributionList.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, segment: true } });
  if (lists.length !== ids.length) throw new AudienceError("רשימת תפוצה או קהל מוחרג אינם נגישים");
  const primary = lists.find((list) => list.id === listId)!;
  const base = await listAudienceWhere(tx, primary, now);
  const excluded = await Promise.all(lists.filter((list) => excludedListIds.includes(list.id)).map((list) => listAudienceWhere(tx, list, now)));
  return { base, exclusion: excluded.length ? { OR: excluded } satisfies Prisma.ContactWhereInput : null, lists, primary };
}
export async function previewAudience(input: { segment?: AudienceNode; listId?: string; excludedListIds?: string[] }) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    let base: Prisma.ContactWhereInput; let exclusion: Prisma.ContactWhereInput | null = null;
    if (input.segment) { await validateAudienceReferences(tx, input.segment); base = audienceWhere(input.segment, now); }
    else if (input.listId) ({ base, exclusion } = await resolveAudience(tx, input.listId, input.excludedListIds ?? [], now));
    else throw new AudienceError("יש לבחור קהל");
    const included = exclusion ? { AND: [base, { NOT: exclusion }] } : base;
    const [matched, remaining, eligible, samples] = await Promise.all([
      tx.contact.count({ where: base }), tx.contact.count({ where: included }),
      tx.contact.count({ where: { AND: [included, marketingEligibilityWhere(now)] } }),
      tx.contact.findMany({ where: included, orderBy: { id: "asc" }, take: 5, select: { fullName: true, phoneE164: true, consentStatus: true, isBlocked: true } }),
    ]);
    return { matched, excluded: matched - remaining, remaining, eligible, ineligible: remaining - eligible, checkedAt: now.toISOString(), samples, policy: "הקהל מחושב ביצירת טיוטה ומוקפא בה. זכאות נבדקת שוב לפני כל שליחה" };
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
}
