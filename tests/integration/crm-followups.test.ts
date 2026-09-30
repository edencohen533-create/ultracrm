/**
 * CRM ↔ dialer acceptance (real DB, simulated telephony):
 * dial-attempt counter, manager transfer (access + queue + history), follow-ups (mandatory time, never before it,
 * queue entry when due, priority modes, reschedule / dialer off / live call without duplicates),
 * "waiting for a call today" numbers = the lists they open, business + agent isolation.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { attemptStats, attemptHistory, scheduleFollowUp, cancelFollowUp, transferLeads, waitingToday, assertDialAllowed } from "@/lib/crm/lead-ops";
import { listLeads, updateLead } from "@/lib/crm/pipeline";
import { claimNextLead, releaseLead } from "@/lib/dialer/queue";
import { startCall, reconcileCall, saveOutcome } from "@/lib/dialer/calls";
import { saveAgentSettings } from "@/lib/agent-settings";
import { DEFAULT_AGENT_SETTINGS } from "@/lib/agent-settings-schema";
import { zonedParts } from "@/lib/business-day";
import { POST as personalListPOST } from "@/app/api/dialer/personal-list/route";
import { GET as contactGET } from "@/app/api/contacts/[id]/route";

const TZ = "Asia/Jerusalem";
let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let dana: SessionUser, yossi: SessionUser, owner: SessionUser;
const accounts: string[] = [];
const run = <T,>(user: SessionUser, fn: () => Promise<T>) => withBusiness(user.businessId, fn, user);
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const cookieReq = async (user: SessionUser, url: string, method = "GET") => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(user)}`, "Content-Type": "application/json" } });
let seq = 0;
const lead = async (ownerId: string | null, status: "new" | "contacted" | "follow_up" | "qualified" | "lost" = "new", phoneEnd = "5", createdAt?: Date) => {
  seq++;
  const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `ליד ${seq}`, phoneE164: `+97250${String(1000000 + seq * 10).slice(-6)}${phoneEnd}`.slice(0, 13), phoneRaw: "x", ownerUserId: null } });
  return db.lead.create({ data: { businessId: a.business.id, contactId: c.id, status, ownerUserId: ownerId, ...(createdAt ? { createdAt } : {}) } });
};
const later = (minutes: number) => zonedParts(TZ, new Date(Date.now() + minutes * 60_000));
const personalList = async (user: SessionUser) => { const r = await personalListPOST(await cookieReq(user, "/api/dialer/personal-list", "POST"), ctx()); expect(r.status).toBe(200); return (await r.json()).data.id as string; };
const endCall = async (callId: string) => { for (let i = 0; i < 40; i++) { const c = await run(owner, () => reconcileCall(callId)); if (c?.endedAt) return c; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("call did not end"); };

describe("CRM follow-ups, transfer and attempts", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("crm-fu", { modules: { crm: true, telephony: true, messaging: true } });
    b = await createBusiness("crm-fu-other", { modules: { crm: true, telephony: true } });
    accounts.push(a.account.id, b.account.id);
    await db.business.update({ where: { id: a.business.id }, data: { timezone: TZ } });
    owner = a.session;
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent" as const, teamId: null }; };
    dana = await mk("דנה"); yossi = await mk("יוסי");
    await db.phoneNumber.create({ data: { businessId: a.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    for (const u of [dana, yossi]) await run(owner, () => saveAgentSettings(owner, u.id, { ...structuredClone(DEFAULT_AGENT_SETTINGS), strategy: "hot", maxDailyUnanswered: 20 }));
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("a dial attempt counts once: idempotent start, replayed provider events, a failed start is not an attempt", async () => {
    const l = await lead(dana.id, "contacted", "1"); // …1 → busy in the simulation (ends in ~3s)
    const key = crypto.randomUUID();
    const c1 = await run(dana, () => startCall(dana, { idempotencyKey: key, mode: "manual", contactId: l.contactId }));
    const c2 = await run(dana, () => startCall(dana, { idempotencyKey: key, mode: "manual", contactId: l.contactId }));
    expect(c2.id).toBe(c1.id);
    await endCall(c1.id);
    for (let i = 0; i < 3; i++) await run(dana, () => reconcileCall(c1.id)); // provider events re-emitted → de-duplicated
    await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: l.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000000", fromE164: "x", status: "failed", telephonyResult: "failed", endedAt: new Date(), outcomeSavedAt: new Date() } });
    const stats = await run(owner, () => attemptStats(a.business.id, [l.contactId]));
    expect(stats.get(l.id)?.count).toBe(1);
    const hist = await run(dana, () => attemptHistory(dana, l.id));
    expect(hist).toHaveLength(1); expect(hist[0].agent).toBe("דנה");
    await run(dana, () => saveOutcome(dana, { callId: c1.id, outcome: "busy" }));
    const page = await run(owner, () => listLeads(owner, { ownerUserId: dana.id, sort: "createdAt", direction: "desc", page: 1, limit: 50 } as never));
    expect(page.items.find((x) => x.id === l.id)?.attempts).toBe(1);
  });

  it("follow-up needs a date and time; past / outside dial hours are rejected with a valid suggestion", async () => {
    const l = await lead(dana.id, "contacted");
    await expect(run(dana, () => updateLead(dana, l.id, { status: "follow_up" }))).rejects.toMatchObject({ code: "follow_up_time_required" });
    await expect(run(dana, () => scheduleFollowUp(dana, l.id, { date: "2020-01-01", time: "10:00" }))).rejects.toMatchObject({ code: "follow_up_in_past" });
    const biz = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(biz.settings as object), dialWindow: { start: "09:00", end: "18:00", days: [0, 1, 2, 3, 4, 5, 6] } } } });
    const tomorrow = zonedParts(TZ, new Date(Date.now() + 86400_000)).date;
    const err = await run(dana, () => scheduleFollowUp(dana, l.id, { date: tomorrow, time: "22:30" })).catch((e) => e);
    expect(err.code).toBe("outside_dial_window");
    expect(err.details.suggestion.time).toBe("09:00");
    await db.business.update({ where: { id: a.business.id }, data: { settings: biz.settings as object } });
    const r = await run(dana, () => scheduleFollowUp(dana, l.id, { ...later(120), note: "לדבר על המחיר" }));
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("follow_up");
    expect((await db.task.findUniqueOrThrow({ where: { id: r.taskId } })).note).toBe("לדבר על המחיר");
  });

  it("follow-up is never dialed before its time, enters the owner's queue when due (also when scheduled while the dialer was off)", async () => {
    const l = await lead(yossi.id, "contacted");
    const r = await run(yossi, () => scheduleFollowUp(yossi, l.id, later(90))); // yossi has no dialer list yet ("dialer off")
    const listId = await personalList(yossi); // dialer started → follow-up synced as a callback row due at its time
    const row = await db.listLead.findUniqueOrThrow({ where: { listId_contactId: { listId, contactId: l.contactId } } });
    expect(row.status).toBe("callback"); expect(row.nextAttemptAt?.getTime()).toBe(r.dueAt.getTime());
    await db.listLead.updateMany({ where: { listId, NOT: { contactId: l.contactId } }, data: { status: "completed" } });
    expect(await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId))).toBeNull();
    await expect(run(yossi, () => assertDialAllowed(yossi, l.contactId, true))).rejects.toMatchObject({ code: "follow_up_not_due" });
    // time passes: the follow-up is due
    await db.task.update({ where: { id: r.taskId }, data: { dueAt: new Date(Date.now() - 60_000) } });
    await db.listLead.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    const claimed = await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId));
    expect(claimed?.contactId).toBe(l.contactId);
    await run(yossi, () => releaseLead(yossi.id, claimed!.id, "test"));
    await run(yossi, () => cancelFollowUp(yossi, l.id));
  });

  it("priority: follow-ups first (oldest due first) vs new leads first", async () => {
    const listId = await personalList(yossi);
    await db.listLead.updateMany({ where: { listId }, data: { status: "completed" } });
    const n = await lead(yossi.id, "new");
    const f1 = await lead(yossi.id, "contacted"); const f2 = await lead(yossi.id, "contacted");
    const t1 = await run(yossi, () => scheduleFollowUp(yossi, f1.id, later(60)));
    const t2 = await run(yossi, () => scheduleFollowUp(yossi, f2.id, later(60)));
    await personalList(yossi);
    await db.task.update({ where: { id: t1.taskId }, data: { dueAt: new Date(Date.now() - 30 * 60_000) } });
    await db.task.update({ where: { id: t2.taskId }, data: { dueAt: new Date(Date.now() - 60 * 60_000) } });
    await db.listLead.updateMany({ where: { listId, contactId: f1.contactId }, data: { nextAttemptAt: new Date(Date.now() - 30 * 60_000) } });
    await db.listLead.updateMany({ where: { listId, contactId: f2.contactId }, data: { nextAttemptAt: new Date(Date.now() - 60 * 60_000) } });
    const first = await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId));
    expect(first?.contactId).toBe(f2.contactId); // follow-ups first, the oldest due one first
    await run(yossi, () => releaseLead(yossi.id, first!.id, "test"));
    await run(owner, () => saveAgentSettings(owner, yossi.id, { ...structuredClone(DEFAULT_AGENT_SETTINGS), strategy: "new_first", maxDailyUnanswered: 20 }));
    const second = await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId));
    expect(second?.contactId).toBe(n.contactId);
    await run(yossi, () => releaseLead(yossi.id, second!.id, "test"));
    await run(owner, () => saveAgentSettings(owner, yossi.id, { ...structuredClone(DEFAULT_AGENT_SETTINGS), strategy: "hot", maxDailyUnanswered: 20 }));
    for (const x of [f1, f2]) await run(yossi, () => cancelFollowUp(yossi, x.id));
    await db.lead.update({ where: { id: n.id }, data: { status: "lost" } });
  });

  it("reschedule leaves exactly one schedule and moves the queue time", async () => {
    const l = await lead(yossi.id, "contacted");
    await run(yossi, () => scheduleFollowUp(yossi, l.id, later(60)));
    const r2 = await run(yossi, () => scheduleFollowUp(yossi, l.id, later(240)));
    const open = await db.task.findMany({ where: { contactId: l.contactId, status: "open", type: "callback" } });
    expect(open.map((t) => t.id)).toEqual([r2.taskId]);
    const rows = await db.listLead.findMany({ where: { contactId: l.contactId } });
    expect(rows.every((x) => x.nextAttemptAt?.getTime() === r2.dueAt.getTime())).toBe(true);
    await run(yossi, () => cancelFollowUp(yossi, l.id));
  });

  it("transfer: previous agent loses access and queue at once; new agent gets history, notes and the follow-up at the same time", async () => {
    const danaList = await personalList(dana);
    const l = await lead(dana.id, "contacted", "1");
    await personalList(dana);
    await db.note.create({ data: { businessId: a.business.id, contactId: l.contactId, authorId: dana.id, body: "הערה של דנה" } });
    await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: l.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000001", fromE164: "x", status: "ended", leadDialedAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date(), outcome: "no_answer" } });
    const fu = await run(dana, () => scheduleFollowUp(dana, l.id, later(180)));
    const res = await run(owner, () => transferLeads(owner, { leadIds: [l.id], toUserId: yossi.id }));
    expect(res.transferred).toEqual([l.id]);
    // previous agent: no lead, no contact card, no list, no queue row, no dial
    await expect(run(dana, () => attemptHistory(dana, l.id))).rejects.toMatchObject({ status: 404 });
    expect((await contactGET(await cookieReq(dana, `/api/contacts/${l.contactId}`), ctx({ id: l.contactId }))).status).toBe(404);
    const danaLeads = await run(dana, () => listLeads(dana, { sort: "createdAt", direction: "desc", page: 1, limit: 100 } as never));
    expect(danaLeads.items.some((x) => x.id === l.id)).toBe(false);
    expect((await db.listLead.findUniqueOrThrow({ where: { listId_contactId: { listId: danaList, contactId: l.contactId } } })).status).toBe("removed");
    await expect(run(dana, () => assertDialAllowed(dana, l.contactId, false))).rejects.toMatchObject({ code: "lead_not_assigned_to_you" });
    // new agent: same follow-up time, history and notes
    const task = await db.task.findUniqueOrThrow({ where: { id: fu.taskId } });
    expect(task).toMatchObject({ userId: yossi.id, status: "open" }); expect(task.dueAt.getTime()).toBe(fu.dueAt.getTime());
    expect(await run(yossi, () => attemptHistory(yossi, l.id))).toHaveLength(1);
    const card = await (await contactGET(await cookieReq(yossi, `/api/contacts/${l.contactId}`), ctx({ id: l.contactId }))).json();
    expect(card.data.calls.some((c: { user: { fullName: string } }) => c.user.fullName === "דנה")).toBe(true);
    expect(card.data.noteItems.some((n: { body: string }) => n.body === "הערה של דנה")).toBe(true);
    const log = await db.auditLog.findFirstOrThrow({ where: { businessId: a.business.id, entityId: l.id, action: "lead.transferred" } });
    expect(log.payload).toMatchObject({ from: dana.id, to: yossi.id, by: owner.id });
    expect(await db.task.count({ where: { contactId: l.contactId, status: "open" } })).toBe(1);
  });

  it("lead in a live call: transfer waits, nobody can dial in parallel, applied once the call is documented", async () => {
    const l = await lead(dana.id, "contacted", "1");
    const call = await run(dana, () => startCall(dana, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: l.contactId }));
    const res = await run(owner, () => transferLeads(owner, { leadIds: [l.id], toUserId: yossi.id }));
    expect(res.pending).toEqual([l.id]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).ownerUserId).toBe(dana.id);
    await expect(run(yossi, () => startCall(yossi, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: l.contactId }))).rejects.toMatchObject({ status: 409 });
    await endCall(call.id);
    await run(dana, () => saveOutcome(dana, { callId: call.id, outcome: "busy" }));
    const after = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.ownerUserId).toBe(yossi.id); expect(after.pendingTransferToUserId).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: l.id, action: "lead.transferred" } })).toBe(1);
  });

  it("a follow-up that comes due while the agent is in another call: no parallel call, it stays due and is served right after", async () => {
    const listId = await personalList(yossi);
    await db.listLead.updateMany({ where: { listId }, data: { status: "completed" } });
    const busyWith = await lead(yossi.id, "contacted", "1"); // simulated busy → the call ends by itself
    const due = await lead(yossi.id, "contacted", "4");
    const fu = await run(yossi, () => scheduleFollowUp(yossi, due.id, later(20)));
    await personalList(yossi);
    const live = await run(yossi, () => startCall(yossi, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: busyWith.contactId }));
    // …the follow-up's time arrives during the call
    await db.task.update({ where: { id: fu.taskId }, data: { dueAt: new Date(Date.now() - 60_000) } });
    await db.listLead.updateMany({ where: { listId, contactId: due.contactId }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    await expect(run(yossi, () => startCall(yossi, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: due.contactId }))).rejects.toMatchObject({ status: 409 });
    const row = await db.listLead.findUniqueOrThrow({ where: { listId_contactId: { listId, contactId: due.contactId } } });
    expect(row.status).toBe("callback"); // not dropped, not expired, not given to someone else
    expect((await db.task.findUniqueOrThrow({ where: { id: fu.taskId } })).status).toBe("open");
    expect((await db.lead.findUniqueOrThrow({ where: { id: due.id } })).ownerUserId).toBe(yossi.id);
    await endCall(live.id);
    await run(yossi, () => saveOutcome(yossi, { callId: live.id, outcome: "busy" }));
    const next = await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId));
    expect(next?.contactId).toBe(due.contactId); // first in line once the agent is free
    await run(yossi, () => releaseLead(yossi.id, next!.id, "test"));
    await run(yossi, () => cancelFollowUp(yossi, due.id));
  });

  it("after a due follow-up is attempted with no answer it moves to the retry time instead of looping", async () => {
    const listId = await personalList(yossi);
    await db.listLead.updateMany({ where: { listId }, data: { status: "completed" } });
    const l = await lead(yossi.id, "contacted", "1");
    const fu = await run(yossi, () => scheduleFollowUp(yossi, l.id, later(30)));
    await personalList(yossi);
    await db.task.update({ where: { id: fu.taskId }, data: { dueAt: new Date(Date.now() - 60_000) } });
    await db.listLead.updateMany({ where: { listId, contactId: l.contactId }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } });
    const session = await db.dialerSession.create({ data: { businessId: a.business.id, userId: yossi.id, listId, mode: "preview", browserSessionId: "b1" } });
    const claimed = await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId));
    expect(claimed?.contactId).toBe(l.contactId);
    const call = await run(yossi, () => startCall(yossi, { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: session.id, browserSessionId: "b1", leadId: claimed!.id, lockToken: claimed!.lockToken! }));
    await endCall(call.id);
    await run(yossi, () => saveOutcome(yossi, { callId: call.id, outcome: "busy" }));
    const task = await db.task.findUniqueOrThrow({ where: { id: fu.taskId } });
    const row = await db.listLead.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(task.status).toBe("open"); expect(task.dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.status).toBe("callback"); expect(row.nextAttemptAt?.getTime()).toBe(task.dueAt.getTime());
    expect(await run(yossi, () => claimNextLead(a.business.id, yossi.id, listId))).toBeNull(); // not again right away
    await db.dialerSession.update({ where: { id: session.id }, data: { status: "ended" } });
  });

  it("'waiting for a call today' numbers equal the lists they open; closed/DNC excluded, unassigned shown", async () => {
    await db.lead.updateMany({ where: { businessId: a.business.id }, data: { status: "lost" } });
    const n1 = await lead(dana.id, "new"); const n2 = await lead(null, "new");
    const dialed = await lead(dana.id, "new");
    await db.call.create({ data: { businessId: a.business.id, userId: dana.id, contactId: dialed.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000002", fromE164: "x", status: "ended", leadDialedAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date() } });
    const dnc = await lead(dana.id, "new"); const dncContact = await db.contact.findUniqueOrThrow({ where: { id: dnc.contactId } });
    await db.dncEntry.create({ data: { businessId: a.business.id, phoneE164: dncContact.phoneE164 } });
    await lead(dana.id, "lost");
    const today = await lead(dana.id, "contacted"); const over = await lead(yossi.id, "contacted"); const noTime = await lead(dana.id, "follow_up");
    await db.task.create({ data: { businessId: a.business.id, userId: dana.id, contactId: today.contactId, leadId: today.id, type: "callback", dueAt: new Date(Date.now() + 60_000) } });
    await db.task.create({ data: { businessId: a.business.id, userId: yossi.id, contactId: over.contactId, leadId: over.id, type: "callback", dueAt: new Date(Date.now() - 3 * 86400_000) } });
    await db.lead.updateMany({ where: { id: { in: [today.id, over.id] } }, data: { status: "follow_up" } });
    const w = await run(owner, () => waitingToday(owner));
    expect(new Set(w.ids.new)).toEqual(new Set([n1.id, n2.id]));
    expect(w.ids.today).toEqual([today.id]); expect(w.ids.overdue).toEqual([over.id]); expect(w.ids.schedule).toEqual([noTime.id]);
    expect(w.counts).toMatchObject({ total: 4, unassigned: 1 });
    for (const k of ["total", "new", "today", "overdue", "schedule"] as const) {
      const page = await run(owner, () => listLeads(owner, { waiting: k, sort: "createdAt", direction: "desc", page: 1, limit: 100 } as never));
      expect(new Set(page.items.map((x) => x.id))).toEqual(new Set(w.ids[k])); expect(page.total).toBe(w.ids[k].length);
    }
    const onlyDana = await run(owner, () => waitingToday(owner, dana.id));
    expect(onlyDana.counts).toMatchObject({ total: 2, new: 1, today: 1, overdue: 0 });
    // unassigned leads are visible but never auto-dialed before assignment
    await expect(run(dana, () => assertDialAllowed(dana, n2.contactId, true))).rejects.toMatchObject({ code: "lead_not_assigned_to_you" });
  });

  it("isolation: agents cannot transfer or see others' leads; another business sees nothing", async () => {
    const l = await lead(dana.id, "contacted");
    await expect(run(yossi, () => transferLeads(yossi, { leadIds: [l.id], toUserId: yossi.id }))).rejects.toMatchObject({ status: 403 });
    await expect(run(yossi, () => attemptHistory(yossi, l.id))).rejects.toMatchObject({ status: 404 });
    const bOwner = b.session;
    const r = await run(bOwner, () => transferLeads(bOwner, { leadIds: [l.id], toUserId: b.user.id }));
    expect(r.notFound).toEqual([l.id]);
    await expect(run(bOwner, () => transferLeads(bOwner, { leadIds: [l.id], toUserId: dana.id }))).rejects.toMatchObject({ code: "invalid_agent" });
    await expect(run(bOwner, () => attemptHistory(bOwner, l.id))).rejects.toMatchObject({ status: 404 });
    expect((await run(bOwner, () => waitingToday(bOwner))).counts.total).toBe(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).ownerUserId).toBe(dana.id);
  });
});
