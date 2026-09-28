/**
 * WhatsApp → dialer priority (real DB, simulated telephony, rule-based intent – no AI key in this run).
 * Acceptance: with the dialer running and several leads waiting, a customer's "אני זמינה עכשיו" makes her the NEXT
 * claim of her owner (after the live call, which is not touched), visible in the dialer state poll. Also: oldest
 * first between customers, idempotent per message, negations / "בעצם לא עכשיו", later times → follow-up (a newer
 * request replaces it), vague → review → agent confirms, DNC / closed → ineligible with a reason, expiry, cleared
 * by a dial attempt, business isolation and signal visibility.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { claimNextLead } from "@/lib/dialer/queue";
import { startCall, reconcileCall, saveOutcome } from "@/lib/dialer/calls";
import { startSession } from "@/lib/dialer/session";
import { emitEvent, waitForEvents } from "@/lib/events";
import { handleInboundAvailability, expireSignals, cancelSignal, confirmSignal, hotSignalsFor } from "@/lib/dialer/availability";
import { GET as stateGET } from "@/app/api/dialer/state/route";

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let dana: SessionUser, yossi: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const sys = <T,>(businessId: string, fn: () => Promise<T>) => withBusiness(businessId, fn);
const req = async (u: SessionUser, url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(u)}` } });
let seq = 0;
const phone = () => `+97254${String(Date.now() + seq * 7919).slice(-6)}${seq % 10}1`;

/** A lead of `owner`, in `listId`, optionally already called once (the dialer is working it) and waiting for a retry. */
async function mkLead(owner: SessionUser, listId: string, opts: { called?: boolean; status?: "new" | "contacted" | "lost" } = {}) {
  seq++;
  const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `לקוחה ${seq}`, phoneE164: phone(), phoneRaw: "x", ownerUserId: owner.id } });
  const lead = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, status: opts.status ?? "new", ownerUserId: owner.id } });
  const row = await db.listLead.create({ data: { businessId: a.business.id, listId, contactId: c.id, ...(opts.called ? { attempts: 1, nextAttemptAt: new Date(Date.now() + 3 * 3600_000) } : {}) } });
  if (opts.called) await db.call.create({ data: { businessId: a.business.id, userId: owner.id, contactId: c.id, mode: "power", provider: "mock", direction: "outbound", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "x", status: "ended", telephonyResult: "no_answer", endedAt: new Date(), outcomeSavedAt: new Date(), createdAt: new Date(Date.now() - 3600_000) } });
  const conv = await db.conversation.create({ data: { businessId: a.business.id, contactId: c.id, channel: "whatsapp", lastInboundAt: new Date() } });
  await db.message.create({ data: { businessId: a.business.id, conversationId: conv.id, direction: "OUTBOUND", type: "TEXT", body: "היי, ניסינו להשיג אותך. מתי תהיי זמינה?", status: "DELIVERED", createdAt: new Date(Date.now() - 30 * 60_000) } });
  return { contact: c, lead, row, conv };
}
/** The customer's WhatsApp reply, through the real outbox → handler path (like the webhook). */
async function reply(convId: string, contactId: string, body: string, at = new Date()) {
  const m = await db.message.create({ data: { businessId: a.business.id, conversationId: convId, direction: "INBOUND", type: "TEXT", body, status: "DELIVERED", createdAt: at } });
  await emitEvent(db, { businessId: a.business.id, type: "message.received", contactId, source: "webhook", occurredAt: at, dedupeKey: `message.received:${m.id}`, payload: { messageId: m.id, conversationId: convId, channel: "whatsapp", type: "TEXT", body } });
  await waitForEvents(a.business.id, 60_000);
  return m;
}
const signalOf = (messageId: string) => db.callbackSignal.findUnique({ where: { messageId } });
const mkList = async (name: string, agentIds: string[]) => db.dialList.create({ data: { businessId: a.business.id, name, agents: { create: agentIds.map((userId) => ({ userId })) } } });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const release = (_listId?: string) => db.listLead.updateMany({ where: { businessId: a.business.id, status: "locked" }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });

describe("WhatsApp availability → head of the dial queue", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY; // deterministic rule-based intent
    a = await createBusiness("wa-prio", { modules: { crm: true, telephony: true, whatsapp: true } });
    b = await createBusiness("wa-prio-b", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(a.account.id, b.account.id);
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    dana = await mk("דנה"); yossi = await mk("יוסי");
    await db.phoneNumber.create({ data: { businessId: a.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    const x = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(x.settings as object), timezone: "Asia/Jerusalem", maxAttempts: 10, availableNowTtlMinutes: 15 } as object } });
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("ACCEPTANCE: dialer running with a live lead + several waiting → 'אני זמינה עכשיו' makes her the very next claim, shown in the state poll", async () => {
    const list = await mkList("קמפיין קבלה", [dana.id]);
    const waiting = [await mkLead(dana, list.id), await mkLead(dana, list.id), await mkLead(dana, list.id)];
    const hot = await mkLead(dana, list.id, { called: true });
    const browserSessionId = crypto.randomUUID();
    await run(dana, () => startSession(dana, { mode: "power", listId: list.id, browserSessionId }));
    // The agent is on a live call with the first waiting lead.
    const live = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id));
    expect(waiting.map((w) => w.row.id)).toContain(live!.id);
    const m = await reply(hot.conv.id, hot.contact.id, "אני זמינה עכשיו");
    const s = await signalOf(m.id);
    expect(s).toMatchObject({ status: "active", intent: "now", userId: dana.id, leadId: hot.lead.id });
    expect(s!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    // The live call is untouched.
    expect(await db.listLead.findUniqueOrThrow({ where: { id: live!.id } })).toMatchObject({ status: "locked", lockedByUserId: dana.id });
    // The state poll the dialer UI reads (every few seconds) already carries it.
    const st = await (await stateGET(await req(dana, `/api/dialer/state?browserSessionId=${browserSessionId}`), { params: Promise.resolve({}) })).json();
    expect(st.data.hot.map((h: { id: string; status: string }) => [h.id, h.status])).toContainEqual([s!.id, "active"]);
    // The live call ends (no answer → retry later) and releases its lock, as saving the outcome does.
    await db.listLead.update({ where: { id: live!.id }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null, attempts: 1, nextAttemptAt: new Date(Date.now() + 3600_000) } });
    // Next claim after the live call = her, ahead of the new leads (her own row was waiting 3h for a retry).
    const next = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id));
    expect(next?.id).toBe(hot.row.id);
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "lead.priority_now", entityId: hot.lead.id } })).toBe(1);
    await release(list.id);
  });

  it("several customers → oldest request first; ahead of due follow-ups; a dial attempt clears the priority", async () => {
    const list = await mkList("קמפיין סדר", [dana.id]);
    const fu = await mkLead(dana, list.id);
    await db.listLead.update({ where: { id: fu.row.id }, data: { status: "callback", nextAttemptAt: new Date(Date.now() - 60_000) } });
    const first = await mkLead(dana, list.id, { called: true }); const second = await mkLead(dana, list.id, { called: true });
    await reply(second.conv.id, second.contact.id, "אפשר עכשיו", new Date(Date.now() - 1000));
    await reply(first.conv.id, first.contact.id, "אני זמין עכשיו", new Date(Date.now() - 5000)); // arrived later, sent earlier
    const browserSessionId = crypto.randomUUID();
    const sess = await run(dana, () => startSession(dana, { mode: "preview", listId: list.id, browserSessionId }));
    const c1 = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id));
    expect(c1?.id).toBe(first.row.id);
    // Dial her: saving the outcome clears the priority and the outcome decides what's next.
    const call = await run(dana, () => startCall(dana, { idempotencyKey: crypto.randomUUID(), mode: "preview", leadId: c1!.id, lockToken: c1!.lockToken!, sessionId: sess.id, browserSessionId }));
    for (let i = 0; i < 40; i++) { const x = await run(dana, () => reconcileCall(call.id)); if (x?.endedAt) break; await new Promise((r) => setTimeout(r, 1000)); }
    await run(dana, () => saveOutcome(dana, { callId: call.id, outcome: "no_answer" }));
    expect((await db.callbackSignal.findFirst({ where: { contactId: first.contact.id } }))?.status).toBe("handled");
    const c2 = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id));
    expect(c2?.id).toBe(second.row.id);
    await release(list.id);
    const c3 = await run(dana, () => claimNextLead(a.business.id, dana.id, list.id)); // follow-up still before new leads
    expect([second.row.id, fu.row.id]).toContain(c3?.id);
    await release(list.id);
  });

  it("idempotent per message; negation never prioritizes; 'בעצם לא עכשיו' cancels an active priority", async () => {
    const list = await mkList("קמפיין שלילה", [dana.id]);
    const x = await mkLead(dana, list.id, { called: true });
    const neg = await reply(x.conv.id, x.contact.id, "אני לא זמינה עכשיו");
    expect((await signalOf(neg.id))?.status).toBe("cancelled");
    expect((await db.listLead.findUniqueOrThrow({ where: { id: x.row.id } })).nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    const yes = await reply(x.conv.id, x.contact.id, "עכשיו אפשר, תתקשרו");
    expect((await signalOf(yes.id))?.status).toBe("active");
    // the same message again (webhook retry / re-run) → nothing new
    expect(await sys(a.business.id, () => handleInboundAvailability(a.business.id, yes.id))).toEqual({ skipped: "duplicate" });
    expect(await db.callbackSignal.count({ where: { contactId: x.contact.id, status: "active" } })).toBe(1);
    await reply(x.conv.id, x.contact.id, "בעצם לא עכשיו");
    expect((await signalOf(yes.id))?.status).toBe("cancelled");
    expect((await run(dana, () => hotSignalsFor(dana))).some((h) => h.contactId === x.contact.id && h.status === "active")).toBe(false);
  });

  it("'בעוד חצי שעה' → follow-up in the business timezone; a newer 'מחר בעשר' replaces it", async () => {
    const list = await mkList("קמפיין מאוחר", [dana.id]);
    const x = await mkLead(dana, list.id, { called: true });
    const at = new Date();
    const m1 = await reply(x.conv.id, x.contact.id, "בעוד חצי שעה", at);
    expect(await signalOf(m1.id)).toMatchObject({ status: "scheduled", intent: "later" });
    let tasks = await db.task.findMany({ where: { contactId: x.contact.id, status: "open", type: "callback" } });
    expect(tasks).toHaveLength(1);
    expect(Math.abs(tasks[0].dueAt.getTime() - (at.getTime() + 30 * 60_000))).toBeLessThan(61_000);
    const m2 = await reply(x.conv.id, x.contact.id, "מחר בעשר");
    expect((await signalOf(m2.id))?.status).toBe("scheduled");
    tasks = await db.task.findMany({ where: { contactId: x.contact.id, status: "open", type: "callback" } });
    expect(tasks).toHaveLength(1);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" }).format(tasks[0].dueAt);
    expect(local).toBe("10:00");
  });

  it("vague time → review without touching the queue; the agent confirms 'now' → head of the queue", async () => {
    const list = await mkList("קמפיין בדיקה", [dana.id]);
    const x = await mkLead(dana, list.id, { called: true });
    const m = await reply(x.conv.id, x.contact.id, "אחר כך");
    const s = await signalOf(m.id);
    expect(s?.status).toBe("needs_review");
    expect((await db.listLead.findUniqueOrThrow({ where: { id: x.row.id } })).nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    await expect(run(yossi, () => confirmSignal(yossi, s!.id, { now: true }))).rejects.toMatchObject({ status: 404 }); // not his lead
    await run(dana, () => confirmSignal(dana, s!.id, { now: true }));
    expect((await signalOf(m.id))?.status).toBe("active");
    expect((await run(dana, () => claimNextLead(a.business.id, dana.id, list.id)))?.id).toBe(x.row.id);
    await release(list.id);
    await run(dana, () => cancelSignal(dana, s!.id));
    expect((await signalOf(m.id))?.status).toBe("cancelled");
  });

  it("never bypasses DNC or a closed lead: ineligible with the reason, queue untouched", async () => {
    const list = await mkList("קמפיין חסום", [dana.id]);
    const dnc = await mkLead(dana, list.id, { called: true });
    await db.dncEntry.create({ data: { businessId: a.business.id, phoneE164: dnc.contact.phoneE164 } });
    const m1 = await reply(dnc.conv.id, dnc.contact.id, "אני זמינה עכשיו");
    expect(await signalOf(m1.id)).toMatchObject({ status: "ineligible", reason: "המספר חסום – לא ליצור קשר" });
    const closed = await mkLead(dana, list.id, { called: true, status: "lost" });
    const m2 = await reply(closed.conv.id, closed.contact.id, "אני זמינה עכשיו");
    expect(await signalOf(m2.id)).toMatchObject({ status: "ineligible", reason: "הליד סגור" });
    expect((await run(dana, () => hotSignalsFor(dana))).filter((h) => h.status === "ineligible").length).toBeGreaterThanOrEqual(2);
  });

  it("expires after the configured time: the priority is removed and the agent sees 'not handled'", async () => {
    const list = await mkList("קמפיין תפוגה", [dana.id]);
    const x = await mkLead(dana, list.id, { called: true });
    const m = await reply(x.conv.id, x.contact.id, "אני פנויה עכשיו");
    await db.callbackSignal.update({ where: { messageId: m.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await sys(a.business.id, () => expireSignals(a.business.id));
    expect(await signalOf(m.id)).toMatchObject({ status: "expired", reason: "הבקשה לא טופלה בזמן" });
    expect((await run(dana, () => hotSignalsFor(dana))).find((h) => h.contactId === x.contact.id)?.status).toBe("expired");
  });

  it("business isolation + visibility: other business / other agent / no recent dialer call", async () => {
    const list = await mkList("קמפיין בידוד", [dana.id]);
    const x = await mkLead(dana, list.id, { called: true });
    const m = await reply(x.conv.id, x.contact.id, "אני זמינה עכשיו");
    expect(await sys(b.business.id, () => handleInboundAvailability(b.business.id, m.id))).toEqual({ skipped: "no text" });
    expect(await run(b.session, () => hotSignalsFor(b.session))).toHaveLength(0);
    expect((await run(yossi, () => hotSignalsFor(yossi))).some((h) => h.contactId === x.contact.id)).toBe(false);
    const s = await signalOf(m.id);
    await expect(run(yossi, () => cancelSignal(yossi, s!.id))).rejects.toMatchObject({ status: 404 });
    await expect(run(b.session, () => cancelSignal(b.session, s!.id))).rejects.toMatchObject({ status: 404 });
    const fresh = await mkLead(dana, list.id); // never dialed → not the dialer's business
    const m2 = await reply(fresh.conv.id, fresh.contact.id, "אני זמינה עכשיו");
    expect(await signalOf(m2.id)).toBeNull();
  });
});
