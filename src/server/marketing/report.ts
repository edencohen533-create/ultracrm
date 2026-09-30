/**
 * Marketing & sales report – ONE calculation used by the screen, the CSV export and the AI assistant.
 *
 * Sources (existing ones, no copies): Meta delivery (meta_ad_insights_daily, ad level), inquiries (lead_touchpoints),
 * leads / calls / WhatsApp messages (handling), won deals (closed ≠ paid), paid purchases = store orders the store
 * marked paid (net of refunds) + payments the provider confirmed (PayPlus); a CRM payment and a store order of the same
 * person, same amount (±1) within 72h are ONE purchase (the store order is kept).
 *
 * Attribution model "פנייה אחרונה לפני הרכישה" (inquiry_last_touch_v1) – every purchase / won deal gets exactly one:
 *   1. linked to a lead (payment of a deal / quote, or a deal's lead) → that lead's latest inquiry before the purchase;
 *   2. otherwise → the person's latest inquiry within the attribution window (days) before the purchase;
 *   3. otherwise → "לא משויך". An ad is identified only by the ids stored on the inquiry – never by name or date.
 * Repeat purchases are attributed only through their own inquiry (rule 1 / 2) – never automatically to the ad that
 * first brought the customer.
 *
 * Modes: "cohort" = inquiries that entered in the period and what they produced within the maturity window;
 * "activity" = spend, inquiries and purchases that happened in the period (purchases may come from older inquiries).
 * Ratios are computed from totals, never averaged; a zero denominator gives null ("אין נתון").
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { zonedDateTime, zonedParts } from "@/lib/business-day";
import { addDays, daysBetween } from "@/lib/reports/compare";

export type Level = "campaign" | "adset" | "ad";
export type Mode = "cohort" | "activity";
export interface ReportParams {
  from: string; to: string; mode: Mode; level: Level; windowDays: number; maturityDays: number;
  accountIds?: string[]; agentId?: string | null; campaignId?: string | null; adsetId?: string | null;
  revenueBasis?: "gross" | "ex_tax_shipping"; compare?: "previous" | "none" | "custom"; compareFrom?: string | null; compareTo?: string | null;
}

const MS_DAY = 86400_000;
const PAID_ORDER = new Set(["paid", "processing", "completed", "on_hold", "on-hold", "partially_refunded", "refunded"]);
const DEDUPE_HOURS = 72;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

interface Touch { id: string; contactId: string; leadId: string | null; channel: string; adId: string | null; adsetId: string | null; campaignId: string | null; adAccountId: string | null; basis: string; occurredAt: Date }
export interface Purchase { key: string; kind: "store_order" | "payment"; contactId: string; leadId: string | null; at: Date; gross: number; refunded: number; tax: number | null; shipping: number | null; currency: string; first: boolean; label: string; duplicateOf?: string }
interface Attributed { touch: Touch | null; basis: "linked_lead" | "linked_lead_without_source" | "last_inquiry_in_window" | "no_inquiry_in_window" }

async function loadPurchases(businessId: string) {
  const [orders, payments, wonDeals, quotes] = await Promise.all([
    prisma.storeOrder.findMany({ where: { businessId, contactId: { not: null } }, select: { id: true, contactId: true, status: true, total: true, currency: true, placedAt: true, createdAt: true, totals: true, payment: true, orderNumber: true } }),
    prisma.paymentRequest.findMany({ where: { businessId, status: "succeeded" }, select: { id: true, contactId: true, amountAgorot: true, currency: true, confirmedAt: true, createdAt: true, sourceType: true, sourceId: true, description: true } }),
    prisma.deal.findMany({ where: { businessId, status: "won" }, select: { id: true, contactId: true, leadId: true, closedAt: true, createdAt: true, amount: true, currency: true, title: true, ownerUserId: true } }),
    prisma.salesQuote.findMany({ where: { businessId }, select: { id: true, leadId: true } }),
  ]);
  const dealLead = new Map(wonDeals.map((d) => [d.id, d.leadId]));
  const allDealLead = new Map((await prisma.deal.findMany({ where: { businessId, id: { in: payments.filter((p) => p.sourceType === "deal" && p.sourceId).map((p) => p.sourceId!) } }, select: { id: true, leadId: true } })).map((d) => [d.id, d.leadId]));
  const quoteLead = new Map(quotes.map((q) => [q.id, q.leadId]));
  const list: Purchase[] = [];
  for (const o of orders) {
    if (!PAID_ORDER.has(o.status) || o.total === null) continue;
    const t = (o.totals ?? {}) as { refunded?: number; tax?: number; shipping?: number };
    const gross = Number(o.total);
    const refunded = o.status === "refunded" ? gross : Math.min(gross, Number(t.refunded ?? 0));
    const paidAt = (o.payment as { paidAt?: string } | null)?.paidAt;
    list.push({ key: `order:${o.id}`, kind: "store_order", contactId: o.contactId!, leadId: null, at: paidAt ? new Date(paidAt) : o.placedAt ?? o.createdAt, gross, refunded, tax: typeof t.tax === "number" ? t.tax : null, shipping: typeof t.shipping === "number" ? t.shipping : null, currency: (o.currency ?? "ILS").toUpperCase(), first: false, label: `הזמנה ${o.orderNumber}` });
  }
  for (const p of payments) {
    const leadId = p.sourceType === "deal" && p.sourceId ? allDealLead.get(p.sourceId) ?? dealLead.get(p.sourceId) ?? null : p.sourceType === "quote" && p.sourceId ? quoteLead.get(p.sourceId) ?? null : null;
    list.push({ key: `payment:${p.id}`, kind: "payment", contactId: p.contactId, leadId, at: p.confirmedAt ?? p.createdAt, gross: p.amountAgorot / 100, refunded: 0, tax: null, shipping: null, currency: p.currency.toUpperCase(), first: false, label: p.description });
  }
  // The same sale recorded by the CRM (payment) and by the store (order) counts once – the store order is kept.
  const byContact = new Map<string, Purchase[]>();
  for (const p of list) byContact.set(p.contactId, [...(byContact.get(p.contactId) ?? []), p]);
  for (const ps of byContact.values()) {
    for (const pay of ps.filter((x) => x.kind === "payment")) {
      const twin = ps.find((o) => o.kind === "store_order" && !o.duplicateOf && o.currency === pay.currency && Math.abs(o.gross - pay.gross) <= 1 && Math.abs(o.at.getTime() - pay.at.getTime()) <= DEDUPE_HOURS * 3600_000 && !ps.some((q) => q.duplicateOf === o.key));
      if (twin) { pay.duplicateOf = twin.key; if (pay.leadId && !twin.leadId) twin.leadId = pay.leadId; }
    }
  }
  const unique = list.filter((p) => !p.duplicateOf).sort((a, b) => a.at.getTime() - b.at.getTime());
  // First purchase = no earlier paid purchase and no won deal closed more than a day before it (a customer from before).
  const firstWon = new Map<string, number>();
  for (const d of wonDeals) { const t = (d.closedAt ?? d.createdAt).getTime(); if (!firstWon.has(d.contactId) || t < firstWon.get(d.contactId)!) firstWon.set(d.contactId, t); }
  const seen = new Set<string>();
  for (const p of unique) { if (!seen.has(p.contactId) && !(firstWon.has(p.contactId) && firstWon.get(p.contactId)! < p.at.getTime() - MS_DAY)) p.first = true; seen.add(p.contactId); }
  return { purchases: unique, duplicates: list.length - unique.length, wonDeals };
}

function makeAttributor(touchesByContact: Map<string, Touch[]>, windowDays: number) {
  return (contactId: string, leadId: string | null, at: Date): Attributed => {
    const ts = (touchesByContact.get(contactId) ?? []).filter((t) => t.occurredAt.getTime() <= at.getTime() + 5 * 60_000);
    if (leadId) {
      const own = ts.filter((t) => t.leadId === leadId);
      if (own.length) return { touch: own[own.length - 1], basis: "linked_lead" };
    }
    const inWindow = ts.filter((t) => t.occurredAt.getTime() >= at.getTime() - windowDays * MS_DAY);
    if (inWindow.length) return { touch: inWindow[inWindow.length - 1], basis: "last_inquiry_in_window" };
    return { touch: null, basis: leadId ? "linked_lead_without_source" : "no_inquiry_in_window" };
  };
}

export const MODEL_DESCRIPTION = "פנייה אחרונה לפני הרכישה: רכישה או עסקה הקשורה לליד משויכות לפנייה האחרונה של אותו ליד; אחרת לפנייה האחרונה של הלקוח בתוך חלון השיוך. בלי פנייה מתאימה – \"לא משויך\". מודעה מזוהה רק לפי מזהים שנשמרו בפנייה – לא לפי שם או תאריך.";

async function buildReport(user: SessionUser, p: ReportParams) {
  const businessId = user.businessId;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.from > p.to) throw new ApiError("טווח תאריכים לא תקין", 400, "validation");
  if (daysBetween(p.from, p.to) > 400) throw new ApiError("טווח מקסימלי 400 ימים", 400, "validation");
  const tz = (await getBusinessSettings(businessId)).timezone;
  const today = zonedParts(tz, new Date()).date;

  const accounts = await prisma.metaAdAccount.findMany({ where: { businessId, ...(p.accountIds?.length ? { id: { in: p.accountIds } } : {}) }, select: { id: true, accountId: true, name: true, currency: true, timezoneName: true, status: true, syncFrom: true, syncedThrough: true, lastSyncAt: true, lastSyncStatus: true } });
  const entities = await prisma.metaAdEntity.findMany({ where: { businessId }, select: { level: true, externalId: true, name: true, campaignExternalId: true, adsetExternalId: true, effectiveStatus: true, thumbnailUrl: true, previewUrl: true, nameHistory: true, adAccountRowId: true } });
  const ent = new Map(entities.map((e) => [`${e.level}:${e.externalId}`, e]));
  const accountRowIds = new Set(accounts.map((a) => a.id));
  const accountExt = new Set(accounts.map((a) => a.accountId));
  const filtered = Boolean(p.accountIds?.length);

  const [purchData, allTouches, leadsInfo] = await Promise.all([
    loadPurchases(businessId),
    prisma.leadTouchpoint.findMany({ where: { businessId }, orderBy: { occurredAt: "asc" }, select: { id: true, contactId: true, leadId: true, channel: true, adId: true, adsetId: true, campaignId: true, adAccountId: true, basis: true, occurredAt: true } }),
    prisma.lead.findMany({ where: { businessId }, select: { id: true, ownerUserId: true, status: true, contactId: true } }),
  ]);
  const leadById = new Map(leadsInfo.map((l) => [l.id, l]));
  const touchesByContact = new Map<string, Touch[]>();
  for (const t of allTouches) touchesByContact.set(t.contactId, [...(touchesByContact.get(t.contactId) ?? []), t]);
  const attribute = makeAttributor(touchesByContact, p.windowDays);

  // Row key of a touchpoint at the chosen level (ids from the inquiry; parents filled from the synced structure).
  const campaignOf = (t: Touch) => t.campaignId ?? (t.adId ? ent.get(`ad:${t.adId}`)?.campaignExternalId : null) ?? (t.adsetId ? ent.get(`adset:${t.adsetId}`)?.campaignExternalId : null) ?? null;
  const adsetOf = (t: Touch) => t.adsetId ?? (t.adId ? ent.get(`ad:${t.adId}`)?.adsetExternalId : null) ?? null;
  const inAccounts = (t: Touch) => {
    if (!filtered) return true;
    if (t.adAccountId) return accountExt.has(t.adAccountId);
    const e = (t.adId && ent.get(`ad:${t.adId}`)) || (t.adsetId && ent.get(`adset:${t.adsetId}`)) || (t.campaignId && ent.get(`campaign:${t.campaignId}`));
    return e ? accountRowIds.has(e.adAccountRowId) : false;
  };
  const rowKey = (t: Touch | null): string => {
    if (!t || t.basis !== "meta_ids") return "__none__";
    if (!inAccounts(t)) return "__other_account__";
    if (p.campaignId && campaignOf(t) !== p.campaignId) return "__outside__";
    if (p.adsetId && adsetOf(t) !== p.adsetId) return "__outside__";
    const k = p.level === "ad" ? t.adId : p.level === "adset" ? adsetOf(t) : campaignOf(t);
    return k ?? "__partial__";
  };
  const agentOk = (t: Touch | null, fallbackOwner?: string | null) => {
    if (!p.agentId) return true;
    const owner = t?.leadId ? leadById.get(t.leadId)?.ownerUserId : fallbackOwner;
    return owner === p.agentId;
  };

  const compute = async (from: string, to: string) => {
    const start = zonedDateTime(tz, from, "00:00")!; const end = zonedDateTime(tz, addDays(to, 1), "00:00")!;
    const inPeriod = (d: Date) => d >= start && d < end;
    const matureUntil = (d: Date) => d.getTime() + p.maturityDays * MS_DAY;
    // ── spend (ad level only; parents are sums) ──
    const spendRows = accounts.length ? await prisma.metaAdInsightDaily.groupBy({ by: ["adId", "adsetId", "campaignId", "currency"], where: { businessId, adAccountRowId: { in: [...accountRowIds] }, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } }, _sum: { spend: true, impressions: true, clicks: true, linkClicks: true, metaLeads: true } }) : [];
    const rows = new Map<string, Row>();
    const row = (k: string) => { if (!rows.has(k)) rows.set(k, emptyRow(k)); return rows.get(k)!; };
    for (const s of spendRows) {
      if (p.campaignId && s.campaignId !== p.campaignId) continue;
      if (p.adsetId && s.adsetId !== p.adsetId) continue;
      const r = row(p.level === "ad" ? s.adId : p.level === "adset" ? s.adsetId : s.campaignId);
      r.spendBy[s.currency] = (r.spendBy[s.currency] ?? 0) + Number(s._sum.spend ?? 0);
      r.impressions += s._sum.impressions ?? 0; r.clicks += s._sum.clicks ?? 0; r.linkClicks += s._sum.linkClicks ?? 0;
      if (s._sum.metaLeads !== null) r.metaLeads = (r.metaLeads ?? 0) + (s._sum.metaLeads ?? 0);
    }
    // ── inquiries of the period (unique person per row; the person's first inquiry of that row is used for handling) ──
    const periodTouches = allTouches.filter((t) => inPeriod(t.occurredAt) && agentOk(t));
    const firstPerRow = new Map<string, Touch>();
    for (const t of periodTouches) { const k = `${rowKey(t)}|${t.contactId}`; if (!firstPerRow.has(k)) firstPerRow.set(k, t); }
    const contactsAll = new Set(periodTouches.map((t) => t.contactId));
    const contactsFromAds = new Set(periodTouches.filter((t) => rowKey(t) !== "__none__" && rowKey(t) !== "__other_account__").map((t) => t.contactId));
    // Handling facts (calls / agent WhatsApp) for these people after their inquiry.
    const cids = [...contactsAll];
    const minAt = periodTouches.length ? periodTouches[0].occurredAt : start;
    const [calls, msgs] = cids.length ? await Promise.all([
      prisma.call.findMany({ where: { businessId, contactId: { in: cids }, createdAt: { gte: minAt } }, select: { contactId: true, direction: true, createdAt: true, answeredAt: true, userId: true } }),
      prisma.message.findMany({ where: { businessId, conversation: { contactId: { in: cids } }, createdAt: { gte: minAt } }, select: { direction: true, createdAt: true, sentByUserId: true, conversation: { select: { contactId: true } } } }),
    ]) : [[], []];
    const callsBy = new Map<string, typeof calls>(); for (const c of calls) if (c.contactId) callsBy.set(c.contactId, [...(callsBy.get(c.contactId) ?? []), c]);
    const msgsBy = new Map<string, typeof msgs>(); for (const m of msgs) msgsBy.set(m.conversation.contactId, [...(msgsBy.get(m.conversation.contactId) ?? []), m]);
    const handling = (t: Touch) => {
      const until = p.mode === "cohort" ? matureUntil(t.occurredAt) : Date.now();
      const after = (d: Date) => d.getTime() >= t.occurredAt.getTime() && d.getTime() <= until;
      const cs = (callsBy.get(t.contactId) ?? []).filter((c) => after(c.createdAt));
      const ms = (msgsBy.get(t.contactId) ?? []).filter((m) => after(m.createdAt));
      const attempts = [...cs.filter((c) => c.direction === "outbound").map((c) => c.createdAt.getTime()), ...ms.filter((m) => m.direction === "OUTBOUND" && m.sentByUserId).map((m) => m.createdAt.getTime())];
      const firstAttempt = attempts.length ? Math.min(...attempts) : null;
      const firstAgentMsg = ms.filter((m) => m.direction === "OUTBOUND" && m.sentByUserId).map((m) => m.createdAt.getTime()).sort()[0];
      const contacted = cs.some((c) => c.answeredAt) || (firstAgentMsg !== undefined && ms.some((m) => m.direction === "INBOUND" && m.createdAt.getTime() > firstAgentMsg));
      const lead = t.leadId ? leadById.get(t.leadId) : null;
      const handled = firstAttempt !== null || Boolean(lead && lead.status !== "new");
      return { firstAttemptMin: firstAttempt !== null ? (firstAttempt - t.occurredAt.getTime()) / 60_000 : null, contacted, handled, owner: lead?.ownerUserId ?? null };
    };
    for (const [k, t] of firstPerRow) {
      const r = row(k.split("|")[0]); const h = handling(t);
      r.leads++; if (h.handled) r.handled++; if (h.contacted) r.contacted++; if (h.firstAttemptMin !== null) r._attempts.push(h.firstAttemptMin);
      r._cohort.add(t.contactId);
    }
    // ── won deals (closed) and paid purchases, each with ONE attribution ──
    const inScope = (touch: Touch | null, at: Date) => p.mode === "cohort" ? Boolean(touch && inPeriod(touch.occurredAt) && at.getTime() <= matureUntil(touch.occurredAt)) : inPeriod(at);
    let dealsAll = 0; let dealsAttributed = 0; const dealList: Array<{ id: string; contactId: string; at: Date; amount: number; currency: string; title: string; rowKey: string; basis: string }> = [];
    for (const d of purchData.wonDeals) {
      const at = d.closedAt ?? d.createdAt; const a = attribute(d.contactId, d.leadId, at);
      if (!inScope(a.touch, at) || !agentOk(a.touch, d.ownerUserId)) continue;
      const k = rowKey(a.touch); if (k === "__outside__" || k === "__other_account__") continue;
      dealsAll++; if (k !== "__none__") dealsAttributed++;
      row(k).closedDeals++;
      dealList.push({ id: d.id, contactId: d.contactId, at, amount: Number(d.amount), currency: d.currency, title: d.title, rowKey: k, basis: a.basis });
    }
    let purchasesAll = 0; let purchasesAttributed = 0; let fullyRefunded = 0; const taxUnknown = { payments: 0 };
    const purchaseList: Array<Purchase & { rowKey: string; basis: string; touchId: string | null; net: number }> = [];
    for (const pu of purchData.purchases) {
      const a = attribute(pu.contactId, pu.leadId, pu.at);
      if (!inScope(a.touch, pu.at) || !agentOk(a.touch)) continue;
      const k = rowKey(a.touch); if (k === "__outside__" || k === "__other_account__") continue;
      // A fully refunded purchase is not a paid purchase (its refund is still shown); a partial refund lowers revenue.
      if (pu.gross - pu.refunded <= 0) { fullyRefunded++; const rr = row(rowKey(a.touch)); rr.refunds += pu.refunded; continue; }
      let net = pu.gross - pu.refunded;
      if (p.revenueBasis === "ex_tax_shipping") { if (pu.kind === "payment") taxUnknown.payments++; else net = Math.max(0, net - (pu.tax ?? 0) - (pu.shipping ?? 0)); }
      purchasesAll++; if (k !== "__none__") purchasesAttributed++;
      const r = row(k);
      r.paidPurchases++; r.revenueBy[pu.currency] = (r.revenueBy[pu.currency] ?? 0) + net;
      if (pu.first) { r.newCustomers.add(pu.contactId); r.revenueFirstBy[pu.currency] = (r.revenueFirstBy[pu.currency] ?? 0) + net; }
      else r.revenueRepeatBy[pu.currency] = (r.revenueRepeatBy[pu.currency] ?? 0) + net;
      if (pu.refunded > 0) r.refunds += pu.refunded;
      if (a.touch && r._cohort.has(pu.contactId)) r._paidContacts.add(pu.contactId);
      purchaseList.push({ ...pu, rowKey: k, basis: a.basis, touchId: a.touch?.id ?? null, net });
    }
    return { rows, contactsAll, contactsFromAds, dealsAll, dealsAttributed, purchasesAll, purchasesAttributed, taxUnknown, purchaseList, dealList, firstPerRow, handling, start, end, fullyRefunded };
  };

  const cur = await compute(p.from, p.to);
  // ── rows → view ──
  const nameOf = (k: string) => {
    if (k === "__none__") return "לא משויך למודעה";
    if (k === "__partial__") return p.level === "ad" ? "משויך לקמפיין / לקבוצה בלבד (ללא מזהה מודעה)" : "משויך לרמה אחרת בלבד";
    const e = ent.get(`${p.level}:${k}`);
    return e?.name ?? `${p.level === "ad" ? "מודעה" : p.level === "adset" ? "קבוצת מודעות" : "קמפיין"} ${k} (לא נמצא בחשבונות המחוברים)`;
  };
  const view = (r: Row) => {
    const spendCurrencies = Object.keys(r.spendBy); const revCurrencies = Object.keys(r.revenueBy);
    const spendOne = spendCurrencies.length === 1 ? r.spendBy[spendCurrencies[0]] : spendCurrencies.length === 0 ? 0 : null;
    const sameCurrency = spendCurrencies.length <= 1 && revCurrencies.length <= 1 && (!spendCurrencies.length || !revCurrencies.length || spendCurrencies[0] === revCurrencies[0]);
    const revenue = revCurrencies.length <= 1 ? r.revenueBy[revCurrencies[0]] ?? 0 : null;
    const spendSplitBlocked = Boolean(p.agentId);
    const e = ent.get(`${p.level}:${r.key}`);
    return {
      key: r.key, level: p.level, name: nameOf(r.key), special: r.key.startsWith("__"), status: e?.effectiveStatus ?? null, thumbnailUrl: p.level === "ad" ? e?.thumbnailUrl ?? null : null,
      renamed: Array.isArray(e?.nameHistory) && (e!.nameHistory as unknown[]).length > 0,
      spend: spendSplitBlocked ? null : spendOne, spendBy: spendSplitBlocked ? {} : r.spendBy, spendCurrency: spendCurrencies.length === 1 ? spendCurrencies[0] : null,
      impressions: r.impressions, clicks: r.clicks, linkClicks: r.linkClicks, metaLeads: r.metaLeads,
      leads: r.leads, handled: r.handled, contacted: r.contacted, handledRate: ratio(r.handled, r.leads), contactedRate: ratio(r.contacted, r.leads), firstAttemptMedianMin: median(r._attempts),
      closedDeals: r.closedDeals, paidPurchases: r.paidPurchases, newCustomers: r.newCustomers.size,
      revenue, revenueBy: r.revenueBy, revenueFirstBy: r.revenueFirstBy, revenueRepeatBy: r.revenueRepeatBy, refunds: r.refunds, revenueCurrency: revCurrencies.length === 1 ? revCurrencies[0] : null,
      cpl: !spendSplitBlocked && spendOne !== null ? ratio(spendOne, r.leads) : null,
      costPerNewCustomer: !spendSplitBlocked && spendOne !== null ? ratio(spendOne, r.newCustomers.size) : null,
      roas: !spendSplitBlocked && sameCurrency && spendOne !== null && revenue !== null ? ratio(revenue, spendOne) : null,
      paidRate: p.mode === "cohort" ? ratio(r._paidContacts.size, r.leads) : null,
      avgPurchase: revenue !== null ? ratio(revenue, r.paidPurchases) : null,
    };
  };
  const rowsView = [...cur.rows.values()].filter((r) => r.key !== "__outside__" && r.key !== "__other_account__").map(view);

  // Totals: additive numbers are sums of rows (every spend row / purchase / deal sits in exactly one row).
  const kpis = (c: typeof cur) => {
    const spendBy = Object.fromEntries(Object.entries((() => { const o: Record<string, number> = {}; for (const r of c.rows.values()) for (const [k, v] of Object.entries(r.spendBy)) o[k] = (o[k] ?? 0) + v; return o; })()));
    const revenueBy: Record<string, number> = {}; const firstBy: Record<string, number> = {}; const newCust = new Set<string>(); let paid = 0; let paidAds = 0; let revAdsBy: Record<string, number> = {}; const newCustAds = new Set<string>(); let metaLeads: number | null = null; let deals = 0; let handled = 0; let contacted = 0; const attempts: number[] = [];
    let cohortLeadsAds = 0; const paidContactsAds = new Set<string>();
    for (const r of c.rows.values()) {
      for (const [k, v] of Object.entries(r.revenueBy)) revenueBy[k] = (revenueBy[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.revenueFirstBy)) firstBy[k] = (firstBy[k] ?? 0) + v;
      for (const x of r.newCustomers) newCust.add(x);
      paid += r.paidPurchases; deals += r.closedDeals;
      if (r.key !== "__none__") { paidAds += r.paidPurchases; for (const [k, v] of Object.entries(r.revenueBy)) revAdsBy = { ...revAdsBy, [k]: (revAdsBy[k] ?? 0) + v }; for (const x of r.newCustomers) newCustAds.add(x); cohortLeadsAds += r.leads; for (const x of r._paidContacts) paidContactsAds.add(x); }
      if (r.metaLeads !== null) metaLeads = (metaLeads ?? 0) + r.metaLeads;
      handled += r.handled; contacted += r.contacted; attempts.push(...r._attempts);
    }
    const sc = Object.keys(spendBy); const rc = Object.keys(revAdsBy);
    const spendOne = p.agentId ? null : sc.length === 1 ? spendBy[sc[0]] : sc.length === 0 ? (accounts.length ? 0 : null) : null;
    const same = sc.length <= 1 && rc.length <= 1 && (!sc.length || !rc.length || sc[0] === rc[0]);
    const revAds = rc.length <= 1 ? revAdsBy[rc[0]] ?? 0 : null;
    const leadRows = [...c.firstPerRow.keys()].length;
    return {
      spend: spendOne, spendBy: p.agentId ? {} : spendBy, crmLeads: c.contactsAll.size, crmLeadsFromAds: c.contactsFromAds.size, metaLeads,
      cpl: spendOne !== null ? ratio(spendOne, c.contactsFromAds.size) : null,
      handled, contacted, handledRate: ratio(handled, leadRows), contactedRate: ratio(contacted, leadRows), firstAttemptMedianMin: median(attempts),
      closedDeals: deals, paidPurchases: paid, paidPurchasesFromAds: paidAds, newCustomers: newCust.size, newCustomersFromAds: newCustAds.size,
      costPerNewCustomer: spendOne !== null ? ratio(spendOne, newCustAds.size) : null,
      revenueBy, revenueFromAdsBy: revAdsBy, revenueFirstBy: firstBy,
      revenueFromAds: revAds, roas: spendOne !== null && same && revAds !== null ? ratio(revAds, spendOne) : null,
      avgPurchase: (() => { const k = Object.keys(revenueBy); return k.length === 1 ? ratio(revenueBy[k[0]], paid) : null; })(),
      paidRate: p.mode === "cohort" ? ratio(paidContactsAds.size, cohortLeadsAds) : null,
    };
  };

  let compare: null | { from: string; to: string; kpis: ReturnType<typeof kpis> } = null;
  if (p.compare !== "none") {
    const len = daysBetween(p.from, p.to);
    const cf = p.compare === "custom" && p.compareFrom && p.compareTo ? p.compareFrom : addDays(p.from, -len);
    const ct = p.compare === "custom" && p.compareFrom && p.compareTo ? p.compareTo : addDays(p.from, -1);
    compare = { from: cf, to: ct, kpis: kpis(await compute(cf, ct)) };
  }

  // Spend coverage: a day outside [syncFrom, syncedThrough] of an account is missing data, not zero.
  const coverage = accounts.filter((a) => a.status !== "disconnected" || a.syncedThrough).map((a) => {
    const f = a.syncFrom?.toISOString().slice(0, 10) ?? null; const t = a.syncedThrough?.toISOString().slice(0, 10) ?? null;
    const need = [p.to, today].sort()[0];
    return { accountRowId: a.id, name: a.name, accountId: a.accountId, currency: a.currency, timezone: a.timezoneName, status: a.status, syncedFrom: f, syncedThrough: t, lastSyncAt: a.lastSyncAt, lastSyncStatus: a.lastSyncStatus, complete: Boolean(f && t && f <= p.from && t >= need) };
  });
  const immature = p.mode === "cohort" && zonedDateTime(tz, addDays(p.to, 1), "00:00")!.getTime() + p.maturityDays * MS_DAY > Date.now();
  const warnings: string[] = [];
  if (!accounts.length) warnings.push("אין חשבון פרסום מחובר – אין נתוני הוצאה, עלות ו-ROAS.");
  if (coverage.some((c) => !c.complete)) warnings.push("נתוני ההוצאה חלקיים לתקופה: חלק מהימים עוד לא סונכרנו או שהסנכרון נכשל. ימים חסרים אינם אפס.");
  if (p.agentId) warnings.push("סינון לפי נציג: אין בסיס אמין לחלק את הוצאות המודעה בין נציגים – הוצאה, עלות ו-ROAS אינם מוצגים. לידים, טיפול ומכירות מסוננים לפי הנציג המטפל בליד.");
  if (immature) warnings.push(`חלק מהפניות בתקופה טרם השלימו חלון הבשלה של ${p.maturityDays} ימים – תוצאותיהן עוד עשויות לגדול.`);
  if (p.mode === "activity") warnings.push("מצב פעילות: ההכנסות והרכישות בתקופה עשויות להגיע מפניות מתקופות קודמות – יחס ההכנסה להוצאה אינו שיעור סגירה של הלידים שנכנסו בתקופה.");
  if (cur.taxUnknown.payments) warnings.push(`${cur.taxUnknown.payments} תשלומי סליקה נכללו בסכום המלא – לא נשמר עבורם פירוט מע״מ ומשלוח.`);
  if (cur.fullyRefunded) warnings.push(`${cur.fullyRefunded} רכישות הוחזרו במלואן ואינן נספרות כרכישות ששולמו.`);
  warnings.push("החזרים: הזמנות החנות מחושבות לאחר החזרים (מלאים וחלקיים). בתשלומי סליקה (PayPlus) לא מתקבל מידע על החזרים – סכומם מוצג כפי שאושר.");
  if (purchData.duplicates) warnings.push(`${purchData.duplicates} תשלומים זוהו כאותה רכישה שכבר קיימת בחנות ונספרו פעם אחת.`);

  return {
    period: { from: p.from, to: p.to, timezone: tz, today, mode: p.mode, level: p.level, windowDays: p.windowDays, maturityDays: p.maturityDays, immature, revenueBasis: p.revenueBasis ?? "gross" },
    model: { key: "inquiry_last_touch_v1", description: MODEL_DESCRIPTION, windowDays: p.windowDays },
    kpis: kpis(cur), compare,
    coverage: {
      accounts: coverage,
      leadsAttributedRate: ratio(cur.contactsFromAds.size, cur.contactsAll.size), leadsTotal: cur.contactsAll.size, leadsAttributed: cur.contactsFromAds.size,
      purchasesAttributedRate: ratio(cur.purchasesAttributed, cur.purchasesAll), purchasesTotal: cur.purchasesAll, purchasesAttributed: cur.purchasesAttributed,
      dealsAttributedRate: ratio(cur.dealsAttributed, cur.dealsAll), dealsTotal: cur.dealsAll, dealsAttributed: cur.dealsAttributed,
    },
    rows: rowsView,
    warnings,
    _internal: { cur, ent, nameOf, leadById },
  };
}

/** The report as the screen / export / AI get it. */
export async function marketingReport(user: SessionUser, p: ReportParams) {
  const { _internal, ...view } = await buildReport(user, p);
  void _internal;
  return view;
}

