/**
 * Dial-attempt quota + "no leads available" + campaign switching (real DB, simulated telephony – numbers ending in 1
 * are "busy" in the mock, i.e. a real but unanswered dial). Covers: quota → "לא רלוונטי" with reason and out of the
 * queue; technical failures / idempotent retries / replayed provider events never count; answered, follow-up and
 * won leads are never overridden; quota change needs preview + manager approval; exhausted / waiting / blocked are
 * told apart; one manager alert per emptying (only this business); campaigns and counts by permission only;
 * switching never dials, never drops follow-ups and is refused during a call.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { attemptStats } from "@/lib/crm/lead-ops";
import { listLeads } from "@/lib/crm/pipeline";
import { claimNextLead } from "@/lib/dialer/queue";
import { startCall, reconcileCall, saveOutcome } from "@/lib/dialer/calls";
import { startSession } from "@/lib/dialer/session";
import { campaignsFor, EXHAUSTED_REASON, notifyQueueEmpty, queueAvailability } from "@/lib/dialer/exhaustion";
import { POST as nextLeadPOST } from "@/app/api/dialer/next-lead/route";
import { GET as previewGET, POST as applyPOST } from "@/app/api/dialer/exhaustion/route";
import { POST as switchPOST } from "@/app/api/dialer/campaigns/switch/route";
import { GET as listGET } from "@/app/api/lists/[id]/route";
import { PUT as agentsPUT } from "@/app/api/lists/[id]/agents/route";

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, dana: SessionUser, yossi: SessionUser, ownerB: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const req = async (u: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
let seq = 0;
const phone = () => `+97252${String(Date.now() + seq * 7919).slice(-6)}${seq % 10}1`;
const mkLead = async (ownerId: string, status: "new" | "contacted" | "follow_up" | "qualified" = "new") => {
  seq++;
  const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `ליד ${seq}`, phoneE164: phone(), phoneRaw: "x", ownerUserId: ownerId } });
  return db.lead.create({ data: { businessId: a.business.id, contactId: c.id, status, ownerUserId: ownerId } });
};
const mkList = async (name: string, agentIds: string[] = [], extra: Record<string, unknown> = {}) => db.dialList.create({ data: { businessId: a.business.id, name, ...extra, ...(agentIds.length ? { agents: { create: agentIds.map((userId) => ({ userId })) } } : {}) } });
const enqueue = (listId: string, contactId: string) => db.listLead.create({ data: { businessId: a.business.id, listId, contactId } });
const setBiz = async (patch: Record<string, unknown>) => { const x = await db.business.findUniqueOrThrow({ where: { id: a.business.id } }); await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(x.settings as object), ...patch } as object } }); };
const endCall = async (u: SessionUser, callId: string) => { for (let i = 0; i < 40; i++) { const c = await run(u, () => reconcileCall(callId)); if (c?.endedAt) return c; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("call did not end"); };
/** One real, unanswered dial from the campaign queue (time between retries is fast-forwarded). */
const tabs = new Map<string, string>();
/** Like the UI: a preview session on the campaign (a new session supersedes the agent's previous one). */
const session = async (u: SessionUser, listId: string) => { if (!tabs.has(u.id)) tabs.set(u.id, crypto.randomUUID()); const browserSessionId = tabs.get(u.id)!; const s = await run(u, () => startSession(u, { mode: "preview", listId, browserSessionId })); return { sessionId: s.id, browserSessionId }; };
const attempt = async (u: SessionUser, listId: string) => {
  await db.listLead.updateMany({ where: { listId, status: { in: ["pending", "callback"] } }, data: { nextAttemptAt: null } });
  const sess = await session(u, listId);
  const l = await run(u, () => claimNextLead(u.businessId, u.id, listId));
  expect(l).toBeTruthy();
  const c = await run(u, () => startCall(u, { idempotencyKey: crypto.randomUUID(), mode: "preview", leadId: l!.id, lockToken: l!.lockToken!, ...sess }));
  await endCall(u, c.id);
  await run(u, () => saveOutcome(u, { callId: c.id, outcome: "busy" }));
  return c;
};

