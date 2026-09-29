/**
 * Reports comparison against known data (real DB): current vs previous week in the business timezone, a call at
 * 23:59 local counted and one at 00:01 the next day not, zero deals, an empty period, an agent filter, isolation
 * between businesses and the permission check of the route.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { comparisonReport } from "@/server/reports/comparison";
import { GET as comparisonGET } from "@/app/api/reports/comparison/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let a1: SessionUser, a2: SessionUser;
const accounts: string[] = [];
let seq = 0;
async function member(biz: Biz, role: "agent" | "manager", name: string): Promise<SessionUser> {
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: biz.business.id, accountId: acc.id, email: acc.email, fullName: name, role } });
  return { id: u.id, accountId: acc.id, businessId: biz.business.id, email: acc.email, fullName: name, role, teamId: null };
}
const contact = async (owner: string) => { seq++; const p = `+9725${String(70000000 + seq).slice(-8)}`; return db.contact.create({ data: { businessId: A.business.id, fullName: `R ${seq}`, phoneE164: p, phoneRaw: p, ownerUserId: owner } }); };
const call = async (userId: string, contactId: string, e164: string, at: string, answered: number | null, extra: Record<string, unknown> = {}) => db.call.create({ data: {
  businessId: A.business.id, userId, contactId, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: e164, fromE164: "+97230000000",
  agentLegId: `leg-${crypto.randomUUID()}`, status: "ended", createdAt: new Date(at), endedAt: new Date(new Date(at).getTime() + 90_000),
  ...(answered !== null ? { answeredAt: new Date(new Date(at).getTime() + 10_000), talkSeconds: answered } : {}), ...extra } });
const report = (u: SessionUser, q: Record<string, unknown>) => withBusiness(u.businessId, () => comparisonReport(u, { compare: "previous", ...q } as never), u);
const metric = (r: Awaited<ReturnType<typeof comparisonReport>>, id: string) => r.metrics.find((m) => m.id === id)!.change;

describe("reports comparison", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("rep-a", { modules: { crm: true, telephony: true } });
    B = await createBusiness("rep-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    for (const b of [A, B]) { const x = await db.business.findUniqueOrThrow({ where: { id: b.business.id } }); await db.business.update({ where: { id: b.business.id }, data: { settings: { ...(x.settings as object), timezone: "Asia/Jerusalem" } as object } }); }
    a1 = await member(A, "agent", "נציג א"); a2 = await member(A, "agent", "נציג ב");
    const c1 = await contact(a1.id), c2 = await contact(a1.id), c3 = await contact(a2.id);
    // Current week 10–16.9 (Asia/Jerusalem = UTC+3).
    await call(a1.id, c1.id, c1.phoneE164, "2026-09-10T07:00:00Z", 60);
    await call(a1.id, c1.id, c1.phoneE164, "2026-09-12T07:00:00Z", 120);
    await call(a1.id, c2.id, c2.phoneE164, "2026-09-14T07:00:00Z", null);
    await call(a1.id, c2.id, c2.phoneE164, "2026-09-16T20:59:00Z", 180); // 23:59 local on the 16th → inside
    await call(a1.id, c2.id, c2.phoneE164, "2026-09-16T21:01:00Z", 30); // 00:01 local on the 17th → outside
    await call(a2.id, c3.id, c3.phoneE164, "2026-09-11T08:00:00Z", null);
    await call(a2.id, c3.id, c3.phoneE164, "2026-09-13T08:00:00Z", null);
    // Previous week 3–9.9.
    await call(a1.id, c1.id, c1.phoneE164, "2026-09-04T07:00:00Z", 100);
    await call(a1.id, c1.id, c1.phoneE164, "2026-09-05T07:00:00Z", null);
    // Deals: one won by a1 in the current week (₪1,000), none before.
    await db.deal.create({ data: { businessId: A.business.id, contactId: c1.id, title: "d", amount: 1000, status: "won", stage: "won", closedAt: new Date("2026-09-12T10:00:00Z"), ownerUserId: a1.id } });
    // Leads of the current week: one dialed 30 minutes later, one never dialed.
    const l1 = await db.lead.create({ data: { businessId: A.business.id, contactId: c2.id, ownerUserId: a1.id, createdAt: new Date("2026-09-14T06:30:00Z") } });
    await db.call.update({ where: { id: (await db.call.findFirstOrThrow({ where: { businessId: A.business.id, contactId: c2.id, createdAt: new Date("2026-09-14T07:00:00Z") } })).id }, data: { leadDialedAt: new Date("2026-09-14T07:00:00Z") } });
    await db.lead.create({ data: { businessId: A.business.id, contactId: c3.id, ownerUserId: a2.id, createdAt: new Date("2026-09-15T06:00:00Z") } });
    void l1;
  }, 300_000);
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("current vs previous week with the business day boundaries", async () => {
    const r = await report(A.session, { from: "2026-09-10", to: "2026-09-16" });
    expect(r.periods.compare).toMatchObject({ from: "2026-09-03", to: "2026-09-09", days: 7 });
    expect(r.periods.partialCompare).toBe(false);
    expect(metric(r, "outbound")).toMatchObject({ current: 6, previous: 2, delta: 4, relative: 200, trend: "better" }); // 00:01 call excluded
    expect(metric(r, "answered")).toMatchObject({ current: 3, previous: 1 });
    expect(metric(r, "answerRate")).toMatchObject({ current: 0.5, previous: 0.5, points: 0, trend: "same" });
    expect(metric(r, "talkSeconds")).toMatchObject({ current: 360, previous: 100, trend: "neutral" });
    expect(metric(r, "dealsWon")).toMatchObject({ current: 1, previous: 0, relative: null, note: "from_zero" });
    expect(metric(r, "revenue")).toMatchObject({ current: 1000, previous: 0, note: "from_zero" });
    expect(metric(r, "newLeads")).toMatchObject({ current: 2, previous: 0 });
    expect(metric(r, "responseMinutes")).toMatchObject({ current: 30 });
    expect(metric(r, "notCalled")).toMatchObject({ current: 1, previous: 0, trend: "worse" });
    expect(r.series.current.map((d) => d.day)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(r.series.current.find((d) => d.day === "2026-09-16")!.outbound).toBe(1);
    expect(r.series.current.reduce((s, d) => s + d.outbound, 0)).toBe(6);
  });

  it("the next local day holds the 00:01 call", async () => {
    const r = await report(A.session, { from: "2026-09-17", to: "2026-09-17", compare: "none" });
    expect(metric(r, "outbound")).toMatchObject({ current: 1, note: "no_compare" });
  });

  it("agent filter: same definitions for both periods; zero deals and missing rates are worded, not divided", async () => {
    const r = await report(A.session, { from: "2026-09-10", to: "2026-09-16", userId: a2.id });
    expect(metric(r, "outbound")).toMatchObject({ current: 2, previous: 0, note: "from_zero" });
    expect(metric(r, "answerRate")).toMatchObject({ current: 0, previous: null, note: "no_data" });
    expect(metric(r, "dealsWon")).toMatchObject({ current: 0, previous: 0, note: "both_zero", trend: "same" });
    expect(metric(r, "avgDeal")).toMatchObject({ current: null, note: "no_data" });
  });

  it("an empty period: zeros and no rates, nothing invented", async () => {
    const r = await report(A.session, { from: "2026-08-01", to: "2026-08-02" });
    for (const id of ["outbound", "answered", "dealsWon", "newLeads"]) expect(metric(r, id)).toMatchObject({ current: 0, previous: 0, note: "both_zero" });
    for (const id of ["answerRate", "leadCloseRate", "avgTalkSeconds", "responseMinutes"]) expect(metric(r, id).current).toBeNull();
    expect(r.series.current.every((d) => d.outbound === 0)).toBe(true);
  });

  it("isolation and permissions: another business sees nothing of A; agents are refused; A's campaign is not found for B", async () => {
    const r = await report(B.session, { from: "2026-09-10", to: "2026-09-16" });
    expect(metric(r, "outbound").current).toBe(0);
    expect(metric(r, "dealsWon").current).toBe(0);
    const aList = await db.dialList.create({ data: { businessId: A.business.id, name: "L" } });
    await expect(report(B.session, { from: "2026-09-10", to: "2026-09-16", listId: aList.id })).rejects.toMatchObject({ status: 404 });
    // Filtering B's report by an agent of A returns nothing of A.
    expect(metric(await report(B.session, { from: "2026-09-10", to: "2026-09-16", userId: a1.id }), "outbound").current).toBe(0);
    const req = new NextRequest("http://localhost/api/reports/comparison?from=2026-09-10&to=2026-09-16", { headers: { cookie: `ultracrm_session=${await signSession(a1)}` } });
    expect((await comparisonGET(req, { params: Promise.resolve({}) })).status).toBe(403);
  });
});