/** One row opened: the inquiries, deals and purchases behind its numbers, handling by agent and by response time. */
export async function marketingRowDetail(user: SessionUser, p: ReportParams, key: string) {
  const r = await buildReport(user, p);
  const { cur, ent, nameOf, leadById } = r._internal;
  const inquiries = [...cur.firstPerRow.entries()].filter(([k]) => k.split("|")[0] === key).map(([, t]) => ({ t, h: cur.handling(t) }));
  const contactIds = [...new Set([...inquiries.map((x) => x.t.contactId), ...cur.purchaseList.filter((x) => x.rowKey === key).map((x) => x.contactId), ...cur.dealList.filter((x) => x.rowKey === key).map((x) => x.contactId)])];
  const [contacts, users] = await Promise.all([
    prisma.contact.findMany({ where: { businessId: user.businessId, id: { in: contactIds } }, select: { id: true, fullName: true } }),
    prisma.user.findMany({ where: { businessId: user.businessId, isSupport: false }, select: { id: true, fullName: true } }),
  ]);
  const cname = new Map(contacts.map((c) => [c.id, c.fullName])); const uname = new Map(users.map((u) => [u.id, u.fullName]));
  const purchases = cur.purchaseList.filter((x) => x.rowKey === key);
  const paidContacts = new Set(purchases.map((x) => x.contactId));
  const byAgent = new Map<string, { agent: string; leads: number; handled: number; contacted: number; paid: number; attempts: number[] }>();
  const bucket = (m: number | null) => m === null ? "ללא ניסיון" : m <= 5 ? "עד 5 דק׳" : m <= 60 ? "5–60 דק׳" : m <= 24 * 60 ? "1–24 שעות" : "מעל יום";
  const byAge = new Map<string, { bucket: string; leads: number; contacted: number; paid: number }>();
  for (const { t, h } of inquiries) {
    const a = h.owner ?? "__none__"; const ag = byAgent.get(a) ?? { agent: h.owner ? uname.get(h.owner) ?? "נציג" : "ללא נציג", leads: 0, handled: 0, contacted: 0, paid: 0, attempts: [] };
    ag.leads++; if (h.handled) ag.handled++; if (h.contacted) ag.contacted++; if (paidContacts.has(t.contactId)) ag.paid++; if (h.firstAttemptMin !== null) ag.attempts.push(h.firstAttemptMin); byAgent.set(a, ag);
    const b = bucket(h.firstAttemptMin); const bg = byAge.get(b) ?? { bucket: b, leads: 0, contacted: 0, paid: 0 }; bg.leads++; if (h.contacted) bg.contacted++; if (paidContacts.has(t.contactId)) bg.paid++; byAge.set(b, bg);
  }
  const e = ent.get(`${p.level}:${key}`);
  const row = r.rows.find((x) => x.key === key) ?? null;
  return {
    key, name: nameOf(key), level: p.level, row, period: r.period, model: r.model, warnings: r.warnings,
    entity: e ? { status: e.effectiveStatus, thumbnailUrl: e.thumbnailUrl, previewUrl: e.previewUrl, nameHistory: e.nameHistory, campaignId: e.campaignExternalId, adsetId: e.adsetExternalId } : null,
    inquiries: inquiries.slice(0, 500).map(({ t, h }) => ({ contactId: t.contactId, name: cname.get(t.contactId) ?? "—", at: t.occurredAt, channel: t.channel, leadId: t.leadId, owner: h.owner ? uname.get(h.owner) ?? null : null, handled: h.handled, contacted: h.contacted, firstAttemptMin: h.firstAttemptMin, paid: paidContacts.has(t.contactId), leadStatus: t.leadId ? leadById.get(t.leadId)?.status ?? null : null })),
    purchases: purchases.map((x) => ({ key: x.key, kind: x.kind, contactId: x.contactId, name: cname.get(x.contactId) ?? "—", at: x.at, gross: x.gross, refunded: x.refunded, net: x.net, currency: x.currency, first: x.first, basis: x.basis, label: x.label })),
    deals: cur.dealList.filter((x) => x.rowKey === key).map((x) => ({ ...x, name: cname.get(x.contactId) ?? "—" })),
    byAgent: [...byAgent.values()].map(({ attempts, ...a }) => ({ ...a, firstAttemptMedianMin: median(attempts), handledRate: ratio(a.handled, a.leads), contactedRate: ratio(a.contacted, a.leads) })),
    byResponseTime: ["עד 5 דק׳", "5–60 דק׳", "1–24 שעות", "מעל יום", "ללא ניסיון"].map((b) => byAge.get(b) ?? { bucket: b, leads: 0, contacted: 0, paid: 0 }),
  };
}

interface Row { key: string; spendBy: Record<string, number>; impressions: number; clicks: number; linkClicks: number; metaLeads: number | null; leads: number; handled: number; contacted: number; _attempts: number[]; _cohort: Set<string>; _paidContacts: Set<string>; closedDeals: number; paidPurchases: number; newCustomers: Set<string>; revenueBy: Record<string, number>; revenueFirstBy: Record<string, number>; revenueRepeatBy: Record<string, number>; refunds: number }
const emptyRow = (key: string): Row => ({ key, spendBy: {}, impressions: 0, clicks: 0, linkClicks: 0, metaLeads: null, leads: 0, handled: 0, contacted: 0, _attempts: [], _cohort: new Set(), _paidContacts: new Set(), closedDeals: 0, paidPurchases: 0, newCustomers: new Set(), revenueBy: {}, revenueFirstBy: {}, revenueRepeatBy: {}, refunds: 0 });
