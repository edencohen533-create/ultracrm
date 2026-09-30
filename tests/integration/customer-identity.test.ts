/**
 * Existing customer identity (real DB, simulated telephony). The incident: a customer (won deal, lead "converted")
 * sat in an acquisition campaign and another user pulled her from the power dialer as "ליד חדש". Covered here:
 * a new inquiry of an existing customer, the same number in different formats, importing a lead owned by another
 * agent, two agents dialing at once, a transfer after the lead entered a queue, a purchase between queue build and
 * dialing (incl. the last check before the customer's leg rings), an authorized renewals campaign, the same number in
 * two businesses – and the incident itself.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createLead, createDeal } from "@/lib/crm/pipeline";
import { importLeads } from "@/lib/crm/lead-import";
import { transferLeads } from "@/lib/crm/lead-ops";
import { findOrCreateContactByPhone } from "@/lib/crm/contacts";
import { customerFactsOne } from "@/lib/crm/customer-identity";
import { dialEligibility } from "@/lib/dialer/eligibility";
import { claimNextLead, releaseLead } from "@/lib/dialer/queue";
import { startCall, hangupCall, reconcileCall } from "@/lib/dialer/calls";
import { dialLeadLeg } from "@/lib/telephony/events";
import { processDomainEvents } from "@/lib/events";
import { normalizePhone, normalizeProviderNumber } from "@/lib/phone";

let A: Awaited<ReturnType<typeof createBusiness>>, B: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, dana: SessionUser, yossi: SessionUser, ron: SessionUser;
let acquisition: string, everyone: string;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let seq = 0;
const phone = (end = "3") => { seq++; return `+97252${String(4000000 + seq * 10 + Number(end)).slice(-7)}`; };
const contact = async (ownerId: string | null, biz = A, e164 = phone()) => db.contact.create({ data: { businessId: biz.business.id, fullName: `איש קשר ${seq}`, phoneE164: e164, phoneRaw: e164, ownerUserId: ownerId } });
/** An existing customer of `sellerId`: won deal + the lead that converted (no open lead left). */
const customer = async (sellerId: string, contactOwner: string | null = sellerId) => {
  const c = await contact(contactOwner);
  const l = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, status: "converted", ownerUserId: sellerId, closedAt: new Date(Date.now() - 86400_000) } });
  await db.deal.create({ data: { businessId: A.business.id, contactId: c.id, leadId: l.id, title: "מנוי", amount: 500, status: "won", stage: "won", ownerUserId: sellerId, closedAt: new Date(Date.now() - 86400_000) } });
  return c;
};
const freshList = (audience: string) => db.dialList.create({ data: { businessId: A.business.id, name: `L ${++seq}`, audience } }).then((l) => l.id);
const queue = (listId: string, contactId: string) => db.listLead.create({ data: { businessId: A.business.id, listId, contactId, status: "pending" } });
const endCall = async (u: SessionUser, callId: string) => {
  await run(u, () => hangupCall(u, callId)).catch(() => undefined);
  for (let i = 0; i < 40; i++) { const c = await run(owner, () => reconcileCall(callId)); if (c?.endedAt) return; await new Promise((r) => setTimeout(r, 700)); }
};
const events = () => processDomainEvents({ businessId: A.business.id, limit: 50, deadline: Date.now() + 15_000 }).catch(() => undefined);

