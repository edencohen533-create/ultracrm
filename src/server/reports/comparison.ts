/**
 * Reports: the same metrics for the current period and the comparison period, with the SAME definitions and filters
 * (agent, campaign = dial list, product). Everything is read inside the business (tenant scope + businessId) and the
 * user's own visibility (a team manager sees only their agents) – aggregates included.
 *
 * Filters on data that does not carry them are applied through the contact: a campaign filter keeps leads / deals
 * whose contact is in that dial list; a product filter keeps calls / leads / deals whose contact's product matches.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { getBusinessSettings } from "@/lib/settings";
import { compareMetric, dayOf, periodDays, resolvePeriods, type Change, type Direction, type MetricKind, type Period } from "@/lib/reports/compare";

export interface ReportFilters { userId?: string | null; listId?: string | null; product?: string | null }
export interface MetricDef { id: string; label: string; en: string; kind: MetricKind; direction: Direction; definition: string; definitionEn: string }

/** Every metric shown, with a short definition (the same text drives the page's "?"). */
export const METRICS: MetricDef[] = [
  { id: "outbound", label: "שיחות יוצאות", en: "Outbound calls", kind: "count", direction: "up", definition: "ניסיונות חיוג יוצאים שנוצרו אצל ספק הטלפוניה בתקופה.", definitionEn: "Outbound dial attempts created at the telephony provider in the period." },
  { id: "answered", label: "שיחות שנענו", en: "Answered calls", kind: "count", direction: "up", definition: "שיחות יוצאות שהספק אישר שנענו.", definitionEn: "Outbound calls the provider confirmed as answered." },
  { id: "answerRate", label: "אחוז מענה", en: "Answer rate", kind: "rate", direction: "up", definition: "שיחות שנענו מתוך שיחות יוצאות.", definitionEn: "Answered calls out of outbound calls." },
  { id: "talkSeconds", label: "זמן שיחה כולל", en: "Total talk time", kind: "duration", direction: "neutral", definition: "סך זמן השיחה בשיחות יוצאות שנענו. יותר אינו בהכרח טוב.", definitionEn: "Total talk time on answered outbound calls. More is not necessarily better." },
  { id: "avgTalkSeconds", label: "משך שיחה ממוצע", en: "Avg. call length", kind: "duration", direction: "neutral", definition: "זמן שיחה כולל חלקי מספר השיחות שנענו.", definitionEn: "Total talk time divided by answered calls." },
  { id: "newLeads", label: "לידים חדשים", en: "New leads", kind: "count", direction: "up", definition: "לידים שנוצרו בתקופה (לנציגים שבתחום שלך).", definitionEn: "Leads created in the period (for agents in your scope)." },
  { id: "leadCloseRate", label: "אחוז סגירה של לידים חדשים", en: "New-lead close rate", kind: "rate", direction: "up", definition: "לידים חדשים מהתקופה שהומרו לעסקה (עד עכשיו), מתוך הלידים החדשים. לידים מתקופה קצרה או לא גמורה הספיקו פחות להיסגר.", definitionEn: "New leads of the period converted to a deal (so far), out of new leads. Leads of a short / unfinished period had less time to close." },
  { id: "responseMinutes", label: "זמן תגובה לליד חדש (חציון)", en: "New-lead response (median)", kind: "minutes", direction: "down", definition: "חציון הזמן מיצירת ליד חדש ועד ניסיון החיוג הראשון בפועל. נמוך יותר = טוב יותר.", definitionEn: "Median time from a new lead to its first actual dial attempt. Lower is better." },
  { id: "notCalled", label: "לידים חדשים שלא חויגו", en: "New leads never dialed", kind: "count", direction: "down", definition: "לידים חדשים מהתקופה שעדיין לא היה להם ניסיון חיוג. פחות = טוב יותר.", definitionEn: "New leads of the period with no dial attempt yet. Fewer is better." },
  { id: "dealsWon", label: "עסקאות שנסגרו", en: "Deals won", kind: "count", direction: "up", definition: "עסקאות שסומנו כזכייה ותאריך הסגירה שלהן בתקופה.", definitionEn: "Deals marked won with a close date in the period." },
  { id: "revenue", label: "הכנסות מעסקאות", en: "Deal revenue", kind: "money", direction: "up", definition: "סכום העסקאות שנסגרו בתקופה (בשקלים; עסקאות במטבע אחר אינן נכללות).", definitionEn: "Sum of deals won in the period (ILS; other currencies excluded)." },
  { id: "avgDeal", label: "עסקה ממוצעת", en: "Average deal", kind: "money", direction: "up", definition: "הכנסות חלקי מספר העסקאות שנסגרו.", definitionEn: "Revenue divided by deals won." },
];

type Values = Record<string, number | null>;

