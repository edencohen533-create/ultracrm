/**
 * CRM statuses = the dialer's wrap-up choices (real DB, simulated telephony – nobody is called):
 *  • add / rename a status → the same ids everywhere; structure changes are owner-only (server); isolated per business;
 *  • a status that was hidden stays inactive (not offered) until reactivated explicitly;
 *  • delete with dependencies: refused without a replacement, only a replacement of the same meaning, leads and the
 *    automation move, history written, calls keep a valid reference;
 *  • wrap-up with a RENAMED custom follow-up status: detected by meaning, time in the business time zone (future,
 *    inside dialing hours), one task + the queue callback + the lead status – no duplicates;
 *  • the follow-up is dialed when due by an available agent; not while the agent is in a call; stays open + overdue
 *    while the agent is away; moves with the lead when it is transferred before dialing;
 *  • a technical result (no answer) does not change the CRM status; a custom "sale" status converts with a won deal.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { zonedParts } from "@/lib/business-day";
import { createStatus, deleteStatus, deletionImpact, listStatuses, resolveStatus, updateStatuses } from "@/lib/crm/statuses";
import { saveOutcome } from "@/lib/dialer/calls";
import { claimNextLead } from "@/lib/dialer/queue";
import { followUpsFor, transferLeads } from "@/lib/crm/lead-ops";
import { updateLead } from "@/lib/crm/pipeline";
import { processDomainEvents } from "@/lib/events";
import { POST as statusesPOST } from "@/app/api/lead-statuses/route";

const TZ = "Asia/Jerusalem";
type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let dana: SessionUser, yossi: SessionUser, manager: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let seq = 0;
const newLead = async (biz: Biz, ownerId: string | null, status: "new" | "contacted" | "follow_up" = "contacted") => {
  seq++; const p = `+97252${String(3000000 + seq * 7 + (Date.now() % 1000)).slice(-7)}`;
  const c = await db.contact.create({ data: { businessId: biz.business.id, fullName: `ליד ${seq}`, phoneE164: p, phoneRaw: p, ownerUserId: ownerId } });
  return db.lead.create({ data: { businessId: biz.business.id, contactId: c.id, status, ownerUserId: ownerId } });
};
/** An answered call that already ended (as the provider would report it) – ready for wrap-up. */
const endedCall = (u: SessionUser, contactId: string, leadId: string | null = null, listId: string | null = null, answered = true) => db.call.create({ data: {
  businessId: u.businessId, userId: u.id, contactId, leadId, listId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000000", fromE164: "+97230000000",
  status: "ended", leadDialedAt: new Date(), answeredAt: answered ? new Date() : null, endedAt: new Date(), telephonyResult: answered ? "answered" : "no_answer", talkSeconds: answered ? 30 : 0,
} as never });
const inMinutes = (m: number) => { const z = zonedParts(TZ, new Date(Date.now() + m * 60_000)); return { date: z.date, time: z.time }; };
const always = { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6], timezone: TZ };