describe("dialer: attempt quota, empty queue, campaign switch", { timeout: 2_400_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("dial-exh", { modules: { crm: true, telephony: true, messaging: true } });
    b = await createBusiness("dial-exh-b", { modules: { crm: true, telephony: true } });
    accounts.push(a.account.id, b.account.id);
    owner = a.session; ownerB = b.session;
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    dana = await mk("דנה"); yossi = await mk("יוסי");
    await db.phoneNumber.create({ data: { businessId: a.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    await setBiz({ timezone: "Asia/Jerusalem", maxAttempts: 10, unansweredToIrrelevant: 3, dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } });
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("reaching the quota moves an unanswered lead to 'לא רלוונטי' with the reason and out of every queue; the table shows attempts / quota", async () => {
    const list = await mkList("קמפיין מכסה");
    const other = await mkList("קמפיין נוסף");
    const l = await mkLead(dana.id);
    await enqueue(list.id, l.contactId); await enqueue(other.id, l.contactId);
    await attempt(dana, list.id); await attempt(dana, list.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("new");
    const page = await run(owner, () => listLeads(owner, { ownerUserId: dana.id, sort: "createdAt", direction: "desc", page: 1, limit: 50 } as never));
    expect(page.items.find((x) => x.id === l.id)).toMatchObject({ attempts: 2, attemptLimit: 3 });
    await attempt(dana, list.id);
    const after = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after).toMatchObject({ status: "unqualified", closeReason: EXHAUSTED_REASON });
    const rows = await db.listLead.findMany({ where: { contactId: l.contactId } });
    expect(rows.every((r) => r.status === "exhausted")).toBe(true);
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "lead.attempts_exhausted", entityId: l.id } })).toBe(1);
    expect(await db.domainEvent.count({ where: { businessId: a.business.id, type: "lead.status_changed", contactId: l.contactId } })).toBe(1);
  });

  it("only real dials count: same idempotency key twice, replayed provider events and a failed technical start do not add attempts", async () => {
    const list = await mkList("קמפיין ספירה");
    const l = await mkLead(dana.id);
    const row = await enqueue(list.id, l.contactId);
    const sess = await session(dana, list.id);
    const claimed = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id));
    expect(claimed?.id).toBe(row.id);
    const key = crypto.randomUUID();
    const c1 = await run(dana, () => startCall(dana, { idempotencyKey: key, mode: "preview", leadId: row.id, lockToken: claimed!.lockToken!, ...sess }));
    const c2 = await run(dana, () => startCall(dana, { idempotencyKey: key, mode: "preview", leadId: row.id, lockToken: claimed!.lockToken!, ...sess }));
    expect(c2.id).toBe(c1.id);
    await endCall(dana, c1.id);
    for (let i = 0; i < 3; i++) await run(dana, () => reconcileCall(c1.id));
    // technical failure: the lead leg was never dialed (no lead_dialed_at)
    await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: l.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000000", fromE164: "x", status: "failed", telephonyResult: "failed", endedAt: new Date(), outcomeSavedAt: new Date() } });
    await run(dana, () => saveOutcome(dana, { callId: c1.id, outcome: "busy" }));
    expect((await run(owner, () => attemptStats(a.business.id, [l.contactId]))).get(l.id)?.count).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("new");
  });

  it("never overrides an answered lead, an explicit / future follow-up or a won deal; retry spacing is kept", async () => {
    const list = await mkList("קמפיין שמירה");
    // answered once in the past
    const ans = await mkLead(dana.id, "contacted");
    await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: ans.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000001", fromE164: "x", status: "ended", leadDialedAt: new Date(), answeredAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date() } });
    // future follow-up (the lead stays "contacted" but a callback is scheduled for later)
    const fut = await mkLead(dana.id, "contacted");
    await db.task.create({ data: { businessId: a.business.id, userId: dana.id, contactId: fut.contactId, leadId: fut.id, type: "callback", dueAt: new Date(Date.now() + 3 * 86400_000) } });
    // won deal
    const won = await mkLead(dana.id, "contacted");
    await db.deal.create({ data: { businessId: a.business.id, contactId: won.contactId, title: "d", amount: 100, status: "won", stage: "won", ownerUserId: dana.id, closedAt: new Date() } });
    for (const l of [ans, fut, won]) for (let i = 0; i < 3; i++) await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: l.contactId, mode: "power", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000002", fromE164: "x", status: "ended", telephonyResult: "busy", leadDialedAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date() } });
    for (const l of [ans, won]) { await enqueue(list.id, l.contactId); await attempt(dana, list.id); }
    for (const l of [ans, fut, won]) expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status, l.id).toBe("contacted");
    // spacing: after an unanswered attempt the row waits for the retry interval (not re-dialed at once)
    const spacedList = await mkList("קמפיין מרווחים");
    const spaced = await mkLead(dana.id);
    const row = await enqueue(spacedList.id, spaced.contactId);
    await attempt(dana, spacedList.id);
    const r = await db.listLead.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.status).toBe("pending"); expect(r.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    await session(dana, spacedList.id);
    expect(await run(dana, () => claimNextLead(a.business.id, dana.id, spacedList.id))).toBeNull(); // not re-dialed just to use up the quota
  });

  it("changing the quota never closes existing leads by itself: preview, then only a manager's approval moves them", async () => {
    await setBiz({ unansweredToIrrelevant: 0 });
    const l = await mkLead(dana.id);
    for (let i = 0; i < 2; i++) await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: l.contactId, mode: "power", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000003", fromE164: "x", status: "ended", telephonyResult: "no_answer", leadDialedAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date() } });
    await setBiz({ unansweredToIrrelevant: 2 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("new");
    expect((await previewGET(await req(dana, "/api/dialer/exhaustion"), ctx())).status).toBe(403);
    const p = (await (await previewGET(await req(owner, "/api/dialer/exhaustion"), ctx())).json()).data;
    expect(p.leadIds).toContain(l.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("new");
    const r = (await (await applyPOST(await req(owner, "/api/dialer/exhaustion", "POST", { leadIds: [l.id] }), ctx())).json()).data;
    expect(r.moved).toBe(1);
    expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "unqualified", closeReason: EXHAUSTED_REASON });
    await setBiz({ unansweredToIrrelevant: 3 });
  });

  it("availability tells exhausted, waiting (with the next time) and blocked apart – with the same rules as the claim", async () => {
    const list = await mkList("קמפיין מצבים");
    expect(await run(dana, () => queueAvailability(dana, list.id))).toMatchObject({ state: "exhausted", availableNow: 0 });
    const l = await mkLead(dana.id);
    const row = await enqueue(list.id, l.contactId);
    expect(await run(dana, () => queueAvailability(dana, list.id))).toMatchObject({ state: "available", availableNow: 1 });
    // yossi's lead is not dialable (nor counted) for dana
    const y = await mkLead(yossi.id); await enqueue(list.id, y.contactId);
    expect((await run(dana, () => queueAvailability(dana, list.id))).availableNow).toBe(1);
    const next = new Date(Date.now() + 2 * 3600_000);
    await db.listLead.update({ where: { id: row.id }, data: { nextAttemptAt: next } });
    const w = await run(dana, () => queueAvailability(dana, list.id));
    expect(w.state).toBe("waiting"); expect(Math.abs(new Date(w.nextAt!).getTime() - next.getTime())).toBeLessThan(2000);
    await session(dana, list.id);
    expect(await run(dana, () => claimNextLead(a.business.id, dana.id, list.id))).toBeNull();
    await db.dialList.update({ where: { id: list.id }, data: { isPaused: true } });
    const bl = await run(dana, () => queueAvailability(dana, list.id));
    expect(bl.state).toBe("blocked"); expect(bl.reason).toMatch(/מושהית/);
    await db.dialList.update({ where: { id: list.id }, data: { isPaused: false } });
    const closed = await mkList("קמפיין של יוסי", [yossi.id]);
    expect((await run(dana, () => queueAvailability(dana, closed.id))).state).toBe("blocked");
  });

  it("one manager alert per emptying (deduped across refreshes), a new one only after work came back; only this business's managers", async () => {
    const list = await mkList("קמפיין התראות");
    const l = await mkLead(dana.id); await enqueue(list.id, l.contactId);
    const { sessionId, browserSessionId } = await session(dana, list.id);
    const s = { id: sessionId };
    const next = async () => (await (await nextLeadPOST(await req(dana, "/api/dialer/next-lead", "POST", { sessionId: s.id, browserSessionId }), ctx())).json()).data;
    const got = await next(); expect(got?.id).toBeTruthy();
    await db.listLead.update({ where: { id: got.id }, data: { status: "completed", lockedByUserId: null, lockToken: null } });
    for (let i = 0; i < 3; i++) expect(await next()).toBeNull();
    const alerts = await db.dialerQueueAlert.findMany({ where: { businessId: a.business.id, listId: list.id, userId: dana.id } });
    expect(alerts).toHaveLength(1); expect(alerts[0]).toMatchObject({ state: "exhausted", closedAt: null });
    expect(await db.domainEvent.count({ where: { businessId: a.business.id, type: "dialer.queue_empty" } })).toBe(1);
    // an owner linked on WhatsApp (mock provider, open window → no real send) + another business's owner link
    await db.assistantLink.create({ data: { businessId: a.business.id, userId: owner.id, phoneE164: "+972541234567", status: "active", scope: "business", lastInboundAt: new Date(), createdById: owner.id } });
    await db.assistantLink.create({ data: { businessId: b.business.id, userId: ownerB.id, phoneE164: "+972541234568", status: "active", scope: "business", lastInboundAt: new Date(), createdById: ownerB.id } });
    await run(owner, () => notifyQueueEmpty(a.business.id, alerts[0].id));
    const done = await db.dialerQueueAlert.findUniqueOrThrow({ where: { id: alerts[0].id } });
    expect(done.notifiedAt).toBeTruthy();
    const to = (done.delivery as Array<{ to: string; channel: string }>).map((d) => d.to);
    expect(to).toContain(owner.id); expect(to).not.toContain(ownerB.id);
    expect(await db.assistantDelivery.count({ where: { businessId: b.business.id, kind: "queue_empty" } })).toBe(0);
    // notifying again (event retried) sends nothing new
    await run(owner, () => notifyQueueEmpty(a.business.id, alerts[0].id));
    expect(await db.assistantDelivery.count({ where: { businessId: a.business.id, kind: "queue_empty" } })).toBeLessThanOrEqual(1);
    // work comes back → claimed → alert closed; empty again → a second alert
    const l2 = await mkLead(dana.id); await enqueue(list.id, l2.contactId);
    const got2 = await next(); expect(got2?.id).toBeTruthy();
    expect((await db.dialerQueueAlert.findUniqueOrThrow({ where: { id: alerts[0].id } })).closedAt).toBeTruthy();
    await db.listLead.update({ where: { id: got2.id }, data: { status: "completed", lockedByUserId: null, lockToken: null } });
    expect(await next()).toBeNull(); expect(await next()).toBeNull();
    expect(await db.dialerQueueAlert.count({ where: { businessId: a.business.id, listId: list.id, userId: dana.id } })).toBe(2);
    await db.dialerSession.updateMany({ where: { id: s.id }, data: { status: "ended", endedAt: new Date() } });
  });

  it("campaigns and counts follow the campaign permission; opening / switching re-checks it on the server", async () => {
    const mine = await mkList("פתוח לדנה", [dana.id]);
    const all = await mkList("פתוח לכולם");
    const hers = await mkList("פתוח ליוסי", [yossi.id]);
    const personalY = await mkList(`הלידים של יוסי`, [yossi.id], { isDynamic: true, filterJson: { leadOwnerUserId: yossi.id } });
    const dl = await mkLead(dana.id); await enqueue(all.id, dl.contactId);
    const yl = await mkLead(yossi.id); await enqueue(all.id, yl.contactId); await enqueue(hers.id, yl.contactId);
    const list = await run(dana, () => campaignsFor(dana));
    const ids = list.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, all.id])); expect(ids).not.toContain(hers.id); expect(ids).not.toContain(personalY.id);
    expect(list.find((c) => c.id === all.id)?.availableNow).toBe(1); // yossi's lead in the shared campaign is not counted for dana
    expect(list[0].availableNow).toBeGreaterThanOrEqual(list[list.length - 1].availableNow); // available first
    expect((await listGET(await req(dana, `/api/lists/${hers.id}`), ctx({ id: hers.id }))).status).toBe(404);
    expect((await listGET(await req(dana, `/api/lists/${personalY.id}`), ctx({ id: personalY.id }))).status).toBe(404);
    expect((await switchPOST(await req(dana, "/api/dialer/campaigns/switch", "POST", { listId: hers.id, browserSessionId: "x" }), ctx())).status).toBe(403);
    // "specific agents" with nobody selected must never silently open the campaign to everyone
    expect((await agentsPUT(await req(owner, `/api/lists/${mine.id}/agents`, "PUT", { mode: "selected", agentIds: [] }), ctx({ id: mine.id }))).status).toBe(400);
    expect((await agentsPUT(await req(owner, `/api/lists/${mine.id}/agents`, "PUT", { mode: "selected", agentIds: [ownerB.id] }), ctx({ id: mine.id }))).status).toBe(400);
    // permission revoked after the list was shown → switching is refused
    await agentsPUT(await req(owner, `/api/lists/${mine.id}/agents`, "PUT", { mode: "selected", agentIds: [yossi.id] }), ctx({ id: mine.id }));
    expect((await switchPOST(await req(dana, "/api/dialer/campaigns/switch", "POST", { listId: mine.id, browserSessionId: "x" }), ctx())).status).toBe(403);
  });

  it("switching campaign: refused during a call, never dials, keeps follow-ups, and ends only the current session", async () => {
    const from = await mkList("קמפיין מקור"); const to = await mkList("קמפיין יעד");
    const l = await mkLead(dana.id); const row = await enqueue(from.id, l.contactId);
    const fu = await mkLead(dana.id, "follow_up");
    const task = await db.task.create({ data: { businessId: a.business.id, userId: dana.id, contactId: fu.contactId, leadId: fu.id, type: "callback", dueAt: new Date(Date.now() + 3600_000) } });
    const { sessionId, browserSessionId } = await session(dana, from.id);
    const s = { id: sessionId };
    const claimed = await run(dana, () => claimNextLead(a.business.id, dana.id, from.id));
    expect(claimed?.id).toBe(row.id);
    const call = await run(dana, () => startCall(dana, { idempotencyKey: crypto.randomUUID(), mode: "preview", leadId: row.id, lockToken: claimed!.lockToken!, sessionId: s.id, browserSessionId }));
    const during = await switchPOST(await req(dana, "/api/dialer/campaigns/switch", "POST", { listId: to.id, browserSessionId }), ctx());
    expect(during.status).toBe(409);
    await endCall(dana, call.id);
    expect((await switchPOST(await req(dana, "/api/dialer/campaigns/switch", "POST", { listId: to.id, browserSessionId }), ctx())).status).toBe(409); // outcome first
    await run(dana, () => saveOutcome(dana, { callId: call.id, outcome: "busy" }));
    const callsBefore = await db.call.count({ where: { businessId: a.business.id, userId: dana.id } });
    const ok = await switchPOST(await req(dana, "/api/dialer/campaigns/switch", "POST", { listId: to.id, browserSessionId }), ctx());
    expect(ok.status).toBe(200);
    expect(await db.call.count({ where: { businessId: a.business.id, userId: dana.id } })).toBe(callsBefore); // no dial
    expect((await db.dialerSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ended");
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "open", dueAt: task.dueAt });
    expect((await db.lead.findUniqueOrThrow({ where: { id: fu.id } })).status).toBe("follow_up");
    expect((await db.listLead.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("pending"); // previous campaign's row intact
  });
});
