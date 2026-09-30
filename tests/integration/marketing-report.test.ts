/**
 * Marketing & sales report – acceptance scenarios on a real DB with Meta's API stubbed at fetch level (no real Meta
 * call, no real payment): ad-level sync (history chunks, idempotent re-sync, restated days replaced, throttling, token
 * failure + reconnect), inquiry touchpoints, one attribution per purchase, closed ≠ paid, CRM payment + store order of
 * the same sale counted once, partial / full refunds, returning customer, a sale a week after the inquiry (maturity),
 * missing source, renamed / inactive ad, several ad accounts, two businesses, agent filter without spend split, and
 * totals = rows = export.
 */
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { sealSecret } from "@/lib/crypto";
import { createBusiness, destroyBusiness } from "./helpers";
import { createLead } from "@/lib/crm/pipeline";
import { addDays } from "@/lib/reports/compare";
import { zonedParts } from "@/lib/business-day";
import { syncAccountStep } from "@/server/marketing/meta-sync";
import { connectManualToken, connectionStatus, revokeByMetaUser } from "@/server/marketing/meta-connection";
import { marketingReport, marketingRowDetail, type ReportParams } from "@/server/marketing/report";
import { reportCsv } from "@/server/marketing/export";
import { marketingInsight } from "@/server/marketing/ai";
import { runAiTool, toolsFor } from "@/server/ai/tools";
import { GET as reportGET } from "@/app/api/reports/marketing/route";
import { GET as exportGET } from "@/app/api/reports/marketing/export/route";
import { POST as v1LeadsPOST } from "@/app/api/v1/leads/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
let agent: SessionUser, agentNoMarketing: SessionUser;
const TZ = "Asia/Jerusalem";
const today = () => zonedParts(TZ, new Date()).date;
const at = (daysAgo: number, hour = 10) => new Date(`${addDays(today(), -daysAgo)}T${String(hour).padStart(2, "0")}:00:00+03:00`);
const run = <T,>(biz: Biz, fn: () => Promise<T>) => withBusiness(biz.business.id, fn, biz.session);
const ctx = () => ({ params: Promise.resolve({}) });
const req = async (who: SessionUser, url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(who)}` } });

// ── Meta stub ───────────────────────────────────────────────────────────────────────────────────────────────────────
const meta = { adNames: { "701": "Ad Good", "702": "Ad Weak" } as Record<string, string>, fail: null as null | { status: number; code: number }, calls: 0, spendByDay: 50 };
const ADS: Record<string, Array<{ ad: string; adset: string; campaign: string }>> = {
  "111": [{ ad: "701", adset: "801", campaign: "901" }, { ad: "702", adset: "801", campaign: "901" }, { ad: "703", adset: "802", campaign: "901" }],
  "222": [{ ad: "7001", adset: "8001", campaign: "9001" }],
};
function days(from: string, to: string) { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
const realFetch = globalThis.fetch;
function stubMeta() {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (!url.hostname.includes("facebook.com")) return realFetch(input);
    meta.calls++;
    if (meta.fail) return new Response(JSON.stringify({ error: { message: "stub failure", code: meta.fail.code } }), { status: meta.fail.status, headers: { "x-business-use-case-usage": JSON.stringify({ x: [{ estimated_time_to_regain_access: 7 }] }) } });
    const m = url.pathname.match(/act_(\d+)(?:\/(\w+))?$/);
    const acc = m?.[1] ?? ""; const edge = m?.[2];
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (m && !edge) return json({ account_id: acc, name: `Account ${acc}`, currency: "ILS", timezone_name: TZ, account_status: 1 });
    if (edge === "campaigns") return json({ data: [...new Set(ADS[acc].map((x) => x.campaign))].map((id) => ({ id, name: `Campaign ${id}`, effective_status: "ACTIVE" })) });
    if (edge === "adsets") return json({ data: [...new Set(ADS[acc].map((x) => x.adset))].map((id) => ({ id, name: `Set ${id}`, campaign_id: ADS[acc].find((x) => x.adset === id)!.campaign })) });
    // 703 was deleted at Meta: not listed as a live ad, but its past delivery still comes back from insights.
    if (edge === "ads") return json({ data: ADS[acc].filter((x) => x.ad !== "703").map((x) => ({ id: x.ad, name: meta.adNames[x.ad] ?? `Ad ${x.ad}`, adset_id: x.adset, campaign_id: x.campaign, effective_status: "ACTIVE", creative: { thumbnail_url: "https://scontent.xx.fbcdn.net/t.jpg" } })) });
    if (edge === "insights") {
      const tr = JSON.parse(url.searchParams.get("time_range") ?? "{}") as { since: string; until: string };
      expect(url.searchParams.get("level")).toBe("ad");
      const rows = days(tr.since, tr.until).flatMap((d) => ADS[acc].map((x) => ({ date_start: d, ad_id: x.ad, ad_name: meta.adNames[x.ad] ?? `Ad ${x.ad}`, adset_id: x.adset, adset_name: `Set ${x.adset}`, campaign_id: x.campaign, campaign_name: `Campaign ${x.campaign}`, spend: String(meta.spendByDay), impressions: "1000", clicks: "20", inline_link_clicks: "15", actions: [{ action_type: "lead", value: "3" }, { action_type: "onsite_conversion.lead_grouped", value: "3" }], account_currency: "ILS" })));
      // Two pages to exercise cursor paging.
      const half = Math.ceil(rows.length / 2);
      if (!url.searchParams.get("after")) return json({ data: rows.slice(0, half), paging: rows.length > half ? { next: `${url.toString()}&after=p2` } : {} });
      return json({ data: rows.slice(half) });
    }
    return json({ data: [] });
  });
}

async function account(biz: Biz, accountId: string, daysBack: number) {
  return db.metaAdAccount.create({ data: { businessId: biz.business.id, accountId, name: `Account ${accountId}`, currency: "ILS", timezoneName: TZ, syncFrom: new Date(`${addDays(today(), -daysBack)}T00:00:00Z`), connectionId: (await db.metaAdConnection.findUniqueOrThrow({ where: { businessId: biz.business.id } })).id } });
}
async function syncAll(rowId: string) { for (let i = 0; i < 10; i++) { const r = await syncAccountStep(rowId); if (!("kind" in r) || r.kind !== "history") break; } }
async function contact(biz: Biz, name: string, phone: string) { return db.contact.create({ data: { businessId: biz.business.id, fullName: name, phoneE164: phone, phoneRaw: phone } }); }
async function inquiry(biz: Biz, c: { id: string }, adId: string | null, daysAgo: number, owner?: string) {
  return run(biz, () => createLead(biz.session, { contactId: c.id, source: adId ? "facebook" : "manual", ...(owner ? { ownerUserId: owner } : {}) }, adId ? "webhook" : "user", adId ? { touch: { adId, adsetId: ADS["111"].find((x) => x.ad === adId)?.adset ?? ADS["222"].find((x) => x.ad === adId)?.adset, campaignId: ADS["111"].find((x) => x.ad === adId)?.campaign ?? ADS["222"].find((x) => x.ad === adId)?.campaign }, dataSource: "api", occurredAt: at(daysAgo) } : { occurredAt: at(daysAgo) }));
}
let orderSeq = 0;
async function order(biz: Biz, c: { id: string }, total: number, daysAgo: number, extra: { status?: string; refunded?: number } = {}) {
  return db.storeOrder.create({ data: { businessId: biz.business.id, contactId: c.id, source: "woocommerce", externalId: `o-${Date.now()}-${orderSeq++}`, orderNumber: String(1000 + orderSeq), status: extra.status ?? "completed", total, currency: "ILS", placedAt: at(daysAgo, 12), totals: { total, tax: Math.round(total * 0.15), shipping: 20, ...(extra.refunded ? { refunded: extra.refunded } : {}) } } });
}
let payConn = "";
async function payment(biz: Biz, c: { id: string }, amount: number, daysAgo: number, source: { type: string; id?: string } = { type: "custom" }) {
  return db.paymentRequest.create({ data: { businessId: biz.business.id, connectionId: payConn, provider: "payplus", contactId: c.id, agentId: biz.user.id, sourceType: source.type, sourceId: source.id ?? null, description: "תשלום", amountAgorot: amount * 100, status: "succeeded", idempotencyKey: `k-${Date.now()}-${orderSeq++}`, confirmedAt: at(daysAgo, 11) } });
}

const P = (over: Partial<ReportParams> = {}): ReportParams => ({ from: addDays(today(), -10), to: today(), mode: "activity", level: "ad", windowDays: 30, maturityDays: 30, compare: "none", ...over });

describe("marketing & sales report", { timeout: 900_000 }, () => {
  const c: Record<string, { id: string }> = {};
  let rowA1 = "", rowA2 = "";
  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    stubMeta();
    A = await createBusiness("mkt-a", { modules: { crm: true, telephony: true } }); B = await createBusiness("mkt-b", { modules: { crm: true } });
    for (const b of [A, B]) await db.business.update({ where: { id: b.business.id }, data: { timezone: TZ } });
    const acc = await db.account.create({ data: { email: `mkt-agent-${Date.now()}@test.local`, fullName: "נציגה", passwordHash: "x", claimedAt: new Date() } });
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "נציגה", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "נציגה", role: "agent", teamId: null };
    agentNoMarketing = agent;
    payConn = (await db.paymentProviderConnection.create({ data: { businessId: A.business.id, provider: "payplus" } as never })).id;
    for (const b of [A, B]) await db.metaAdConnection.create({ data: { businessId: b.business.id, tokenSealed: sealSecret(`token-${b.business.id}`), verifiedAt: new Date(), kind: "manual_token", scopes: ["ads_read"] } });
    rowA1 = (await account(A, "111", 10)).id; rowA2 = (await account(A, "222", 10)).id;

    const names = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (const [i, n] of names.entries()) c[n] = await contact(A, `לקוח ${n}`, `+97250${String(1000000 + i)}`);
    // Returning customer: bought 60 days ago (no ad), comes back through ad 701 and buys again.
    await order(A, c.c10, 400, 60);
    // Ad 701 – 5 people (c3 inquires twice = still one lead); ad 702 – 4 people. Same spend per ad.
    await inquiry(A, c.c1, "701", 9, agent.id); await inquiry(A, c.c2, "701", 8); await inquiry(A, c.c3, "701", 8); await inquiry(A, c.c4, "701", 9);
    await run(A, () => createLead(A.session, { contactId: c.c3.id, source: "facebook" }, "webhook", { touch: { adId: "701", adsetId: "801", campaignId: "901" }, dataSource: "api", occurredAt: at(6) })); // repeat inquiry → same open lead
    await inquiry(A, c.c10, "701", 5);
    for (const n of ["c5", "c6", "c7", "c8"]) await inquiry(A, c[n], "702", 8);
    await inquiry(A, c.c9, null, 7); // no source
    // Purchases.
    const leadC1 = await db.lead.findFirstOrThrow({ where: { contactId: c.c1.id } });
    const dealC1 = await db.deal.create({ data: { businessId: A.business.id, contactId: c.c1.id, leadId: leadC1.id, title: "c1", amount: 1000, status: "won", stage: "won", closedAt: at(7) } });
    await payment(A, c.c1, 1000, 7, { type: "deal", id: dealC1.id });                   // closed + paid (via the deal's lead)
    await payment(A, c.c2, 500, 6); await order(A, c.c2, 500, 6);                          // same sale in CRM and store → once
    await order(A, c.c4, 300, 1);                                                          // 8 days after the inquiry
    await order(A, c.c10, 200, 3);                                                         // returning customer, repeat purchase
    await order(A, c.c5, 700, 5, { status: "refunded" });                                  // fully refunded → not paid
    await order(A, c.c6, 800, 5, { status: "partially_refunded", refunded: 200 });         // net 600
    await db.deal.create({ data: { businessId: A.business.id, contactId: c.c7.id, title: "c7", amount: 900, status: "won", stage: "won", closedAt: at(4) } }); // closed, never paid
    await order(A, c.c9, 250, 4);                                                          // no source → unattributed

    // Business B: its own lead from "ad 701" and its own sale – must never appear in A.
    const bc = await contact(B, "לקוח של B", "+972509999999");
    await run(B, () => createLead(B.session, { contactId: bc.id, source: "facebook" }, "webhook", { touch: { adId: "701" }, dataSource: "api", occurredAt: at(3) }));
    await db.storeOrder.create({ data: { businessId: B.business.id, contactId: bc.id, source: "woocommerce", externalId: "b-1", orderNumber: "B1", status: "completed", total: 99999, currency: "ILS", placedAt: at(2) } });

    // Let the distribution policy run first, then fix owners so the agent split is deterministic: only c1 is the agent's.
    const { processDomainEvents } = await import("@/lib/events");
    await run(A, () => processDomainEvents({ businessId: A.business.id }).catch(() => undefined));
    await db.lead.updateMany({ where: { businessId: A.business.id }, data: { ownerUserId: A.user.id } });
    await db.lead.updateMany({ where: { businessId: A.business.id, contactId: c.c1.id }, data: { ownerUserId: agent.id } });
    await run(A, () => syncAll(rowA1)); await run(A, () => syncAll(rowA2));
  }, 600_000);
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    for (const b of [A, B]) if (b) { await db.paymentRequest.deleteMany({ where: { businessId: b.business.id } }); await db.paymentProviderConnection.deleteMany({ where: { businessId: b.business.id } }); await db.storeOrder.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id).catch(() => undefined); }
    await db.account.deleteMany({ where: { id: { in: [A?.account.id, B?.account.id, agent?.accountId].filter(Boolean) as string[] } } });
  }, 300_000);

  it("syncs ad-level days in chunks; re-sync replaces instead of adding; deleted ads keep their spend", async () => {
    const n = await db.metaAdInsightDaily.count({ where: { adAccountRowId: rowA1 } });
    expect(n).toBe(11 * 3); // 11 days × 3 ads (incl. the deleted 703)
    const acc = await db.metaAdAccount.findUniqueOrThrow({ where: { id: rowA1 } });
    expect(acc.syncedThrough?.toISOString().slice(0, 10)).toBe(today());
    expect(await db.metaSyncRun.count({ where: { adAccountRowId: rowA1, kind: "history", status: "ok" } })).toBe(2); // 7 + 4 days
    // Meta restates recent days: a refresh replaces them – no duplicates, new values.
    meta.spendByDay = 60;
    await run(A, () => syncAccountStep(rowA1, { force: true }));
    expect(await db.metaAdInsightDaily.count({ where: { adAccountRowId: rowA1 } })).toBe(33);
    meta.spendByDay = 50;
    await db.metaSyncRun.deleteMany({ where: { adAccountRowId: rowA1, kind: "refresh14" } });
    await run(A, () => syncAccountStep(rowA1, { force: true }));
    const sum = await db.metaAdInsightDaily.aggregate({ where: { adAccountRowId: rowA1 }, _sum: { spend: true } });
    expect(Number(sum._sum.spend)).toBe(33 * 50);
    expect((await db.metaAdEntity.findFirstOrThrow({ where: { businessId: A.business.id, level: "ad", externalId: "703" } })).name).toBe("Ad 703");
  });

  it("one attribution per purchase; closed ≠ paid; duplicate sale, refunds, returning customer and missing source", async () => {
    const r = await run(A, () => marketingReport(A.session, P({ accountIds: [rowA1] })));
    const row = (k: string) => r.rows.find((x) => x.key === k)!;
    // Same spend per ad (11 days × 50), different results.
    expect(row("701").spend).toBe(550); expect(row("702").spend).toBe(550); expect(row("703").spend).toBe(550);
    expect(row("701").leads).toBe(5); expect(row("702").leads).toBe(4);
    expect(row("701").cpl).toBeCloseTo(110); expect(row("702").cpl).toBeCloseTo(137.5);
    // 701: c1 1000 (linked lead) + c2 500 (once, store order kept) + c4 300 + c10 200 (repeat) = 2000, 4 purchases, 3 new.
    expect(row("701")).toMatchObject({ paidPurchases: 4, newCustomers: 3, revenue: 2000, closedDeals: 1 });
    expect(row("701").roas).toBeCloseTo(2000 / 550);
    // 702: c6 net 600 (partial refund); c5 fully refunded → not a paid purchase; c7 closed but not paid.
    expect(row("702")).toMatchObject({ paidPurchases: 1, newCustomers: 1, revenue: 600, closedDeals: 1 });
    // Missing source → "לא משויך" (never guessed).
    expect(row("__none__")).toMatchObject({ paidPurchases: 1, revenue: 250, leads: 1 });
    expect(row("703")).toMatchObject({ leads: 0, paidPurchases: 0, name: "Ad 703" });
    expect(r.kpis.metaLeads).toBe(33 * 3); // "lead" action only – never summed with lead_grouped
    expect(r.coverage.purchasesTotal).toBe(6); expect(r.coverage.purchasesAttributed).toBe(5);
    expect(r.warnings.join(" ")).toContain("זוהו כאותה רכישה");
    expect(JSON.stringify(r)).not.toContain("99999"); // business B's sale
  });

  it("cohort mode: a sale 8 days after the inquiry counts only inside the maturity window; immature cohorts are flagged", async () => {
    const r7 = await run(A, () => marketingReport(A.session, P({ mode: "cohort", maturityDays: 7, accountIds: [rowA1] })));
    const r30 = await run(A, () => marketingReport(A.session, P({ mode: "cohort", maturityDays: 30, accountIds: [rowA1] })));
    const g = (r: typeof r7) => r.rows.find((x) => x.key === "701")!;
    expect(g(r30).paidPurchases - g(r7).paidPurchases).toBe(1); // c4 (+8 days)
    expect(g(r30).paidRate).toBeCloseTo(4 / 5);
    expect(r30.period.immature).toBe(true);
    const act = await run(A, () => marketingReport(A.session, P({ mode: "activity", accountIds: [rowA1] })));
    expect(g(act).paidRate).toBeNull(); // no close rate in activity mode (would mix periods)
  });

  it("totals equal the rows and the export; levels roll up without double counting spend", async () => {
    const r = await run(A, () => marketingReport(A.session, P({ accountIds: [rowA1] })));
    const sum = (k: "paidPurchases" | "closedDeals") => r.rows.reduce((s, x) => s + x[k], 0);
    expect(sum("paidPurchases")).toBe(r.kpis.paidPurchases); expect(sum("closedDeals")).toBe(r.kpis.closedDeals);
    expect(r.rows.reduce((s, x) => s + (x.spend ?? 0), 0)).toBe(r.kpis.spend);
    const camp = await run(A, () => marketingReport(A.session, P({ level: "campaign", accountIds: [rowA1] })));
    expect(camp.rows.find((x) => x.key === "901")!.spend).toBe(1650); // 3 ads × 550 – campaign = sum of its ads
    expect(camp.kpis.spend).toBe(r.kpis.spend);
    const drill = await run(A, () => marketingReport(A.session, P({ level: "ad", campaignId: "901", adsetId: "801", accountIds: [rowA1] })));
    expect(drill.rows.filter((x) => !x.special).map((x) => x.key).sort()).toEqual(["701", "702"]);
    const csv = reportCsv(r);
    expect(csv).toContain("Ad Good"); expect(csv).toContain(`"${r.kpis.paidPurchases}"`);
    const res = await exportGET(await req(A.session, `/api/reports/marketing/export?from=${P().from}&to=${P().to}&mode=activity&level=ad&accounts=${rowA1}&compare=none`), ctx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(csv.replace(/^\ufeff/, "")); // Response.text() drops the BOM
  });

  it("row detail lists the inquiries / purchases behind the numbers, by agent and by response time", async () => {
    const d = await run(A, () => marketingRowDetail(A.session, P({ accountIds: [rowA1] }), "701"));
    expect(d.inquiries).toHaveLength(5);
    expect(d.purchases.map((x) => x.net).sort((a, b) => a - b)).toEqual([200, 300, 500, 1000]);
    expect(d.purchases.find((x) => x.net === 1000)!.basis).toBe("linked_lead");
    expect(d.byAgent.find((x) => x.agent === "נציגה")?.leads).toBe(1);
    expect(d.entity?.thumbnailUrl).toContain("fbcdn.net");
  });

  it("renamed ad keeps its id and history; several accounts stay separate", async () => {
    meta.adNames["701"] = "Ad Good v2";
    await db.metaAdAccount.update({ where: { id: rowA1 }, data: { structureSyncedAt: null } });
    await run(A, () => syncAccountStep(rowA1, { force: true }));
    const e = await db.metaAdEntity.findFirstOrThrow({ where: { businessId: A.business.id, level: "ad", externalId: "701" } });
    expect(e.name).toBe("Ad Good v2"); expect((e.nameHistory as Array<{ name: string }>)[0].name).toBe("Ad Good");
    const r = await run(A, () => marketingReport(A.session, P({ accountIds: [rowA1] })));
    expect(r.rows.find((x) => x.key === "701")).toMatchObject({ name: "Ad Good v2", renamed: true, leads: 5 });
    expect(r.rows.some((x) => x.key === "7001")).toBe(false);
    const both = await run(A, () => marketingReport(A.session, P()));
    expect(both.rows.find((x) => x.key === "7001")!.spend).toBe(550);
    expect(both.kpis.spend).toBe(550 * 4);
  });

  it("agent filter never splits ad spend; the report is closed to agents and isolated per business", async () => {
    const r = await run(A, () => marketingReport(A.session, P({ agentId: agent.id, accountIds: [rowA1] })));
    const g = r.rows.find((x) => x.key === "701")!;
    expect(g.leads).toBe(1); expect(g.spend).toBeNull(); expect(g.roas).toBeNull(); expect(r.kpis.spend).toBeNull();
    expect(r.warnings.join(" ")).toContain("אין בסיס אמין לחלק");
    expect((await reportGET(await req(agentNoMarketing, `/api/reports/marketing?from=${P().from}&to=${P().to}`), ctx())).status).toBe(403);
    const rb = await run(B, () => marketingReport(B.session, P()));
    expect(rb.kpis.crmLeads).toBe(1); expect(rb.kpis.spend).toBeNull(); // B has no synced account
    expect(JSON.stringify(rb)).not.toContain("לקוח c1");
  });

  it("throttling waits; an expired token marks the connection and a reconnect resumes", async () => {
    meta.fail = { status: 400, code: 17 };
    await run(A, () => syncAccountStep(rowA2, { force: true }));
    let a2 = await db.metaAdAccount.findUniqueOrThrow({ where: { id: rowA2 } });
    expect(a2.status).toBe("throttled"); expect(a2.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 200_000);
    const before = meta.calls;
    expect(await run(A, () => syncAccountStep(rowA2))).toEqual({ skipped: "waiting" });
    expect(meta.calls).toBe(before);
    meta.fail = { status: 400, code: 190 };
    await run(A, () => syncAccountStep(rowA2, { force: true }));
    a2 = await db.metaAdAccount.findUniqueOrThrow({ where: { id: rowA2 } });
    expect(a2.status).toBe("auth_error");
    expect((await db.metaAdConnection.findUniqueOrThrow({ where: { businessId: A.business.id } })).status).toBe("expired");
    // Data already synced stays; the status is honest.
    expect(await db.metaAdInsightDaily.count({ where: { adAccountRowId: rowA2 } })).toBe(11);
    meta.fail = null;
    await run(A, () => connectManualToken(A.session, { accountId: "act_222", accessToken: "new-token-after-reconnect" }));
    const st = await run(A, () => connectionStatus(A.session));
    expect(st.connection?.status).toBe("active");
    expect(st.accounts.find((x) => x.id === rowA2)?.status).toBe("active");
    expect(JSON.stringify(st)).not.toContain("new-token-after-reconnect");
  });

  it("public API: explicit attribution, repeat Meta lead delivered twice is one inquiry, names never become ad ids", async () => {
    const { createApiKey } = await import("@/server/services/integrations");
    const token = (await run(A, () => createApiKey(A.session, "qa"))).key;
    const post = (body: unknown) => v1LeadsPOST(new Request("http://localhost/api/v1/leads", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const body = { fullName: "ליד מטופס", phone: "0507777777", attribution: { ad_id: "701", adset_id: "801", campaign_id: "901", form_id: "5555", leadgen_id: "444444", utm_source: "facebook" } };
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(200);
    const ct = await db.contact.findFirstOrThrow({ where: { businessId: A.business.id, phoneE164: "+972507777777" } });
    const tps = await db.leadTouchpoint.findMany({ where: { contactId: ct.id } });
    expect(tps).toHaveLength(1);
    expect(tps[0]).toMatchObject({ adId: "701", formId: "5555", metaLeadId: "444444", channel: "meta_lead_form", basis: "meta_ids" });
    await post({ fullName: "שם בלבד", phone: "0507777778", attribution: { utm_campaign: "Campaign 901", ad_name: "Ad Good" } });
    const t2 = await db.leadTouchpoint.findFirstOrThrow({ where: { businessId: A.business.id, contact: { phoneE164: "+972507777778" } } });
    expect(t2).toMatchObject({ adId: null, campaignId: null, basis: "utm_only" });
  });
  it("AI answers from the same calculation, refuses a winner on a small / immature sample, and is closed without permission", async () => {
    const most = (await run(A, () => marketingInsight(A.session, { focus: "most_paid", days: 11 }))) as Extract<Awaited<ReturnType<typeof marketingInsight>>, { leader: unknown }>;
    const rep = await run(A, () => marketingReport(A.session, P({ mode: "cohort" })));
    expect(most.conclusionAllowed).toBe(false); // 5 leads < 20 – no "winning ad"
    expect(most.leader).toBeNull();
    expect(most.whyNoConclusion.join(" ")).toContain("מדגם");
    expect(most.candidates[0].paidPurchases).toBe(rep.rows.find((x) => x.key === most.candidates[0].id)!.paidPurchases);
    expect(most.link).toContain("/reports/marketing");
    expect(most.rules).toContain("הצעות בלבד");
    const cmp = (await run(A, () => marketingInsight(A.session, { focus: "compare", days: 11 }))) as Extract<Awaited<ReturnType<typeof marketingInsight>>, { current: unknown }>;
    expect(cmp.conclusionAllowed).toBe(false); // immature cohort
    const denied = await run(A, () => runAiTool({ user: agent, read: {} as never, ai: {} as never, tz: TZ, conversationId: null, channel: "app" }, "marketing_performance", { focus: "most_paid" }));
    expect(denied.ok).toBe(false);
    const { effectiveAccess } = await import("@/lib/access/engine");
    const agentTools = toolsFor({ user: agent, read: {} as never, ai: {} as never, tz: TZ, conversationId: null, channel: "app", access: await effectiveAccess(A.business.id, agent.id) }).map((x) => x.name);
    expect(agentTools).not.toContain("marketing_performance");
  });
  it("Meta deauthorize: the Ads login of that Meta user is revoked in its business only", async () => {
    await run(B, () => db.metaAdConnection.update({ where: { businessId: B.business.id }, data: { metaUserId: "meta-user-b" } }));
    expect(await revokeByMetaUser("meta-user-b")).toBe(1);
    expect((await run(B, () => db.metaAdConnection.findUniqueOrThrow({ where: { businessId: B.business.id } }))).status).toBe("revoked");
    expect((await run(A, () => db.metaAdConnection.findUniqueOrThrow({ where: { businessId: A.business.id } }))).status).toBe("active");
  });
});
