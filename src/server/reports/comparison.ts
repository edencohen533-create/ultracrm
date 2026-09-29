/**
 * Reports: the same metrics for the current period and the comparison period, with the SAME definitions and filters
 * (agent, campaign = dial list, product). Everything is read inside the business (tenant scope + businessId) and the
 * user's own visibility (a team manager sees only their agents) – aggregates included.
 *
 * Filters on data that does not carry them are applied through the contact: a campaign filter keeps leads / deals
 * whose contact is in that dial list; a product filter keeps calls / leads / deals whose contact's product matches.
 */
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { getBusinessSettings } from "@/lib/settings";
import { agentMetrics } from "@/lib/stats";
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

async function contactIdsFor(businessId: string, f: ReportFilters): Promise<string[] | null> {
  if (!f.listId && !f.product) return null;
  const rows = await prisma.contact.findMany({ where: { businessId, ...(f.listId ? { queueLeads: { some: { listId: f.listId } } } : {}), ...(f.product ? { customFields: { path: ["product"], equals: f.product } } : {}) }, select: { id: true }, take: 50_000 });
  return rows.map((r) => r.id);
}

async function valuesFor(businessId: string, userIds: string[] | null, p: Period, f: ReportFilters, contactIds: string[] | null, tz: string) {
  const to = new Date(p.end.getTime() - 1);
  const byContact = contactIds ? { contactId: { in: contactIds } } : {};
  const owner = userIds ? { ownerUserId: { in: userIds } } : {};
  const [calls, deals, leads] = await Promise.all([
    // Calls: the dial-list filter is native (Call.listId); a product filter goes through the contact.
    f.product ? prisma.call.findMany({ where: { businessId, ...(userIds ? { userId: { in: userIds } } : {}), ...(f.listId ? { listId: f.listId } : {}), ...byContact, createdAt: { gte: p.start, lte: to } }, select: { direction: true, agentLegId: true, answeredAt: true, talkSeconds: true, createdAt: true } })
      .then((rows) => ({ perDay: rows, totals: null as null | { outboundAttempts: number; outboundAnswered: number; outboundTalkSeconds: number } }))
      : agentMetrics({ businessId, userIds, from: p.start, to, listId: f.listId ?? undefined }).then((m) => ({ perDay: null, totals: m.totals })),
    prisma.deal.findMany({ where: { businessId, status: "won", closedAt: { gte: p.start, lte: to }, ...owner, ...byContact }, select: { amount: true, currency: true, closedAt: true } }),
    prisma.lead.findMany({ where: { businessId, createdAt: { gte: p.start, lte: to }, ...owner, ...byContact }, select: { id: true, contactId: true, createdAt: true, status: true, deals: { where: { status: "won" }, select: { id: true } } } }),
  ]);
  let outbound = 0, answered = 0, talk = 0;
  if (calls.totals) { outbound = calls.totals.outboundAttempts; answered = calls.totals.outboundAnswered; talk = calls.totals.outboundTalkSeconds; }
  else for (const c of calls.perDay!) if (c.direction === "outbound" && c.agentLegId) { outbound++; if (c.answeredAt) { answered++; talk += c.talkSeconds ?? 0; } }
  // First real dial after each new lead (same definition as the agent table).
  const firsts = leads.length ? await prisma.call.findMany({ where: { businessId, direction: "outbound", leadDialedAt: { not: null }, contactId: { in: [...new Set(leads.map((l) => l.contactId))] }, createdAt: { gte: p.start } }, orderBy: { createdAt: "asc" }, select: { contactId: true, createdAt: true } }) : [];
  const resp: number[] = []; let notCalled = 0; let leadsWon = 0;
  for (const l of leads) {
    if (l.status === "converted" || l.deals.length) leadsWon++;
    const first = firsts.find((c) => c.contactId === l.contactId && c.createdAt >= l.createdAt);
    if (first) resp.push((first.createdAt.getTime() - l.createdAt.getTime()) / 60_000); else notCalled++;
  }
  resp.sort((a, b) => a - b);
  const median = resp.length ? (resp.length % 2 ? resp[(resp.length - 1) / 2] : (resp[resp.length / 2 - 1] + resp[resp.length / 2]) / 2) : null;
  const ils = deals.filter((d) => d.currency === "ILS");
  const revenue = Math.round(ils.reduce((s, d) => s + Number(d.amount), 0) * 100) / 100;
  const values: Values = {
    outbound, answered, answerRate: outbound ? answered / outbound : null, talkSeconds: talk, avgTalkSeconds: answered ? Math.round(talk / answered) : null,
    newLeads: leads.length, leadCloseRate: leads.length ? leadsWon / leads.length : null, responseMinutes: median === null ? null : Math.round(median * 10) / 10, notCalled,
    dealsWon: deals.length, revenue, avgDeal: ils.length ? Math.round((revenue / ils.length) * 100) / 100 : null,
  };
  // Daily series (business-timezone days) for the charts.
  const days = periodDays(p, tz);
  const series = Object.fromEntries(days.map((d) => [d, { outbound: 0, answered: 0, dealsWon: 0 }]));
  if (calls.perDay) for (const c of calls.perDay) { const d = series[dayOf(tz, c.createdAt)]; if (d && c.direction === "outbound" && c.agentLegId) { d.outbound++; if (c.answeredAt) d.answered++; } }
  else {
    const rows = await prisma.call.findMany({ where: { businessId, direction: "outbound", agentLegId: { not: null }, ...(userIds ? { userId: { in: userIds } } : {}), ...(f.listId ? { listId: f.listId } : {}), createdAt: { gte: p.start, lte: to } }, select: { createdAt: true, answeredAt: true } });
    for (const c of rows) { const d = series[dayOf(tz, c.createdAt)]; if (d) { d.outbound++; if (c.answeredAt) d.answered++; } }
  }
  for (const d of deals) { const s = d.closedAt ? series[dayOf(tz, d.closedAt)] : undefined; if (s) s.dealsWon++; }
  return { values, series: days.map((d) => ({ day: d, ...series[d] })) };
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
  const contactIds = await contactIdsFor(user.businessId, f);
  const [cur, cmp] = await Promise.all([valuesFor(user.businessId, userIds, periods.current, f, contactIds, tz), periods.compare ? valuesFor(user.businessId, userIds, periods.compare, f, contactIds, tz) : Promise.resolve(null)]);
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
