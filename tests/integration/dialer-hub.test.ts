/**
 * "חייגן" area (real DB, real routes): call history scope (agent = own calls, manager = business), isolation between
 * businesses, the filters the tabs / links use (customer, dial list, report metric, business-local dates), the call
 * details drawer, recordings permission, the active-calls feed (managers only) and the explicit listen / whisper
 * permission, plus: a report metric opens the SAME calls it counts.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { signSession, type SessionUser } from "@/lib/auth";
import { invalidateEntitlement } from "@/lib/access/engine";
import { createBusiness, destroyBusiness } from "./helpers";
import { GET as callsGET } from "@/app/api/calls/route";
import { GET as callGET } from "@/app/api/calls/[id]/route";
import { GET as recordingGET } from "@/app/api/recordings/[callId]/route";
import { GET as liveGET } from "@/app/api/manager/live/route";
import { POST as monitorPOST } from "@/app/api/manager/monitor/route";
import { GET as comparisonGET } from "@/app/api/reports/comparison/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
let agent1: SessionUser, agent2: SessionUser, manager: SessionUser;
const accounts: string[] = [];
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const req = async (who: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(who)}`, "Content-Type": "application/json", origin: "http://localhost" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async (r: Response) => { const b = await r.json().catch(() => null); return { status: r.status, body: b && typeof b === "object" && "data" in b ? b.data : b }; };
const member = async (biz: Biz, role: "manager" | "agent", name: string, permissions?: unknown) => {
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: biz.business.id, accountId: acc.id, email: acc.email, fullName: name, role, ...(permissions ? { permissions: permissions as object } : {}) } });
  return { id: u.id, accountId: acc.id, businessId: biz.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser;
};
let seq = 0;
const call = (biz: Biz, userId: string, data: Record<string, unknown> = {}) => db.call.create({ data: { businessId: biz.business.id, userId, mode: "manual", provider: "mock", idempotencyKey: `hub-${Date.now()}-${seq++}`, toE164: "+972541234567", fromE164: "+97231234567", status: "ended", ...data } as never });
const ids = (b: { items: Array<{ id: string }> }) => b.items.map((x) => x.id).sort();

describe("dialer area – call history, active calls, permissions", { timeout: 600_000 }, () => {
  let contactA: string, listA: string, a1Answered: string, a1Missed: string, a2Call: string, a2Recorded: string, bCall: string, a1Inbound: string, liveCall: string;
  beforeAll(async () => {
    A = await createBusiness("hub-a", { modules: { crm: true, telephony: true } }); B = await createBusiness("hub-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    agent1 = await member(A, "agent", "נציג 1"); agent2 = await member(A, "agent", "נציג 2");
    // A manager with explicit permissions WITHOUT listen / whisper.
    manager = await member(A, "manager", "מנהלת", { template: "custom", scope: "business", modules: { crm: { enabled: true, actions: ["view"] }, telephony: { enabled: true, actions: ["use", "team_settings", "recordings"] } } });
    contactA = (await db.contact.create({ data: { businessId: A.business.id, fullName: "לקוח חייגן", phoneE164: "+972541234567", phoneRaw: "x" } })).id;
    listA = (await db.dialList.create({ data: { businessId: A.business.id, name: "רשימת בדיקה" } as never })).id;
    const now = Date.now();
    a1Answered = (await call(A, agent1.id, { contactId: contactA, listId: listA, agentLegId: "leg-1", answeredAt: new Date(now - 60_000), endedAt: new Date(now - 30_000), talkSeconds: 30, telephonyResult: "answered", outcome: "sale" })).id;
    a1Missed = (await call(A, agent1.id, { contactId: contactA, agentLegId: "leg-2", telephonyResult: "no_answer", endedAt: new Date(now - 20_000) })).id;
    a1Inbound = (await call(A, agent1.id, { direction: "inbound", answeredAt: new Date(now - 10_000), endedAt: new Date(now - 5_000) })).id;
    a2Call = (await call(A, agent2.id, { agentLegId: "leg-3", answeredAt: new Date(now - 50_000), endedAt: new Date(now - 40_000), talkSeconds: 10 })).id;
    a2Recorded = (await call(A, agent2.id, { recordingStatus: "saved", recordingId: "rec-x" })).id;
    liveCall = (await call(A, agent2.id, { status: "answered", agentLegId: "leg-live", conferenceId: "conf-1", answeredAt: new Date(now - 5_000), endedAt: null })).id;
    bCall = (await call(B, B.user.id, { agentLegId: "leg-b", answeredAt: new Date(now - 50_000) })).id;
  }, 300_000);
  afterAll(async () => {
    for (const b of [A, B]) if (b) { await db.call.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id).catch(() => undefined); }
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 300_000);

  it("an agent sees only their own calls; the owner sees the business; nobody sees another business", async () => {
    const mine = await json(await callsGET(await req(agent1, "/api/calls"), ctx()));
    expect(mine.status).toBe(200);
    expect(ids(mine.body)).toEqual([a1Answered, a1Missed, a1Inbound].sort());
    // Asking for another agent's calls by id returns nothing (not their calls).
    expect((await json(await callsGET(await req(agent1, `/api/calls?userId=${agent2.id}`), ctx()))).body.items).toHaveLength(0);
    const all = await json(await callsGET(await req(A.session, "/api/calls"), ctx()));
    expect(ids(all.body)).toEqual([a1Answered, a1Missed, a1Inbound, a2Call, a2Recorded, liveCall].sort());
    expect(JSON.stringify(all.body)).not.toContain(bCall);
    // B's owner filtering by A's contact / list gets nothing.
    expect((await json(await callsGET(await req(B.session, `/api/calls?contactId=${contactA}`), ctx()))).body.items).toHaveLength(0);
    expect((await json(await callsGET(await req(B.session, `/api/calls?listId=${listA}`), ctx()))).body.items).toHaveLength(0);
  });

  it("filters used by the tabs and links: customer, dial list, report metric, business-local dates", async () => {
    expect(ids((await json(await callsGET(await req(A.session, `/api/calls?contactId=${contactA}`), ctx()))).body)).toEqual([a1Answered, a1Missed].sort());
    expect(ids((await json(await callsGET(await req(A.session, `/api/calls?listId=${listA}`), ctx()))).body)).toEqual([a1Answered]);
    // metric=outbound: outbound calls placed at the provider (agent leg) – the inbound call and the leg-less call are out.
    expect(ids((await json(await callsGET(await req(A.session, "/api/calls?metric=outbound"), ctx()))).body)).toEqual([a1Answered, a1Missed, a2Call, liveCall].sort());
    expect(ids((await json(await callsGET(await req(A.session, "/api/calls?metric=answered"), ctx()))).body)).toEqual([a1Answered, a2Call, liveCall].sort());
    expect(ids((await json(await callsGET(await req(A.session, "/api/calls?outcome=sale"), ctx()))).body)).toEqual([a1Answered]);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
    expect((await json(await callsGET(await req(A.session, `/api/calls?fromDate=${today}&toDate=${today}`), ctx()))).body.items).toHaveLength(6);
    expect((await json(await callsGET(await req(A.session, "/api/calls?fromDate=2020-01-01&toDate=2020-01-31"), ctx()))).body.items).toHaveLength(0);
    expect((await callsGET(await req(A.session, "/api/calls?fromDate=not-a-date"), ctx())).status).toBe(400);
  });

  it("a report metric opens exactly the calls it counts", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
    const rep = await json(await comparisonGET(await req(A.session, `/api/reports/comparison?from=${today}&to=${today}&compare=none`), ctx()));
    expect(rep.status).toBe(200);
    const metric = (id: string) => rep.body.metrics.find((m: { id: string }) => m.id === id).change.current;
    const hist = async (m: string, extra = "") => (await json(await callsGET(await req(A.session, `/api/calls?metric=${m}&fromDate=${today}&toDate=${today}${extra}`), ctx()))).body.items.length;
    expect(await hist("outbound")).toBe(metric("outbound"));
    expect(await hist("answered")).toBe(metric("answered"));
    const repAgent = await json(await comparisonGET(await req(A.session, `/api/reports/comparison?from=${today}&to=${today}&compare=none&userId=${agent1.id}`), ctx()));
    expect(await hist("answered", `&userId=${agent1.id}`)).toBe(repAgent.body.metrics.find((m: { id: string }) => m.id === "answered").change.current);
  });

  it("call details: own / in-scope only, same business only; recordings need the permission", async () => {
    const own = await json(await callGET(await req(agent1, `/api/calls/${a1Answered}`), ctx({ id: a1Answered })));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: a1Answered, contact: { id: contactA }, list: { id: listA }, outcome: "sale" });
    expect((await callGET(await req(agent1, `/api/calls/${a2Call}`), ctx({ id: a2Call }))).status).toBe(404);
    expect((await callGET(await req(A.session, `/api/calls/${bCall}`), ctx({ id: bCall }))).status).toBe(404);
    // Agent template has no "recordings": the drawer says so and the stream is refused.
    expect((await json(await callGET(await req(agent2, `/api/calls/${a2Recorded}`), ctx({ id: a2Recorded })))).body.canPlayRecording).toBe(false);
    expect((await recordingGET(await req(agent2, `/api/recordings/${a2Recorded}`), ctx({ callId: a2Recorded }))).status).toBe(403);
    expect((await json(await callGET(await req(A.session, `/api/calls/${a2Recorded}`), ctx({ id: a2Recorded })))).body.canPlayRecording).toBe(true);
  });

  it("active calls: managers only, real live calls, listen / whisper only with the explicit permission", async () => {
    expect((await liveGET(await req(agent1, "/api/manager/live"), ctx())).status).toBe(403);
    const m = await json(await liveGET(await req(manager, "/api/manager/live"), ctx()));
    expect(m.status).toBe(200);
    expect(m.body.mayMonitor).toBe(false);
    const row = m.body.rows.find((r: { id: string }) => r.id === agent2.id);
    expect(row.call).toMatchObject({ id: liveCall, canMonitor: false });
    expect(JSON.stringify(m.body)).not.toContain(bCall);
    expect((await monitorPOST(await req(manager, "/api/manager/monitor", "POST", { callId: liveCall }), ctx())).status).toBe(403);
    // The owner has every telephony action, including "monitor".
    const o = await json(await liveGET(await req(A.session, "/api/manager/live"), ctx()));
    expect(o.body.mayMonitor).toBe(true);
    expect(o.body.rows.find((r: { id: string }) => r.id === agent2.id).call.canMonitor).toBe(true);
  });

  it("without the telephony module the history and live feed are closed", async () => {
    await db.business.update({ where: { id: B.business.id }, data: { modules: { crm: true, telephony: false } } }); invalidateEntitlement(B.business.id);
    expect((await callsGET(await req(B.session, "/api/calls"), ctx())).status).toBe(403);
    expect((await callGET(await req(B.session, `/api/calls/${bCall}`), ctx({ id: bCall }))).status).toBe(403);
    expect((await liveGET(await req(B.session, "/api/manager/live"), ctx())).status).toBe(403);
  });
});
