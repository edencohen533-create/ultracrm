/**
 * A "lost" lead of agent B transferred to agent A shows up for A as a NEW lead (status new, attempts from zero,
 * in A's queue, counted as "new" in waiting today), while its full history stays documented: the previous agent's
 * calls and notes, the transfer, and "reopened (was: אבוד, reason)". Other statuses keep their status on transfer.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { attemptStats, leadHistory, transferLeads, waitingToday } from "@/lib/crm/lead-ops";
import { listLeads, updateLead } from "@/lib/crm/pipeline";
import { contactTimeline } from "@/lib/crm/timeline";
import { POST as personalListPOST } from "@/app/api/dialer/personal-list/route";
import { GET as leadGET } from "@/app/api/leads/[id]/route";

let a: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, agentA: SessionUser, agentB: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const req = async (u: SessionUser, url: string, method = "GET") => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" } });
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
let seq = 0;

async function lostLeadOf(u: SessionUser, status: "lost" | "contacted" = "lost") {
  seq++;
  const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `לקוח ${seq}`, phoneE164: `+97253${String(Date.now()).slice(-6)}${seq}`, phoneRaw: "x", ownerUserId: u.id } });
  const l = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, status, ownerUserId: u.id, createdAt: new Date(Date.now() - 5 * 86400_000), ...(status === "lost" ? { closedAt: new Date(Date.now() - 86400_000), closeReason: "לא עונה, לא מעוניין" } : {}) } });
  // B's three unanswered dials and a note – history that must follow the lead.
  for (let i = 0; i < 3; i++) await db.call.create({ data: { businessId: a.business.id, userId: u.id, contactId: c.id, mode: "power", provider: "mock", direction: "outbound", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "x", status: "ended", telephonyResult: "no_answer", leadDialedAt: new Date(Date.now() - (4 - i) * 86400_000), endedAt: new Date(), outcome: "no_answer", outcomeNote: `ניסיון ${i + 1} של ${u.fullName}`, createdAt: new Date(Date.now() - (4 - i) * 86400_000) } });
  await db.note.create({ data: { businessId: a.business.id, contactId: c.id, authorId: u.id, body: "הלקוח אמר שיחשוב על זה" } });
  if (status === "lost") await db.auditLog.create({ data: { businessId: a.business.id, actorId: u.id, entityType: "lead", entityId: l.id, action: "lead.updated", payload: { fields: ["status"], status: "lost" }, createdAt: new Date(Date.now() - 86400_000) } });
  return { contact: c, lead: l };
}

describe("transfer of a lost lead → new lead for the new agent, history kept", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("reopen-lost", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(a.account.id);
    owner = a.session;
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    agentA = await mk("נציג א"); agentB = await mk("נציג ב");
  }, 600_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("lost at B → transferred to A: status new, attempts 0, in A's queue and 'new' waiting count; B loses it", async () => {
    const { contact, lead } = await lostLeadOf(agentB);
    expect((await run(owner, () => attemptStats(a.business.id, [contact.id]))).get(lead.id)?.count).toBe(3);
    const listA = (await (await personalListPOST(await req(agentA, "/api/dialer/personal-list", "POST"), ctx())).json()).data.id as string;
    const r = await run(owner, () => transferLeads(owner, { leadIds: [lead.id], toUserId: agentA.id }));
    expect(r).toMatchObject({ transferred: [lead.id], reopened: [lead.id] });
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after).toMatchObject({ status: "new", ownerUserId: agentA.id, closedAt: null, closeReason: null });
    expect(after.reopenedAt).toBeTruthy();
    // For A it is a new lead: no attempts yet, counted as "new", in the personal queue ready to dial.
    expect((await run(agentA, () => attemptStats(a.business.id, [contact.id]))).get(lead.id)?.count ?? 0).toBe(0);
    expect((await run(agentA, () => waitingToday(agentA))).ids.new).toContain(lead.id);
    expect(await db.listLead.findFirst({ where: { listId: listA, contactId: contact.id } })).toMatchObject({ status: "pending", attempts: 0 });
    const pageA = await run(agentA, () => listLeads(agentA, { sort: "createdAt", direction: "desc", page: 1, limit: 50 } as never));
    expect(pageA.items.find((x) => x.id === lead.id)).toMatchObject({ status: "new", attempts: 0 });
    const pageB = await run(agentB, () => listLeads(agentB, { sort: "createdAt", direction: "desc", page: 1, limit: 50 } as never));
    expect(pageB.items.some((x) => x.id === lead.id)).toBe(false);
    // An automation-visible status change was emitted (lost → new).
    expect(await db.domainEvent.count({ where: { businessId: a.business.id, type: "lead.status_changed", contactId: contact.id } })).toBe(1);
  });

  it("the lead's folder documents everything for A: B's calls + note, the transfer and 'reopened (was אבוד)'", async () => {
    const { contact, lead } = await lostLeadOf(agentB);
    await run(owner, () => transferLeads(owner, { leadIds: [lead.id], toUserId: agentA.id }));
    const hist = await run(agentA, () => leadHistory(a.business.id, [lead.id]));
    expect(hist.map((h) => h.title)).toEqual(expect.arrayContaining([`הליד הועבר מנציג ב לנציג א`, "נפתח מחדש כליד חדש (היה: אבוד)", "סטטוס שונה לאבוד"]));
    expect(hist.find((h) => h.kind === "reopen")?.body).toContain("לא עונה, לא מעוניין");
    // Lead window (API the drawer reads).
    const api = (await (await leadGET(await req(agentA, `/api/leads/${lead.id}`), ctx({ id: lead.id }))).json()).data;
    expect(api.status).toBe("new");
    expect(api.history.length).toBeGreaterThanOrEqual(3);
    // Full timeline for the new owner: B's three calls and note too.
    const tl = await run(agentA, () => contactTimeline(agentA, contact.id));
    expect(tl.filter((i) => i.kind === "call")).toHaveLength(3);
    expect(tl.some((i) => i.kind === "note" && i.body === "הלקוח אמר שיחשוב על זה")).toBe(true);
    expect(tl.some((i) => i.title.startsWith("נפתח מחדש כליד חדש"))).toBe(true);
    expect(tl.some((i) => i.title === "הליד הועבר מנציג ב לנציג א")).toBe(true);
    // B no longer sees it at all.
    await expect(run(agentB, () => updateLead(agentB, lead.id, { notes: "x" }))).rejects.toMatchObject({ status: 403 });
  });

  it("a non-lost lead keeps its status and attempt count on transfer", async () => {
    const { contact, lead } = await lostLeadOf(agentB, "contacted");
    const r = await run(owner, () => transferLeads(owner, { leadIds: [lead.id], toUserId: agentA.id }));
    expect(r.reopened).toEqual([]);
    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "contacted", reopenedAt: null });
    expect((await run(owner, () => attemptStats(a.business.id, [contact.id]))).get(lead.id)?.count).toBe(3);
  });
});
