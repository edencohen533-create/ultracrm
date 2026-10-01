/**
 * "פירוט לפי נציג": one row per agent (no duplicates from joins), and the table totals equal the page's summary
 * figures – including what has no agent (a won deal without an owner, calls of a support user), shown as one
 * explicit row instead of being dropped.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const agentsRoute = await import("@/app/api/reports/agents/route");
const { comparisonReport } = await import("@/server/reports/comparison");

describe("per-agent report rows", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  const ids: string[] = [];
  const accounts: string[] = [];
  const req = async (user: SessionUser, url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(user)}` } });

  beforeAll(async () => {
    a = await createBusiness("rep-rows", { modules: { crm: true, telephony: true } });
    b = await createBusiness("rep-rows-b", { modules: { crm: true, telephony: true } });
    const mk = async (name: string, extra: Record<string, unknown> = {}) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); return db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent", ...extra } }); };
    const u1 = await mk("דנה"); const u2 = await mk("דנה"); // same display name, two people – still two rows (by id)
    const support = await mk("תמיכה", { isSupport: true });
    ids.push(u1.id, u2.id);
    const contact = await db.contact.create({ data: { businessId: a.business.id, fullName: "לקוח", phoneE164: "+972501234000", phoneRaw: "x" } });
    const call = (userId: string, answered: boolean) => ({ businessId: a.business.id, userId, contactId: contact.id, mode: "manual" as const, direction: "outbound" as const, provider: "mock" as const, idempotencyKey: crypto.randomUUID(), fromE164: "+97230000000", toE164: contact.phoneE164!, agentLegId: `leg-${crypto.randomUUID()}`, status: "ended" as const, answeredAt: answered ? new Date() : null, endedAt: new Date(), talkSeconds: answered ? 60 : 0 });
    await db.call.createMany({ data: [call(u1.id, true), call(u1.id, false), call(u2.id, true), call(support.id, true)] });
    // A lead with several calls + several deals (the joins that could multiply rows)
    const lead = await db.lead.create({ data: { businessId: a.business.id, contactId: contact.id, ownerUserId: u1.id, status: "converted" } });
    await db.deal.createMany({ data: [
      { businessId: a.business.id, contactId: contact.id, leadId: lead.id, title: "1", amount: 100, status: "won", stage: "won", closedAt: new Date(), ownerUserId: u1.id },
      { businessId: a.business.id, contactId: contact.id, leadId: lead.id, title: "2", amount: 300, status: "won", stage: "won", closedAt: new Date(), ownerUserId: u1.id },
      { businessId: a.business.id, contactId: contact.id, title: "no owner", amount: 50, status: "won", stage: "won", closedAt: new Date(), ownerUserId: null },
    ] });
  });
  afterAll(async () => { await destroyBusiness(a.business.id); await destroyBusiness(b.business.id, [a.account.id, b.account.id]); await db.account.deleteMany({ where: { id: { in: accounts } } }); });

  it("one row per agent, totals = sum of rows = the summary figures", async () => {
    const from = new Date(Date.now() - 86400_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
    const res = await agentsRoute.GET(await req(a.session, `/api/reports/agents?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { rows: Array<{ id: string; outbound: number; answered: number; closed: number; talkSeconds: number }>; totals: { outbound: number; answered: number; closed: number; talkSeconds: number } } };
    const rowIds = data.rows.map((r) => r.id);
    expect(new Set(rowIds).size).toBe(rowIds.length); // no duplicates
    expect(rowIds.filter((x) => ids.includes(x)).length).toBe(2); // both "דנה"s, once each
    expect(data.rows.find((r) => r.id === ids[0])).toMatchObject({ outbound: 2, answered: 1, closed: 2 }); // 2 deals on 1 lead → 2, not 4
    const unassigned = data.rows.find((r) => r.id === "__unassigned")!;
    expect(unassigned).toMatchObject({ outbound: 1, answered: 1, closed: 1 }); // support user's call + the ownerless deal
    const sum = (k: "outbound" | "answered" | "closed" | "talkSeconds") => data.rows.reduce((t, r) => t + r[k], 0);
    expect(data.totals).toEqual({ outbound: sum("outbound"), answered: sum("answered"), handled: expect.any(Number), closed: sum("closed"), talkSeconds: sum("talkSeconds"), revenue: expect.any(Number) });
    // …and equal to the page's summary figures for the same period
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
    const summary = await withBusiness(a.business.id, () => comparisonReport(a.session, { from: day(new Date(Date.now() - 86400_000)), to: day(new Date()), compare: "none" }), a.session);
    const v = (id: string) => summary.metrics.find((m) => m.id === id)!.change.current;
    expect(data.totals.outbound).toBe(v("outbound"));
    expect(data.totals.answered).toBe(v("answered"));
    expect(data.totals.closed).toBe(v("dealsWon"));
  });

  it("a filter by agent shows that agent only (no unassigned row); another business sees none of it", async () => {
    const r = await agentsRoute.GET(await req(a.session, `/api/reports/agents?userId=${ids[1]}`), { params: Promise.resolve({}) });
    const rows = (await r.json()).data.rows as Array<{ id: string }>;
    expect(rows.map((x) => x.id)).toEqual([ids[1]]);
    const other = await agentsRoute.GET(await req(b.session, `/api/reports/agents`), { params: Promise.resolve({}) });
    const otherRows = (await other.json()).data.rows as Array<{ id: string }>;
    expect(otherRows.some((x) => ids.includes(x.id))).toBe(false);
  });
});
