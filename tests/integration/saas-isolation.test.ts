/**
 * SaaS isolation, proven through the API routes (real DB, real auth cookies, real handlers): two businesses, users of
 * every role, requests with tampered ids / business ids, role scopes, module gating, invites, phone numbers, the
 * public tracker and the fair event queue.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { emitEvent, processDomainEvents } from "@/lib/events";

import { GET as contactGET, PATCH as contactPATCH } from "@/app/api/contacts/[id]/route";
import { POST as contactsPOST } from "@/app/api/contacts/route";
import { GET as leadGET, PATCH as leadPATCH } from "@/app/api/leads/[id]/route";
import { GET as recordingGET } from "@/app/api/recordings/[callId]/route";
import { GET as convMessagesGET } from "@/app/api/conversations/[id]/messages/route";
import { GET as conversationsGET, POST as conversationsPOST } from "@/app/api/conversations/route";
import { POST as queueTransferPOST } from "@/app/api/queue/[id]/transfer/route";
import { POST as phonePOST } from "@/app/api/phone-numbers/route";
import { PATCH as phonePATCH } from "@/app/api/phone-numbers/[id]/route";
import { POST as usersPOST } from "@/app/api/users/route";
import { GET as inviteGET, POST as invitePOST } from "@/app/api/invite/[token]/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as keysPOST } from "@/app/api/integrations/keys/route";
import { GET as coachSessionsGET } from "@/app/api/coach/sessions/route";
import { GET as zadarmaGET } from "@/app/api/telephony/zadarma/route";
import { POST as trackPOST } from "@/app/api/track/[key]/events/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
let aManager: SessionUser, aTeamManager: SessionUser, aAgent1: SessionUser, aAgent2: SessionUser, bAgent: SessionUser;
const accounts: string[] = [];
const ctx = <T extends Record<string, string>>(p: T = {} as T) => ({ params: Promise.resolve(p) });
async function req(user: SessionUser | null, url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(user ? { cookie: `ultracrm_session=${await signSession(user)}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const status = async (p: Promise<Response>) => (await p).status;
async function member(biz: Biz, role: "owner" | "manager" | "agent", teamId: string | null = null): Promise<SessionUser> {
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: `${role} user`, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: biz.business.id, accountId: acc.id, email: acc.email, fullName: acc.fullName, role, teamId } });
  return { id: u.id, accountId: acc.id, businessId: biz.business.id, email: acc.email, fullName: acc.fullName, role, teamId };
}
let seq = 0;
const contactIn = (biz: Biz, ownerUserId: string | null = null) => { seq++; return db.contact.create({ data: { businessId: biz.business.id, fullName: `Iso ${seq}`, phoneE164: `+9725${String(30000000 + Date.now() % 1000000 * 10 + seq).slice(-8)}`, phoneRaw: "x", ownerUserId } }); };

describe("SaaS isolation through the API", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("iso-a", { modules: { crm: true, telephony: true, whatsapp: true, sms: false, email: false } });
    B = await createBusiness("iso-b", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(A.account.id, B.account.id);
    const t1 = await db.team.create({ data: { businessId: A.business.id, name: "T1" } });
    const t2 = await db.team.create({ data: { businessId: A.business.id, name: "T2" } });
    aManager = await member(A, "manager");
    aTeamManager = await member(A, "manager", t1.id);
    aAgent1 = await member(A, "agent", t1.id);
    aAgent2 = await member(A, "agent", t2.id);
    bAgent = await member(B, "agent");
    await db.team.update({ where: { id: t1.id }, data: { managerId: aTeamManager.id } });
    // Team-scoped managers in A (default is business scope).
    const s = (await db.business.findUniqueOrThrow({ where: { id: A.business.id } })).settings as Record<string, unknown>;
    await db.business.update({ where: { id: A.business.id }, data: { settings: { ...s, permissions: { managerScope: "team", agentSeesUnassigned: false, agentTransfer: "none", agentTransferUserIds: [] } } } });
  }, 600_000);
  afterAll(async () => {
    for (const b of [A, B]) if (b) await destroyBusiness(b.business.id);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 600_000);

  it("tampered ids: users of A never read or change B's contacts, leads, calls/recordings, conversations or queue", async () => {
    const bContact = await contactIn(B, bAgent.id);
    const bLead = await db.lead.create({ data: { businessId: B.business.id, contactId: bContact.id, status: "new", ownerUserId: bAgent.id } });
    const bCall = await db.call.create({ data: { businessId: B.business.id, userId: bAgent.id, contactId: bContact.id, mode: "manual", provider: "mock", idempotencyKey: `iso-${crypto.randomUUID()}`, toE164: bContact.phoneE164, fromE164: "+97231111111", status: "ended", endedAt: new Date(), recordingStatus: "saved", recordingId: "rec-b" } });
    const bConv = await db.conversation.create({ data: { businessId: B.business.id, contactId: bContact.id, channel: "whatsapp", assignedAgentId: bAgent.id } });
    const bList = await db.dialList.create({ data: { businessId: B.business.id, name: "B list" } });
    const bListLead = await db.listLead.create({ data: { businessId: B.business.id, listId: bList.id, contactId: bContact.id } });
    for (const u of [A.session, aManager, aAgent1]) {
      expect(await status(contactGET(await req(u, `/api/contacts/${bContact.id}`), ctx({ id: bContact.id })))).toBe(404);
      expect(await status(contactPATCH(await req(u, `/api/contacts/${bContact.id}`, "PATCH", { fullName: "pwned" }), ctx({ id: bContact.id })))).toBeGreaterThanOrEqual(403);
      expect(await status(leadGET(await req(u, `/api/leads/${bLead.id}`), ctx({ id: bLead.id })))).toBe(404);
      expect(await status(leadPATCH(await req(u, `/api/leads/${bLead.id}`, "PATCH", { status: "lost" }), ctx({ id: bLead.id })))).toBeGreaterThanOrEqual(403);
      expect(await status(recordingGET(await req(u, `/api/recordings/${bCall.id}`), ctx({ callId: bCall.id })))).toBeGreaterThanOrEqual(403);
      expect(await status(convMessagesGET(await req(u, `/api/conversations/${bConv.id}/messages`), ctx({ id: bConv.id })))).toBe(404);
    }
    expect(await status(queueTransferPOST(await req(A.session, `/api/queue/${bListLead.id}/transfer`, "POST", { toUserId: aAgent1.id }), ctx({ id: bListLead.id })))).toBe(404);
    const after = await db.contact.findUniqueOrThrow({ where: { id: bContact.id } });
    expect(after.fullName).not.toBe("pwned");
    expect((await db.lead.findUniqueOrThrow({ where: { id: bLead.id } })).status).toBe("new");
    expect((await db.listLead.findUniqueOrThrow({ where: { id: bListLead.id } })).preferredUserId).toBeNull();
  });

  it("a businessId sent by the client is ignored: the row lands in the caller's own business", async () => {
    const res = await contactsPOST(await req(A.session, "/api/contacts", "POST", { fullName: "Mine", phone: "0521234599", businessId: B.business.id }), ctx());
    expect(res.status).toBeLessThan(300);
    const id = (await res.json()).data.id as string;
    expect((await db.contact.findUniqueOrThrow({ where: { id } })).businessId).toBe(A.business.id);
  });

  it("roles: agents stay in their own leads/contacts; team managers stay in their team", async () => {
    const c2 = await contactIn(A, aAgent2.id);
    const lead2 = await db.lead.create({ data: { businessId: A.business.id, contactId: c2.id, status: "new", ownerUserId: aAgent2.id } });
    expect(await status(leadGET(await req(aAgent1, `/api/leads/${lead2.id}`), ctx({ id: lead2.id })))).toBe(404);
    expect(await status(contactPATCH(await req(aAgent1, `/api/contacts/${c2.id}`, "PATCH", { fullName: "x" }), ctx({ id: c2.id })))).toBeGreaterThanOrEqual(403);
    // A contact without a conversation is not free for another agent to take through the inbox.
    const conv = await conversationsPOST(await req(aAgent1, "/api/conversations", "POST", { contactId: c2.id }));
    expect(conv.status).toBeGreaterThanOrEqual(400);
    expect(await db.conversation.count({ where: { contactId: c2.id } })).toBe(0);
    // Team T1 manager: can edit T1 contacts, not T2's; cannot move T2's queue lead.
    expect(await status(contactPATCH(await req(aTeamManager, `/api/contacts/${c2.id}`, "PATCH", { fullName: "x" }), ctx({ id: c2.id })))).toBe(403);
    const c1 = await contactIn(A, aAgent1.id);
    expect(await status(contactPATCH(await req(aTeamManager, `/api/contacts/${c1.id}`, "PATCH", { fullName: "T1 edit" }), ctx({ id: c1.id })))).toBe(200);
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "A list" } });
    const ll = await db.listLead.create({ data: { businessId: A.business.id, listId: list.id, contactId: c2.id, preferredUserId: aAgent2.id } });
    expect(await status(queueTransferPOST(await req(aTeamManager, `/api/queue/${ll.id}/transfer`, "POST", { toUserId: aAgent1.id }), ctx({ id: ll.id })))).toBe(403);
    expect((await db.listLead.findUniqueOrThrow({ where: { id: ll.id } })).preferredUserId).toBe(aAgent2.id);
    // Owner-only integrations: a manager can no longer create an API key (a key = a full data export).
    expect(await status(keysPOST(await req(aManager, "/api/integrations/keys", "POST", { name: "dump" }), ctx()))).toBe(403);
    expect(await status(zadarmaGET(await req(aAgent1, "/api/telephony/zadarma"), ctx()))).toBe(403);
  });

  it("modules are enforced by the API: SMS threads are invisible without the SMS module; coach needs telephony", async () => {
    const c = await contactIn(A, aAgent1.id);
    const sms = await db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, channel: "sms", assignedAgentId: A.user.id } });
    const list = await (await conversationsGET(await req(A.session, "/api/conversations?channel=sms"))).json();
    expect(JSON.stringify(list)).not.toContain(sms.id);
    expect(await status(convMessagesGET(await req(A.session, `/api/conversations/${sms.id}/messages`), ctx({ id: sms.id })))).toBe(404);
    // B's manager without telephony: turn the module off for B and ask for transcripts.
    const bm = await member(B, "manager");
    await db.business.update({ where: { id: B.business.id }, data: { modules: { crm: true, telephony: false, whatsapp: true } } });
    try { expect(await status(coachSessionsGET(await req(bm, "/api/coach/sessions"), ctx()))).toBe(403); }
    finally { await db.business.update({ where: { id: B.business.id }, data: { modules: { crm: true, telephony: true, whatsapp: true } } }); }
  });

  it("invites: an owner never sets someone's password; a pre-created account cannot be used to take over another business's user", async () => {
    const email = `victim-${crypto.randomUUID().slice(0, 8)}@test.local`;
    // Business A (the attacker) adds the email first. It gets only a link – no password of its choosing.
    const ra = await usersPOST(await req(A.session, "/api/users", "POST", { fullName: "Victim", email, role: "agent", password: "Known1234" }), ctx());
    expect(ra.status).toBe(201);
    const a = (await ra.json()).data;
    expect(a.inviteUrl).toBeTruthy();
    expect(a).not.toHaveProperty("createdAccount");
    const acct = await db.account.findUniqueOrThrow({ where: { email } }); accounts.push(acct.id);
    expect(acct.claimedAt).toBeNull();
    expect(await bcrypt.compare("Known1234", acct.passwordHash)).toBe(false);
    // Nobody can log in to that account before an invite is accepted.
    expect(await status(loginPOST(await req(null, "/api/auth/login", "POST", { email, password: "Known1234" })))).toBe(401);
    // Business B invites the same person: same response shape, membership inactive until accepted.
    const rb = await usersPOST(await req(B.session, "/api/users", "POST", { fullName: "Victim", email, role: "manager" }), ctx());
    const b = (await rb.json()).data;
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect((await db.user.findFirstOrThrow({ where: { businessId: B.business.id, email } })).isActive).toBe(false);
    // The real person opens B's link and sets their own password → account claimed, B membership active.
    const tokenB = new URL(b.inviteUrl).pathname.split("/").pop()!;
    expect((await (await inviteGET(await req(null, `/api/invite/${tokenB}`), ctx({ token: tokenB }))).json()).data.mode).toBe("set_password");
    const accept = await invitePOST(await req(null, `/api/invite/${tokenB}`, "POST", { password: "MyOwnSecret9" }), ctx({ token: tokenB }));
    expect(accept.status).toBe(200);
    expect(accept.headers.get("set-cookie")).toContain("ultracrm_session=");
    const claimed = await db.account.findUniqueOrThrow({ where: { email } });
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.sessionVersion).toBe(acct.sessionVersion + 1);
    expect((await db.user.findFirstOrThrow({ where: { businessId: B.business.id, email } })).isActive).toBe(true);
    // One-time link.
    expect(await status(invitePOST(await req(null, `/api/invite/${tokenB}`, "POST", { password: "MyOwnSecret9" }), ctx({ token: tokenB })))).toBe(404);
    // A's link now requires the owner of the account's password – the attacker does not have it.
    const tokenA = new URL(a.inviteUrl).pathname.split("/").pop()!;
    expect((await (await inviteGET(await req(null, `/api/invite/${tokenA}`), ctx({ token: tokenA }))).json()).data.mode).toBe("confirm_password");
    expect(await status(invitePOST(await req(null, `/api/invite/${tokenA}`, "POST", { password: "Known1234" }), ctx({ token: tokenA })))).toBe(403);
    expect((await db.user.findFirstOrThrow({ where: { businessId: A.business.id, email } })).isActive).toBe(false);
    // Garbage / expired tokens reveal nothing.
    expect(await status(inviteGET(await req(null, "/api/invite/not-a-real-token-at-all-000"), ctx({ token: "not-a-real-token-at-all-000" })))).toBe(404);
  });

  it("phone numbers: a business cannot register or activate a number another business uses", async () => {
    const e164 = `+9723${String(Date.now()).slice(-7)}`;
    await db.phoneNumber.create({ data: { businessId: B.business.id, e164, provider: "telnyx", isActive: true, verificationStatus: "verified", verifiedAt: new Date() } });
    expect(await status(phonePOST(await req(A.session, "/api/phone-numbers", "POST", { phone: e164 }), ctx()))).toBe(409);
    const shadow = await db.phoneNumber.create({ data: { businessId: A.business.id, e164, provider: "telnyx", isActive: false } });
    expect(await status(phonePATCH(await req(A.session, `/api/phone-numbers/${shadow.id}`, "PATCH", { isActive: true }), ctx({ id: shadow.id })))).toBe(409);
    // The database refuses a second ACTIVE row even if application code were bypassed.
    await expect(db.phoneNumber.update({ where: { id: shadow.id }, data: { isActive: true } })).rejects.toThrow();
  });

  it("public tracker: without the store's Origin it is refused; marketing consent is never taken from it", async () => {
    const store = await db.storeConnection.create({ data: { businessId: A.business.id, platform: "custom", name: "Shop", domain: "shop.example.com", publicKey: `pk_${crypto.randomUUID().replace(/-/g, "")}`, isActive: true } });
    const body = { type: "cart", externalId: "c1", phone: "+972521112233", acceptsMarketing: true, checkoutUrl: "https://evil.example/phish" };
    const call = (headers: Record<string, string>) => trackPOST(new Request(`http://localhost/api/track/${store.publicKey}/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx({ key: store.publicKey }));
    expect((await call({})).status).toBe(403);
    expect((await call({ origin: "https://evil.example" })).status).toBe(403);
    expect((await call({ origin: "https://shop.example.com" })).status).toBe(204);
    const c = await db.contact.findFirstOrThrow({ where: { businessId: A.business.id, phoneE164: "+972521112233" } });
    expect(c.consentStatus).not.toBe("OPTED_IN");
    const cart = await db.cart.findFirstOrThrow({ where: { storeId: store.id, externalId: "c1" } });
    expect(cart.checkoutUrl).toBeNull();
  });

  it("fair event queue: one business's backlog does not starve another business's event", async () => {
    for (let i = 0; i < 30; i++) await emitEvent(db, { businessId: A.business.id, type: "task.created", dedupeKey: `iso-bulk-${crypto.randomUUID()}`, payload: {} });
    const bEvent = await emitEvent(db, { businessId: B.business.id, type: "task.created", dedupeKey: `iso-b-${crypto.randomUUID()}`, payload: {} });
    await db.domainEvent.update({ where: { id: bEvent!.id }, data: { occurredAt: new Date(Date.now() + 1000) } }); // newest of all
    await processDomainEvents({ limit: 10 });
    expect((await db.domainEvent.findUniqueOrThrow({ where: { id: bEvent!.id } })).status).toBe("done");
  });
});
