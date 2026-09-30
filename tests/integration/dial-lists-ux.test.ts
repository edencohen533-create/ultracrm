/**
 * Dial lists (real DB, simulated telephony – nobody is called):
 *  • a list has no dialing window of its own: an old list window no longer blocks, the business's hours still do
 *    (and the stats say so: dueNow 0, outsideDialWindow, businessHours with the next opening);
 *  • business-wide pause stops dialing and is reported in the stats;
 *  • priority is 1–10 on the server (0 / 11 refused), new lists default to 5, a list window sent by an old client is
 *    not stored;
 *  • active / inactive through the API: agents refused (server), another business's list unreachable, deactivation
 *    keeps a live call and stops new leads, activation starts no call;
 *  • "בתור" vs "ממתינים": exactly what each counts (future retry, due callback, locked, completed);
 *  • "שיחות" on the dialer: all of the agent's calls today – outbound and inbound, new and existing customers.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { POST as listsPOST } from "@/app/api/lists/route";
import { PATCH as listPATCH } from "@/app/api/lists/[id]/route";
import { GET as perfGET } from "@/app/api/dialer/my-performance/route";
import { claimNextLead, listQueueStats } from "@/lib/dialer/queue";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let agent: SessionUser;
const accounts: string[] = [];
const ALWAYS = { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] };
const req = async (u: SessionUser, url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(u)}` } });
const call = async (u: SessionUser, fn: (r: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, url: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
  withBusiness(u.businessId, async () => { const res = await fn(await req(u, url, method, body), { params: Promise.resolve(params) }); return { status: res.status, body: await res.json() }; }, u);
let seq = 0;
const contact = (biz: Biz) => { seq++; const p = `+97254${String(1000000 + (Date.now() % 100000) * 10 + seq).slice(-7)}`; return db.contact.create({ data: { businessId: biz.business.id, fullName: `ליד ${seq}`, phoneE164: p, phoneRaw: p } }); };
const setHours = (biz: Biz, extra: Record<string, unknown>) => db.business.update({ where: { id: biz.business.id }, data: { settings: { dialWindow: ALWAYS, ...extra } } });

describe("dial lists: hours, priority, active switch, counters, calls", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("lists-ux-a", { modules: { crm: true, telephony: true } });
    B = await createBusiness("lists-ux-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "נציג", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "נציג", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "נציג", role: "agent", teamId: null };
  }, 300_000);
  afterAll(async () => { for (const b of [A, B]) if (b) { await db.call.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("a list's own window no longer blocks; the business's hours and pause still do, and the stats explain it", async () => {
    // An old list with a closed window (e.g. only 00:00–00:01 on no day) – ignored now.
    const l = await db.dialList.create({ data: { businessId: A.business.id, name: "ישנה עם חלון", dialWindowJson: { start: "00:00", end: "00:01", days: [] } } });
    const c = await contact(A);
    await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c.id } });
    const claimed = await withBusiness(A.business.id, () => claimNextLead(A.business.id, A.user.id, l.id), A.session);
    expect(claimed?.contactId).toBe(c.id);
    await db.listLead.updateMany({ where: { listId: l.id }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });

    // Business hours closed (no day) → blocked, with the business reason and the next opening in the stats.
    await setHours(A, { dialWindow: { start: "09:00", end: "10:00", days: [] } });
    await expect(withBusiness(A.business.id, () => claimNextLead(A.business.id, A.user.id, l.id), A.session)).rejects.toMatchObject({ code: "outside_dial_window", message: "מחוץ לשעות החיוג של העסק" });
    let s = await listQueueStats(l.id);
    expect(s.dueNow).toBe(0);
    expect(s.unavailable.outsideDialWindow).toBe(true);
    expect(s.businessHours).toMatchObject({ start: "09:00", end: "10:00", days: [] });

    // Business-wide pause → blocked and reported.
    await setHours(A, { dialingPaused: true });
    await expect(withBusiness(A.business.id, () => claimNextLead(A.business.id, A.user.id, l.id), A.session)).rejects.toMatchObject({ code: "dialing_paused" });
    s = await listQueueStats(l.id);
    expect(s.unavailable.businessPaused).toBe(true);
    expect(s.dueNow).toBe(0);
    await setHours(A, {});
    expect((await listQueueStats(l.id)).dueNow).toBe(1);
  });

  it("priority is 1–10 on the server, new lists default to 5, a window from an old client is not stored", async () => {
    for (const p of [0, 11]) expect((await call(A.session, listsPOST, "/api/lists", "POST", { name: `bad ${p}`, priority: p })).status).toBe(400);
    const made = await call(A.session, listsPOST, "/api/lists", "POST", { name: "ברירת מחדל", dialWindow: { start: "09:00", end: "10:00", days: [1] } });
    expect(made.status).toBe(201);
    const row = await db.dialList.findUniqueOrThrow({ where: { id: made.body.data.id } });
    expect(row.priority).toBe(5);
    expect(row.dialWindowJson).toBeNull();
    const ten = await call(A.session, listsPOST, "/api/lists", "POST", { name: "גבוהה", priority: 10 });
    expect(ten.body.data.priority).toBe(10);
    expect((await call(A.session, listPATCH, `/api/lists/${row.id}`, "PATCH", { priority: 0 }, { id: row.id })).status).toBe(400);
    expect((await call(A.session, listPATCH, `/api/lists/${row.id}`, "PATCH", { priority: 7 }, { id: row.id })).body.data.priority).toBe(7);
  });

  it("active switch: server-side permission and isolation; deactivation keeps a live call, activation starts nothing", async () => {
    const l = await db.dialList.create({ data: { businessId: A.business.id, name: "מתג" } });
    const [c1, c2] = [await contact(A), await contact(A)];
    const live = await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c1.id, status: "in_call", lockedByUserId: agent.id } });
    await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: c2.id } });
    // An agent can't change it (even calling the API directly); another business can't reach it.
    expect((await call(agent, listPATCH, `/api/lists/${l.id}`, "PATCH", { isActive: false }, { id: l.id })).status).toBe(403);
    expect((await call(B.session, listPATCH, `/api/lists/${l.id}`, "PATCH", { isActive: false }, { id: l.id })).status).toBe(404);
    expect((await db.dialList.findUniqueOrThrow({ where: { id: l.id } })).isActive).toBe(true);

    const off = await call(A.session, listPATCH, `/api/lists/${l.id}`, "PATCH", { isActive: false }, { id: l.id });
    expect(off.status).toBe(200); expect(off.body.data.isActive).toBe(false);
    expect((await db.listLead.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("in_call");
    await expect(withBusiness(A.business.id, () => claimNextLead(A.business.id, agent.id, l.id), agent)).rejects.toMatchObject({ code: "list_inactive" });

    const callsBefore = await db.call.count({ where: { businessId: A.business.id } });
    const on = await call(A.session, listPATCH, `/api/lists/${l.id}`, "PATCH", { isActive: true }, { id: l.id });
    expect(on.body.data.isActive).toBe(true);
    // Activation dials nobody and reserves nothing – work starts only when an agent starts the dialer.
    expect(await db.call.count({ where: { businessId: A.business.id } })).toBe(callsBefore);
    expect(await db.listLead.count({ where: { listId: l.id, status: "locked" } })).toBe(0);
  });

  it("'בתור' vs 'ממתינים' count what the explanations say", async () => {
    const l = await db.dialList.create({ data: { businessId: A.business.id, name: "מונים" } });
    const future = new Date(Date.now() + 3600_000), past = new Date(Date.now() - 60_000);
    const rows: Array<Record<string, unknown>> = [
      { status: "pending" },                                  // due pending → both
      { status: "pending", nextAttemptAt: future },           // retry later → ממתינים only
      { status: "callback", nextAttemptAt: past },            // due callback → בתור only
      { status: "callback", nextAttemptAt: future },          // later callback → neither
      { status: "locked", lockedByUserId: agent.id, lockExpiresAt: future, lockToken: "t" }, // reserved → neither
      { status: "completed" },                                // → neither
    ];
    for (const r of rows) await db.listLead.create({ data: { businessId: A.business.id, listId: l.id, contactId: (await contact(A)).id, ...r } });
    const s = await listQueueStats(l.id);
    expect(s.dueNow).toBe(2);
    expect(s.byStatus.pending).toBe(2);
    expect(s.total).toBe(6);
  });

  it("'שיחות' on the dialer counts all of the agent's calls today – outbound and inbound, new and existing customers", async () => {
    const known = await contact(A), fresh = await contact(A);
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    await db.call.create({ data: { businessId: A.business.id, userId: agent.id, contactId: known.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: known.phoneE164, fromE164: "+97230000000", createdAt: yesterday } as never });
    for (const [c, direction, answered] of [[known, "outbound", true], [fresh, "outbound", false], [known, "inbound", true]] as const) {
      await db.call.create({ data: { businessId: A.business.id, userId: agent.id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+97230000000", direction, answeredAt: answered ? new Date() : null } as never });
    }
    // Another agent's call is not in my numbers.
    await db.call.create({ data: { businessId: A.business.id, userId: A.user.id, contactId: fresh.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: fresh.phoneE164, fromE164: "+97230000000" } as never });
    const r = await call(agent, perfGET, "/api/dialer/my-performance", "GET");
    expect(r.status).toBe(200);
    expect(r.body.data.calls).toMatchObject({ total: 3, outbound: 2, inbound: 1, answered: 2 });
    expect(r.body.data.newCustomerCalls).toBeUndefined();
  });
});
