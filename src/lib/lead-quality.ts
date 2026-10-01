/**
 * Lead-handling quality per agent for the "ביצועי נציגים" report (period = [from, to]):
 *  • response time: median minutes from lead creation to the first real dial attempt (lead leg dialed) on it,
 *    for leads that reached the agent new (not transferred in); plus how many of them were never dialed;
 *  • conversion from new leads (created in the period, owned by the agent, not transferred in);
 *  • conversion from leads transferred to the agent by another agent during the period;
 *  • conversion from all leads owned by the agent created in the period;
 *  • average won-deal value (deals closed in the period).
 * A lead counts as converted when its status is "converted" or it has a won deal.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";

export interface LeadQuality { responseMinutes: number | null; notCalled: number; newLeads: number; newWon: number; transferred: number; transferredWon: number; allLeads: number; allWon: number; avgDealValue: number | null; wonDeals: number; revenue?: number; ilsDeals?: number }

export async function leadQualityByAgent(businessId: string, userIds: string[] | null, from: Date, to: Date, cf: { listId?: string | null; product?: string | null } = {}): Promise<Record<string, LeadQuality>> {
  const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);
  // The reports' campaign (dial list) / product filters, through the lead's / deal's contact.
  const contactCond = (col: Prisma.Sql) => Prisma.sql`${cf.listId ? Prisma.sql`AND EXISTS (SELECT 1 FROM ${T("list_leads")} ll WHERE ll.contact_id = ${col} AND ll.list_id = ${cf.listId})` : Prisma.empty} ${cf.product ? Prisma.sql`AND EXISTS (SELECT 1 FROM ${T("contacts")} pc WHERE pc.id = ${col} AND pc.custom_fields->>'product' = ${cf.product})` : Prisma.empty}`;
  const who = userIds ? Prisma.sql`AND l.owner_user_id = ANY(${userIds})` : Prisma.empty;
  const WON = Prisma.sql`(l.status = 'converted' OR EXISTS (SELECT 1 FROM ${T("deals")} d WHERE d.lead_id = l.id AND d.status = 'won'))`;
  const TRANSFERRED_IN = Prisma.sql`EXISTS (SELECT 1 FROM ${T("audit_logs")} a WHERE a.business_id = l.business_id AND a.entity_type = 'lead' AND a.entity_id = l.id AND a.action = 'lead.transferred' AND a.payload->>'to' = l.owner_user_id AND a.payload->>'from' IS NOT NULL)`;
  const [own, moved, deals] = await Promise.all([
    prisma.$queryRaw<Array<{ uid: string | null; total: number; won: number; newTotal: number; newWon: number; notCalled: number; resp: number | null }>>(Prisma.sql`
      WITH lz AS (
        SELECT l.id, l.owner_user_id AS uid, l.contact_id, l.created_at, ${WON} AS won, ${TRANSFERRED_IN} AS moved_in
        FROM ${T("leads")} l WHERE l.business_id = ${businessId} AND l.created_at >= ${from} AND l.created_at <= ${to} ${who} ${contactCond(Prisma.sql`l.contact_id`)}
      ), first AS (
        SELECT lz.id, min(c.created_at) AS first_at FROM lz JOIN ${T("calls")} c ON c.business_id = ${businessId} AND c.contact_id = lz.contact_id
          AND c.direction = 'outbound' AND c.lead_dialed_at IS NOT NULL AND c.created_at >= lz.created_at
        GROUP BY lz.id
      )
      SELECT lz.uid, count(*)::int AS total, count(*) FILTER (WHERE lz.won)::int AS won,
        count(*) FILTER (WHERE NOT lz.moved_in)::int AS "newTotal", count(*) FILTER (WHERE NOT lz.moved_in AND lz.won)::int AS "newWon",
        count(*) FILTER (WHERE NOT lz.moved_in AND f.first_at IS NULL)::int AS "notCalled",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f.first_at - lz.created_at)) / 60.0) FILTER (WHERE NOT lz.moved_in AND f.first_at IS NOT NULL))::float AS resp
      FROM lz LEFT JOIN first f ON f.id = lz.id GROUP BY lz.uid`),
    prisma.$queryRaw<Array<{ uid: string; total: number; won: number }>>(Prisma.sql`
      WITH tr AS (
        SELECT DISTINCT ON (a.entity_id) a.entity_id AS lead_id, a.payload->>'to' AS uid FROM ${T("audit_logs")} a
        WHERE a.business_id = ${businessId} AND a.entity_type = 'lead' AND a.action = 'lead.transferred' AND a.payload->>'from' IS NOT NULL
          AND a.created_at >= ${from} AND a.created_at <= ${to}
        ORDER BY a.entity_id, a.created_at DESC
      )
      SELECT tr.uid, count(*)::int AS total, count(*) FILTER (WHERE ${WON})::int AS won
      FROM tr JOIN ${T("leads")} l ON l.id = tr.lead_id AND l.business_id = ${businessId} ${contactCond(Prisma.sql`l.contact_id`)}
      ${userIds ? Prisma.sql`WHERE tr.uid = ANY(${userIds})` : Prisma.empty}
      GROUP BY tr.uid`),
    // Won deals per owner: count (all currencies), ILS revenue and ILS average (other currencies are not summed into ₪).
    prisma.$queryRaw<Array<{ ownerUserId: string | null; won: number; ils_sum: number | null; ils_count: number }>>(Prisma.sql`
      SELECT d.owner_user_id AS "ownerUserId", count(*)::int AS won, sum(d.amount) FILTER (WHERE d.currency = 'ILS')::float AS ils_sum, count(*) FILTER (WHERE d.currency = 'ILS')::int AS ils_count
      FROM ${T("deals")} d WHERE d.business_id = ${businessId} AND d.status = 'won' AND d.closed_at >= ${from} AND d.closed_at <= ${to}
      ${userIds ? Prisma.sql`AND d.owner_user_id = ANY(${userIds})` : Prisma.empty} ${contactCond(Prisma.sql`d.contact_id`)} GROUP BY 1`),
  ]);
  const out: Record<string, LeadQuality> = {};
  const get = (uid: string) => (out[uid] ??= { responseMinutes: null, notCalled: 0, newLeads: 0, newWon: 0, transferred: 0, transferredWon: 0, allLeads: 0, allWon: 0, avgDealValue: null, wonDeals: 0 });
  // Leads without an owner go under "" (like ownerless deals), so totals match the page's lead count.
  for (const r of own) Object.assign(get(r.uid ?? ""), { allLeads: r.total, allWon: r.won, newLeads: r.newTotal, newWon: r.newWon, notCalled: r.notCalled, responseMinutes: r.resp === null ? null : Math.round(r.resp * 10) / 10 });
  for (const r of moved) Object.assign(get(r.uid), { transferred: r.total, transferredWon: r.won });
  for (const d of deals) if (d.ownerUserId) Object.assign(get(d.ownerUserId), { avgDealValue: d.ils_count ? Math.round(Number(d.ils_sum) / d.ils_count) : null, wonDeals: d.won, revenue: Math.round(Number(d.ils_sum ?? 0) * 100) / 100, ilsDeals: d.ils_count });
  // Deals without an owner (or of users without a row) are returned under "" so the caller can show them explicitly.
  const orphan = deals.filter((d) => !d.ownerUserId);
  if (orphan.length) Object.assign(get(""), { wonDeals: orphan.reduce((t, d) => t + d.won, 0), ilsDeals: orphan.reduce((t, d) => t + d.ils_count, 0), revenue: Math.round(orphan.reduce((t, d) => t + Number(d.ils_sum ?? 0), 0) * 100) / 100 });
  return out;
}