const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Contact-level filters (campaign membership / product) as SQL on alias `ct` (a contact id column). */
function contactFilter(col: Prisma.Sql, f: ReportFilters) {
  const parts: Prisma.Sql[] = [];
  if (f.listId) parts.push(Prisma.sql`EXISTS (SELECT 1 FROM ${T("list_leads")} ll WHERE ll.contact_id = ${col} AND ll.list_id = ${f.listId})`);
  if (f.product) parts.push(Prisma.sql`EXISTS (SELECT 1 FROM ${T("contacts")} pc WHERE pc.id = ${col} AND pc.custom_fields->>'product' = ${f.product})`);
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}

/**
 * All metrics of one period as SQL aggregates (no rows pulled into memory). Same definitions as before:
 * outbound = outbound calls with an agent leg; answered = of those with answeredAt; leads created in the period,
 * converted = status "converted" or a won deal; response = first real dial (leadDialedAt) at/after the lead.
 */
async function valuesFor(businessId: string, userIds: string[] | null, p: Period, f: ReportFilters, tz: string) {
  const to = new Date(p.end.getTime() - 1);
  const byUser = (col: Prisma.Sql) => (userIds ? Prisma.sql`AND ${col} = ANY(${userIds})` : Prisma.empty);
  const localDay = (col: Prisma.Sql) => Prisma.sql`to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
  // Calls: the campaign filter is native (list_id); a product filter goes through the call's contact.
  const callWhere = Prisma.sql`c.business_id = ${businessId} AND c.direction = 'outbound' AND c.agent_leg_id IS NOT NULL AND c.created_at >= ${p.start} AND c.created_at <= ${to}
    ${byUser(Prisma.sql`c.user_id`)} ${f.listId ? Prisma.sql`AND c.list_id = ${f.listId}` : Prisma.empty}
    ${f.product ? Prisma.sql`AND EXISTS (SELECT 1 FROM ${T("contacts")} pc WHERE pc.id = c.contact_id AND pc.custom_fields->>'product' = ${f.product})` : Prisma.empty}`;
  const dealWhere = Prisma.sql`d.business_id = ${businessId} AND d.status = 'won' AND d.closed_at >= ${p.start} AND d.closed_at <= ${to} ${byUser(Prisma.sql`d.owner_user_id`)} ${contactFilter(Prisma.sql`d.contact_id`, f)}`;
  const [callDays, dealDays, leadAgg] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; outbound: bigint; answered: bigint; talk: bigint | null }>>(Prisma.sql`
      SELECT ${localDay(Prisma.sql`c.created_at`)} AS day, count(*) AS outbound, count(*) FILTER (WHERE c.answered_at IS NOT NULL) AS answered,
        sum(COALESCE(c.talk_seconds, 0)) FILTER (WHERE c.answered_at IS NOT NULL) AS talk
      FROM ${T("calls")} c WHERE ${callWhere} GROUP BY 1`),
    prisma.$queryRaw<Array<{ day: string; won: bigint; ils_count: bigint; ils_sum: Prisma.Decimal | null }>>(Prisma.sql`
      SELECT ${localDay(Prisma.sql`d.closed_at`)} AS day, count(*) AS won, count(*) FILTER (WHERE d.currency = 'ILS') AS ils_count, sum(d.amount) FILTER (WHERE d.currency = 'ILS') AS ils_sum
      FROM ${T("deals")} d WHERE ${dealWhere} GROUP BY 1`),
    prisma.$queryRaw<Array<{ total: bigint; won: bigint; not_called: bigint; resp: number | null }>>(Prisma.sql`
      WITH lz AS (
        SELECT l.id, l.contact_id, l.created_at,
          (l.status = 'converted' OR EXISTS (SELECT 1 FROM ${T("deals")} wd WHERE wd.lead_id = l.id AND wd.status = 'won')) AS won
        FROM ${T("leads")} l
        WHERE l.business_id = ${businessId} AND l.created_at >= ${p.start} AND l.created_at <= ${to} ${byUser(Prisma.sql`l.owner_user_id`)} ${contactFilter(Prisma.sql`l.contact_id`, f)}
      ), first AS (
        SELECT lz.id, (SELECT min(fc.created_at) FROM ${T("calls")} fc WHERE fc.business_id = ${businessId} AND fc.contact_id = lz.contact_id
          AND fc.direction = 'outbound' AND fc.lead_dialed_at IS NOT NULL AND fc.created_at >= lz.created_at) AS first_at
        FROM lz
      )
      SELECT count(*) AS total, count(*) FILTER (WHERE lz.won) AS won, count(*) FILTER (WHERE f.first_at IS NULL) AS not_called,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f.first_at - lz.created_at)) / 60.0) FILTER (WHERE f.first_at IS NOT NULL))::float AS resp
      FROM lz JOIN first f ON f.id = lz.id`),
  ]);
  const outbound = callDays.reduce((a, r) => a + num(r.outbound), 0);
  const answered = callDays.reduce((a, r) => a + num(r.answered), 0);
  const talk = callDays.reduce((a, r) => a + num(r.talk), 0);
  const dealsWon = dealDays.reduce((a, r) => a + num(r.won), 0);
  const ilsCount = dealDays.reduce((a, r) => a + num(r.ils_count), 0);
  const revenue = Math.round(dealDays.reduce((a, r) => a + num(r.ils_sum), 0) * 100) / 100;
  const L = leadAgg[0] ?? { total: 0, won: 0, not_called: 0, resp: null };
  const newLeads = num(L.total);
  const values: Values = {
    outbound, answered, answerRate: outbound ? answered / outbound : null, talkSeconds: talk, avgTalkSeconds: answered ? Math.round(talk / answered) : null,
    newLeads, leadCloseRate: newLeads ? num(L.won) / newLeads : null, responseMinutes: L.resp === null ? null : Math.round(Number(L.resp) * 10) / 10, notCalled: num(L.not_called),
    dealsWon, revenue, avgDeal: ilsCount ? Math.round((revenue / ilsCount) * 100) / 100 : null,
  };
  const days = periodDays(p, tz);
  const series = days.map((day) => { const c = callDays.find((r) => r.day === day); const d = dealDays.find((r) => r.day === day); return { day, outbound: num(c?.outbound), answered: num(c?.answered), dealsWon: num(d?.won) }; });
  return { values, series };
}

export async function comparisonReport(user: SessionUser, q: { from: string; to: string; compare: "previous" | "custom" | "none"; compareFrom?: string | null; compareTo?: string | null } & ReportFilters) {
  const settings = await getBusinessSettings(user.businessId);
  const tz = settings.timezone;
  let periods;
  try { periods = resolvePeriods({ tz, from: q.from, to: q.to, compare: q.compare, compareFrom: q.compareFrom, compareTo: q.compareTo }); }
  catch (e) { throw new ApiError((e as Error).message, 400, "bad_range"); }
  if (periods.current.days > 366 || (periods.compare?.days ?? 0) > 366) throw new ApiError("טווח מקסימלי: שנה", 400, "bad_range");
  const visible = await visibleUserIds(user);
  if (q.userId && visible && !visible.includes(q.userId)) throw new ApiError("הנציג אינו בתחום שלך", 403, "forbidden");
  if (q.listId && !(await prisma.dialList.findFirst({ where: { id: q.listId, businessId: user.businessId }, select: { id: true } }))) throw new ApiError("הקמפיין לא נמצא", 404, "not_found");
  const userIds = q.userId ? [q.userId] : visible;
  const f: ReportFilters = { userId: q.userId ?? null, listId: q.listId ?? null, product: q.product?.trim() || null };
  const [cur, cmp] = await Promise.all([valuesFor(user.businessId, userIds, periods.current, f, tz), periods.compare ? valuesFor(user.businessId, userIds, periods.compare, f, tz) : Promise.resolve(null)]);
  const metrics = METRICS.map((m) => ({ ...m, change: compareMetric(cur.values[m.id] ?? null, cmp ? cmp.values[m.id] ?? null : undefined, m.kind, m.direction) as Change }));
  const iso = (p: Period | null) => p && { from: p.from, to: p.to, start: p.start.toISOString(), end: p.end.toISOString(), days: p.days, partial: p.partial };
  return { timezone: tz, periods: { current: iso(periods.current), compare: iso(periods.compare), mode: periods.mode, lengthMismatch: periods.lengthMismatch, partialCompare: periods.partialCompare }, filters: f, metrics, series: { current: cur.series, compare: cmp?.series ?? null } };
}

/** Filter choices limited to what the user may see. */
export async function reportFilterOptions(user: SessionUser) {
  const visible = await visibleUserIds(user);
  const [agents, lists, products] = await Promise.all([
    prisma.user.findMany({ where: { businessId: user.businessId, ...(visible ? { id: { in: visible } } : {}), role: { in: ["agent", "manager", "owner"] } }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
    prisma.dialList.findMany({ where: { businessId: user.businessId, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    prisma.$queryRaw<Array<{ p: string }>>`SELECT DISTINCT custom_fields->>'product' AS p FROM contacts WHERE business_id = ${user.businessId} AND custom_fields ? 'product' AND custom_fields->>'product' <> '' ORDER BY 1 LIMIT 200`,
  ]);
  const tz = (await getBusinessSettings(user.businessId)).timezone;
  return { agents, lists, products: products.map((x) => x.p), timezone: tz, today: dayOf(tz, new Date()) };
}