describe("CRM statuses as the wrap-up source of truth", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("status-a", { modules: { crm: true, telephony: true } });
    B = await createBusiness("status-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    await db.business.update({ where: { id: A.business.id }, data: { timezone: TZ, settings: { dialWindow: always } } });
    const mk = async (name: string, role: "agent" | "manager") => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser; };
    dana = await mk("דנה", "agent"); yossi = await mk("יוסי", "agent"); manager = await mk("מנהלת", "manager");
  }, 300_000);
  afterAll(async () => { for (const b of [A, B]) if (b) { await db.task.deleteMany({ where: { businessId: b.business.id } }); await db.call.deleteMany({ where: { businessId: b.business.id } }); await db.lead.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("add + rename: owner only (server), stable ids, isolated per business", async () => {
    const sys = await run(A.session, () => listStatuses(A.business.id));
    expect(sys.filter((s) => s.isSystem)).toHaveLength(7);
    // Manager (API) and agent are refused – structure is the owner's.
    const res = await run(manager, async () => statusesPOST(new NextRequest("http://localhost/api/lead-statuses", { method: "POST", body: JSON.stringify({ label: "x", kind: "qualified" }), headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(manager)}` } }), { params: Promise.resolve({}) }));
    expect(res.status).toBe(403);
    await expect(run(dana, () => createStatus(dana, { label: "y", kind: "qualified" }))).rejects.toMatchObject({ code: "owner_only" });
    const fu = await run(A.session, () => createStatus(A.session, { label: "לחזור אחרי החגים", kind: "follow_up" }));
    const renamed = await run(A.session, () => updateStatuses(A.session, { items: [{ id: fu.id, label: "חזרה אחרי חג" }] }));
    expect(renamed.find((s) => s.id === fu.id)?.label).toBe("חזרה אחרי חג");
    // Another business can't see or use it.
    expect((await run(B.session, () => listStatuses(B.business.id))).some((s) => s.id === fu.id)).toBe(false);
    await expect(run(B.session, () => resolveStatus(B.business.id, { statusId: fu.id }))).rejects.toMatchObject({ code: "invalid_status" });
  });

  it("a status that was hidden stays inactive (not offered) until reactivated explicitly", async () => {
    const qualified = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.isSystem && s.kind === "qualified")!;
    await db.leadStatusDef.update({ where: { id: qualified.id }, data: { active: false } }); // what the migration does for "hidden"
    await expect(run(A.session, () => resolveStatus(A.business.id, { statusId: qualified.id }))).rejects.toMatchObject({ code: "status_inactive" });
    await expect(run(A.session, () => updateStatuses(A.session, { items: [{ id: qualified.id, label: qualified.label, active: false }] }))).resolves.toBeTruthy();
    expect((await db.leadStatusDef.findUniqueOrThrow({ where: { id: qualified.id } })).active).toBe(false);
    await run(A.session, () => updateStatuses(A.session, { items: [{ id: qualified.id, label: qualified.label, active: true }] }));
    expect((await db.leadStatusDef.findUniqueOrThrow({ where: { id: qualified.id } })).active).toBe(true);
  });

  it("delete with dependencies: replacement required and of the same meaning; leads + automation move; history kept", async () => {
    const hot = await run(A.session, () => createStatus(A.session, { label: "חם מאוד", kind: "qualified" }));
    const warm = await run(A.session, () => createStatus(A.session, { label: "חמים", kind: "qualified" }));
    const l = await newLead(A, dana.id);
    await run(A.session, () => updateLead(A.session, l.id, { statusId: hot.id }));
    expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "qualified", statusDefId: hot.id });
    const call = await endedCall(dana, l.contactId); await db.call.update({ where: { id: call.id }, data: { statusDefId: hot.id } });
    const seq1 = await db.marketingSequence.create({ data: { businessId: A.business.id, name: "הודעה לחם", trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: hot.id }, isActive: false } as never });
    const impact = await run(A.session, () => deletionImpact(A.business.id, hot.id));
    expect(impact).toMatchObject({ leads: 1, needsReplacement: true });
    expect(impact.automations.map((x) => x.id)).toEqual([seq1.id]);
    await expect(run(A.session, () => deleteStatus(A.session, hot.id, {}))).rejects.toMatchObject({ code: "replacement_required" });
    const lostDef = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.kind === "lost")!;
    await expect(run(A.session, () => deleteStatus(A.session, hot.id, { replacementId: lostDef.id }))).rejects.toMatchObject({ code: "invalid_replacement" });
    // The only status of a meaning (here: the system "lost") can't go – the system relies on one per meaning.
    await expect(run(A.session, () => deleteStatus(A.session, lostDef.id, {}))).rejects.toMatchObject({ code: "only_of_kind" });
    const r = await run(A.session, () => deleteStatus(A.session, hot.id, { replacementId: warm.id }));
    expect(r).toMatchObject({ leadsMoved: 1, automationsMoved: 1 });
    expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "qualified", statusDefId: warm.id });
    expect(((await db.marketingSequence.findUniqueOrThrow({ where: { id: seq1.id } })).triggerConfig as { leadStatus: string }).leadStatus).toBe(warm.id);
    expect(await db.auditLog.count({ where: { entityId: l.id, action: "lead.status_replaced" } })).toBe(1);
    // Soft-deleted: gone from the list, the old call still points at a real row with its name.
    expect((await run(A.session, () => listStatuses(A.business.id))).some((s) => s.id === hot.id)).toBe(false);
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id }, include: { statusDef: true } })).statusDef?.label).toBe("חם מאוד");
  });

  it("wrap-up with a renamed custom follow-up status: by meaning, business time, one task + queue + lead status", async () => {
    const fu = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.label === "חזרה אחרי חג")!;
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "קמפיין" } });
    const l = await newLead(A, dana.id);
    const row = await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: l.contactId } });
    // An older future follow-up exists – the new one replaces it (no duplicate tasks).
    await db.task.create({ data: { businessId: A.business.id, userId: dana.id, contactId: l.contactId, leadId: l.id, type: "callback", dueAt: new Date(Date.now() + 5 * 86400_000) } });
    const call = await endedCall(dana, l.contactId, row.id, list.id);
    // Missing time → refused; outside the business's hours → refused with the rule.
    await expect(run(dana, () => saveOutcome(dana, { callId: call.id, statusId: fu.id }))).rejects.toMatchObject({ code: "callback_time_required" });
    await db.business.update({ where: { id: A.business.id }, data: { settings: { dialWindow: { start: "09:00", end: "10:00", days: [], timezone: TZ } } } });
    await expect(run(dana, () => saveOutcome(dana, { callId: call.id, statusId: fu.id, followUp: inMinutes(90) }))).rejects.toMatchObject({ code: "outside_dial_window" });
    await db.business.update({ where: { id: A.business.id }, data: { settings: { dialWindow: always } } });
    const when = inMinutes(90);
    const saved = await run(dana, () => saveOutcome(dana, { callId: call.id, statusId: fu.id, followUp: when }));
    expect(saved).toMatchObject({ outcome: "callback", statusDefId: fu.id });
    // Saving again (double click / retry) changes nothing.
    await run(dana, () => saveOutcome(dana, { callId: call.id, statusId: fu.id, followUp: when }));
    const tasks = await db.task.findMany({ where: { contactId: l.contactId, status: "open", type: "callback" } });
    expect(tasks).toHaveLength(1);
    expect(zonedParts(TZ, tasks[0].dueAt)).toMatchObject(when);
    expect(tasks[0].userId).toBe(dana.id);
    expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "follow_up", statusDefId: fu.id });
    const q = await db.listLead.findUniqueOrThrow({ where: { id: row.id } });
    expect(q.status).toBe("callback"); expect(q.nextAttemptAt?.getTime()).toBe(tasks[0].dueAt.getTime()); expect(q.preferredUserId).toBe(dana.id);
    // Not dialable before its time.
    expect(await run(dana, () => claimNextLead(A.business.id, dana.id, list.id))).toBeNull();

    // Agent away: the time passes, nobody dials → the follow-up stays open and shows as overdue (never marked done).
    await db.task.update({ where: { id: tasks[0].id }, data: { dueAt: new Date(Date.now() - 10 * 60_000) } });
    await db.listLead.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 10 * 60_000) } });
    const fuInfo = (await run(dana, () => followUpsFor(A.business.id, [{ id: l.id, contactId: l.contactId }]))).get(l.id);
    expect(fuInfo).toBeTruthy();
    expect((await db.task.findUniqueOrThrow({ where: { id: tasks[0].id } })).status).toBe("open");

    // Agent in a call (holding another lead): the follow-up isn't started on top of it.
    const other = await newLead(A, dana.id);
    const busyRow = await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: other.contactId, status: "locked", lockedByUserId: dana.id, lockToken: "t", lockExpiresAt: new Date(Date.now() + 60_000) } });
    const whileBusy = await run(dana, () => claimNextLead(A.business.id, dana.id, list.id));
    expect(whileBusy?.id).toBe(busyRow.id);
    await db.listLead.update({ where: { id: busyRow.id }, data: { status: "completed", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });

    // Agent free (dialer running): the due follow-up is the next lead.
    const next = await run(dana, () => claimNextLead(A.business.id, dana.id, list.id));
    expect(next?.contactId).toBe(l.contactId);
  });

  it("transfer before dialing: the follow-up (task + queue preference) moves to the new agent", async () => {
    const fu = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.isSystem && s.kind === "follow_up")!;
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "העברה" } });
    const l = await newLead(A, dana.id);
    const row = await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: l.contactId } });
    const call = await endedCall(dana, l.contactId, row.id, list.id);
    await run(dana, () => saveOutcome(dana, { callId: call.id, statusId: fu.id, followUp: inMinutes(120) }));
    await run(A.session, () => transferLeads(A.session, { leadIds: [l.id], toUserId: yossi.id }));
    const task = await db.task.findFirstOrThrow({ where: { contactId: l.contactId, status: "open", type: "callback" } });
    expect(task.userId).toBe(yossi.id);
    expect((await db.listLead.findUniqueOrThrow({ where: { id: row.id } })).preferredUserId).toBe(yossi.id);
    expect(await db.task.count({ where: { contactId: l.contactId, status: "open", type: "callback" } })).toBe(1);
  });

  it("a technical result keeps the CRM status; a custom 'sale' status converts with a won deal", async () => {
    const l1 = await newLead(A, dana.id, "contacted");
    const c1 = await endedCall(dana, l1.contactId, null, null, false);
    await run(dana, () => saveOutcome(dana, { callId: c1.id, outcome: "no_answer" }));
    expect(await db.lead.findUniqueOrThrow({ where: { id: l1.id } })).toMatchObject({ status: "contacted", statusDefId: null });

    const sold = await run(A.session, () => createStatus(A.session, { label: "נסגר בטלפון", kind: "converted" }));
    const l2 = await newLead(A, dana.id, "contacted");
    const c2 = await endedCall(dana, l2.contactId);
    await run(dana, () => saveOutcome(dana, { callId: c2.id, statusId: sold.id }));
    for (let i = 0; i < 3; i++) await processDomainEvents({ businessId: A.business.id });
    const after = await db.lead.findUniqueOrThrow({ where: { id: l2.id } });
    expect(after).toMatchObject({ status: "converted", statusDefId: sold.id });
    expect(after.dealId).toBeTruthy();
    expect((await db.deal.findUniqueOrThrow({ where: { id: after.dealId! } })).status).toBe("won");
    // "new" is not a wrap-up choice.
    const newDef = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.kind === "new")!;
    const c3 = await endedCall(dana, (await newLead(A, dana.id)).contactId);
    await expect(run(dana, () => saveOutcome(dana, { callId: c3.id, statusId: newDef.id }))).rejects.toMatchObject({ code: "status_not_for_wrap_up" });
  });
});