describe("existing customer identity", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("cust-id", { modules: { crm: true, telephony: true, messaging: true } });
    B = await createBusiness("cust-id-other", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    owner = A.session;
    const mk = async (name: string, active = true) => {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent", isActive: active } });
      return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser;
    };
    dana = await mk("דנה"); yossi = await mk("יוסי"); ron = await mk("רון (עזב)", false);
    await db.phoneNumber.create({ data: { businessId: A.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    const list = (name: string, audience: string) => db.dialList.create({ data: { businessId: A.business.id, name, audience } }).then((l) => l.id);
    acquisition = await list("גיוס", "new_prospects"); everyone = await list("כולם", "all");
  }, 900_000);
  afterAll(async () => { if (A) await destroyBusiness(A.business.id); if (B) await destroyBusiness(B.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("the incident: a customer in an acquisition campaign is never handed out – not to the owner, not to another agent", async () => {
    const c = await customer(dana.id);
    const row = await queue(acquisition, c.id);
    for (const u of [owner, yossi, dana]) expect(await run(u, () => claimNextLead(A.business.id, u.id, acquisition))).toBeNull();
    // A campaign for everyone still leaves her with her handling agent only.
    const r2 = await queue(everyone, c.id);
    expect(await run(yossi, () => claimNextLead(A.business.id, yossi.id, everyone))).toBeNull();
    const got = await run(dana, () => claimNextLead(A.business.id, dana.id, everyone));
    expect(got?.id).toBe(r2.id);
    expect(got?.claimReason).toContain("לקוח קיים"); // never "ליד חדש"
    await run(dana, () => releaseLead(dana.id, r2.id, "test"));
    await expect(run(owner, () => dialEligibility(owner, { contactId: c.id, auto: true, listId: acquisition }))).rejects.toMatchObject({ code: "handled_by_other" });
    expect((await db.listLead.findUnique({ where: { id: row.id } }))?.status).toBe("pending");
  });

  it("an existing customer's new inquiry: an opportunity marked 'existing customer' with the handling agent, not a new lead elsewhere", async () => {
    const c = await customer(dana.id, null); // contact not owned – the seller is the handler
    const l = await run(owner, () => createLead(owner, { contactId: c.id, source: "facebook" }, "webhook"));
    await events();
    const saved = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(saved).toMatchObject({ existingCustomer: true, ownerUserId: dana.id, reviewReason: null });
    // The same person asks again → no second lead (channel), a clear refusal on the screen.
    const again = await run(owner, () => createLead(owner, { contactId: c.id }, "webhook"));
    expect(again.id).toBe(l.id); expect(again.reused).toBe(true);
    await expect(run(owner, () => createLead(owner, { contactId: c.id }))).rejects.toMatchObject({ code: "open_lead_exists" });
    // Handling agent left → waits for a manager, never round robin.
    const orphan = await customer(ron.id);
    const o = await run(owner, () => createLead(owner, { contactId: orphan.id }, "webhook"));
    await events();
    expect(await db.lead.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ existingCustomer: true, ownerUserId: null, reviewReason: "handler_inactive" });
    await expect(run(yossi, () => dialEligibility(yossi, { contactId: orphan.id, auto: false }))).rejects.toMatchObject({ code: "customer_needs_review" });
    // The customer card says so before dialing.
    const f = await run(owner, () => customerFactsOne(A.business.id, c.id));
    expect(f).toMatchObject({ isCustomer: true, purchases: 1, handler: { id: dana.id } });
  });

  it("the same number in different formats is one person", async () => {
    const local = "052-777-1234", intl = "+972 52 777 1234", provider = "972527771234";
    expect(new Set([normalizePhone(local), normalizePhone(intl), normalizeProviderNumber(provider), normalizePhone("00972527771234")]).size).toBe(1);
    expect(normalizeProviderNumber("14155552671")).toBe("+14155552671"); // WhatsApp / caller ID without "+"
    const first = await findOrCreateContactByPhone(A.business.id, normalizePhone(local)!, { fullName: "א", phoneRaw: local, source: "form" });
    const second = await findOrCreateContactByPhone(A.business.id, normalizeProviderNumber(provider)!, { fullName: "ב", phoneRaw: provider, source: "whatsapp" });
    expect(second.id).toBe(first.id);
    // An additional phone of a contact is that contact too.
    await db.contactPhone.create({ data: { businessId: A.business.id, contactId: first.id, e164: "+972527771299" } });
    expect((await findOrCreateContactByPhone(A.business.id, normalizePhone("0527771299")!, { fullName: "ג", phoneRaw: "x", source: "import" })).id).toBe(first.id);
  });

  it("import never moves an owned lead and routes an existing customer to the handling agent", async () => {
    const c = await contact(null);
    const open = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, status: "contacted", ownerUserId: dana.id } });
    const cust = await customer(dana.id);
    const r = await run(owner, () => importLeads(owner, { rows: [{ phone: c.phoneE164.replace("+972", "0") }, { phone: cust.phoneE164 }], owner: yossi.id, offset: 0 }));
    expect(r).toMatchObject({ exists: 1, conflicts: 1, created: 1, existingCustomers: 1, routedToHandler: 1 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: open.id } })).ownerUserId).toBe(dana.id);
    const opened = await db.lead.findFirstOrThrow({ where: { contactId: cust.id, status: "new" } });
    expect(opened).toMatchObject({ ownerUserId: dana.id, existingCustomer: true });
  });

  it("two agents dialing the same person at once: exactly one call (also across two numbers of the person)", async () => {
    const c = await contact(null);
    const both = await Promise.allSettled([dana, yossi].map((u) => run(u, () => startCall(u, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id }))));
    const ok = both.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect((both.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.code).toMatch(/number_in_call|contact_in_call|call_active/);
    const winner = ok[0].status === "fulfilled" ? ok[0].value : null;
    const loser = winner!.userId === dana.id ? yossi : dana;
    // The other agent dials the person's second number: still refused (same person).
    await db.contactPhone.create({ data: { businessId: A.business.id, contactId: c.id, e164: phone("7") } });
    const second = (await db.contactPhone.findFirstOrThrow({ where: { contactId: c.id } })).e164;
    await expect(run(loser, () => startCall(loser, { idempotencyKey: crypto.randomUUID(), mode: "manual", phone: second }))).rejects.toMatchObject({ code: "contact_in_call" });
    // A double click / retry with the same key returns the same call.
    const winUser = winner!.userId === dana.id ? dana : yossi;
    const same = await run(winUser, () => startCall(winUser, { idempotencyKey: winner!.idempotencyKey, mode: "manual", contactId: c.id }));
    expect(same.id).toBe(winner!.id);
    await endCall(winUser, winner!.id);
  });

  it("a transfer after the lead entered the queue: the previous agent can no longer claim or dial it", async () => {
    const everyone = await freshList("all");
    const c = await contact(null);
    const l = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, status: "new", ownerUserId: dana.id } });
    const row = await queue(everyone, c.id);
    await run(owner, () => transferLeads(owner, { leadIds: [l.id], toUserId: yossi.id }));
    expect(await run(dana, () => claimNextLead(A.business.id, dana.id, everyone))).toBeNull();
    await expect(run(dana, () => startCall(dana, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id }))).rejects.toMatchObject({ code: "lead_not_assigned_to_you" });
    const got = await run(yossi, () => claimNextLead(A.business.id, yossi.id, everyone));
    expect(got?.id).toBe(row.id);
    await run(yossi, () => releaseLead(yossi.id, row.id, "test"));
    const hist = await db.auditLog.findFirst({ where: { businessId: A.business.id, entityId: l.id, action: "lead.transferred" } });
    expect(hist).toBeTruthy();
  });

  it("a purchase between building the queue and dialing: refused at dial time and again right before the customer's phone rings", async () => {
    const acquisition = await freshList("new_prospects");
    const c = await contact(null);
    const l = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, status: "qualified", ownerUserId: dana.id } });
    const row = await queue(acquisition, c.id);
    const claimed = await run(dana, () => claimNextLead(A.business.id, dana.id, acquisition));
    expect(claimed?.id).toBe(row.id);
    // She buys (another screen) – the queue row is already in the agent's hands.
    await run(owner, () => createDeal(owner, { contactId: c.id, leadId: l.id, title: "רכישה", amount: 300, stage: "won", ownerUserId: dana.id }));
    await expect(run(dana, () => dialEligibility(dana, { contactId: c.id, auto: true, listId: acquisition }))).rejects.toMatchObject({ code: "existing_customer_in_acquisition" });
    await run(dana, () => releaseLead(dana.id, row.id, "test"));
    // The last check before the provider: an automatic call whose agent leg connected after the purchase.
    const call = await db.call.create({ data: { businessId: A.business.id, userId: dana.id, contactId: c.id, listId: acquisition, mode: "power", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+97230000000", status: "agent_connected", agentLegId: `leg-${crypto.randomUUID()}` } });
    await dialLeadLeg(call.id);
    const after = await db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.leadLegId).toBeNull();
    expect(after.failureReason).toContain("refused before ringing");
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).customerSince).not.toBeNull();
  });

  it("an authorized renewals campaign: customers only, by their handling agent", async () => {
    const renewals = await freshList("existing_customers");
    const c = await customer(dana.id);
    const prospect = await contact(null);
    await queue(renewals, prospect.id);
    const row = await queue(renewals, c.id);
    expect(await run(yossi, () => claimNextLead(A.business.id, yossi.id, renewals))).toBeNull();
    const got = await run(dana, () => claimNextLead(A.business.id, dana.id, renewals));
    expect(got?.id).toBe(row.id);
    await expect(run(dana, () => dialEligibility(dana, { contactId: c.id, auto: true, listId: renewals }))).resolves.toMatchObject({ isCustomer: true });
    await run(dana, () => releaseLead(dana.id, row.id, "test"));
    await expect(run(dana, () => dialEligibility(dana, { contactId: prospect.id, auto: true, listId: renewals }))).rejects.toMatchObject({ code: "not_a_customer" });
  });

  it("the same number in two businesses stays two people", async () => {
    const e164 = phone("9");
    const inA = await customer(dana.id).then(async (c) => { await db.contact.update({ where: { id: c.id }, data: { phoneE164: e164 } }); return c; });
    const inB = await contact(null, B, e164);
    expect((await findOrCreateContactByPhone(B.business.id, e164, { fullName: "x", phoneRaw: e164, source: "form" })).id).toBe(inB.id);
    expect(await run(B.session, () => customerFactsOne(B.business.id, inB.id))).toMatchObject({ isCustomer: false, purchases: 0 });
    expect(await run(B.session, () => customerFactsOne(B.business.id, inA.id))).toBeNull();
    expect(await run(owner, () => customerFactsOne(A.business.id, inA.id))).toMatchObject({ isCustomer: true });
    const l = await run(B.session, () => createLead(B.session, { contactId: inB.id }, "webhook"));
    expect(l.existingCustomer).toBe(false);
  });
});
