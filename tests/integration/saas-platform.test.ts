/**
 * SaaS separation (real DB, real routes): two customer businesses (an owner each), an agent, one person who is owner in
 * one business and agent in the other, and a platform admin. Covers: no cross-business reads / writes (also with a
 * forged business id), no self-granted modules or quotas, owners locked out of platform administration, the right
 * role per business, platform management without content, read-only / time-boxed / audited support access, a new
 * business that starts empty (no data or secrets copied), lifecycle with confirmation that keeps data, and isolation
 * of files and background sending.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { setUserPermissions } from "@/lib/access/manage";
import { businessCanUse, invalidateEntitlement } from "@/lib/access/engine";
import { acceptInvite } from "@/server/services/invite-service";
import { deliverDueWebhooks } from "@/server/services/integrations";
import { GET as contactsGET, POST as contactsPOST } from "@/app/api/contacts/route";
import { GET as contactGET } from "@/app/api/contacts/[id]/route";
import { PATCH as settingsPATCH } from "@/app/api/settings/route";
import { GET as meGET } from "@/app/api/auth/me/route";
import { POST as switchPOST } from "@/app/api/auth/switch/route";
import { GET as bizListGET, POST as bizCreatePOST } from "@/app/api/platform/businesses/route";
import { GET as bizGET } from "@/app/api/platform/businesses/[id]/route";
import { GET as statusGET, POST as statusPOST } from "@/app/api/platform/businesses/[id]/status/route";
import { POST as supportPOST } from "@/app/api/platform/businesses/[id]/support/route";
import { POST as supportEndPOST } from "@/app/api/platform/support/end/route";
import { POST as tokenPOST } from "@/app/api/telephony/token/route";
import { GET as attachmentGET } from "@/app/api/attachments/[id]/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz, HOME: Biz;
let agentA: SessionUser, dualInA: SessionUser, dualInB: SessionUser, admin: SessionUser;
const accounts: string[] = []; const created: string[] = [];
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const cookieOf = async (u: SessionUser) => `ultracrm_session=${await signSession(u)}`;
const req = async (who: SessionUser | string, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: typeof who === "string" ? who : await cookieOf(who), "Content-Type": "application/json", origin: "http://localhost" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const member = async (biz: Biz, accountId: string, role: "owner" | "manager" | "agent", name: string) => {
  const acc = await db.account.findUniqueOrThrow({ where: { id: accountId } });
  const u = await db.user.create({ data: { businessId: biz.business.id, accountId, email: acc.email, fullName: name, role } });
  return { id: u.id, accountId, businessId: biz.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser;
};
const account = async (name: string, extra: Record<string, unknown> = {}) => { const a = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date(), ...extra } }); accounts.push(a.id); return a; };

describe("SaaS platform separation", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("saas-a", { modules: { crm: true, whatsapp: true } }); B = await createBusiness("saas-b", { modules: { crm: true } }); HOME = await createBusiness("saas-home", { modules: { crm: true } });
    accounts.push(A.account.id, B.account.id, HOME.account.id);
    agentA = await member(A, (await account("נציג א")).id, "agent", "נציג א");
    const dual = await account("כפול");
    dualInA = await member(A, dual.id, "agent", "כפול"); dualInB = await member(B, dual.id, "owner", "כפול");
    await db.account.update({ where: { id: HOME.account.id }, data: { isPlatformAdmin: true } });
    admin = HOME.session;
    await db.contact.create({ data: { businessId: A.business.id, fullName: "לקוחה של A", phoneE164: "+972541110001", phoneRaw: "x" } });
    await db.contact.create({ data: { businessId: B.business.id, fullName: "לקוחה של B", phoneE164: "+972541110002", phoneRaw: "x" } });
    await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: { secretToken: "A-SECRET-TOKEN" } } });
  }, 900_000);
  afterAll(async () => {
    for (const id of [...created, A?.business.id, B?.business.id, HOME?.business.id].filter(Boolean) as string[]) await destroyBusiness(id).catch(() => undefined);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 900_000);

  it("an owner never sees or changes another business – also with a forged business id", async () => {
    const bContact = await db.contact.findFirstOrThrow({ where: { businessId: B.business.id } });
    expect((await contactGET(await req(A.session, `/api/contacts/${bContact.id}`), ctx({ id: bContact.id }))).status).toBe(404);
    const list = await json(await contactsGET(await req(A.session, "/api/contacts"), ctx()));
    expect(JSON.stringify(list.body)).not.toContain("לקוחה של B");
    const r = await json(await contactsPOST(await req(A.session, "/api/contacts", "POST", { fullName: "ניסיון עקיפה", phone: "0541110099", businessId: B.business.id }), ctx()));
    expect(r.status).toBe(201);
    expect((await db.contact.findFirstOrThrow({ where: { phoneE164: "+972541110099" } })).businessId).toBe(A.business.id);
    // A token signed for business A with B's id is refused (the membership is re-checked on every request).
    expect((await contactsGET(await req({ ...A.session, businessId: B.business.id }, "/api/contacts"), ctx())).status).toBe(401);
  });

  it("modules / quotas cannot be self-granted; an agent cannot raise permissions", async () => {
    await db.business.update({ where: { id: A.business.id }, data: { modules: { crm: true, whatsapp: true, telephony: false, sms: false, email: false } } }); invalidateEntitlement(A.business.id);
    const before = await db.business.findUniqueOrThrow({ where: { id: A.business.id }, select: { modules: true, planVersionId: true } });
    await settingsPATCH(await req(A.session, "/api/settings", "PATCH", { modules: { telephony: true, sms: true }, quotas: { users: 999 }, planVersionId: "x", settings: {} }), ctx());
    expect(await db.business.findUniqueOrThrow({ where: { id: A.business.id }, select: { modules: true, planVersionId: true } })).toEqual(before);
    await expect(withBusiness(A.business.id, () => setUserPermissions(agentA, agentA.id, { template: "custom", scope: "business", modules: { crm: { enabled: true, actions: ["view", "edit", "export"] } } }))).rejects.toMatchObject({ status: 403 });
    await expect(withBusiness(A.business.id, () => setUserPermissions(A.session, agentA.id, { template: "custom", scope: "own", modules: { telephony: { enabled: true, actions: ["use"] } } }))).rejects.toMatchObject({ code: "module_not_purchased" });
    expect((await settingsPATCH(await req(agentA, "/api/settings", "PATCH", { settings: {} }), ctx())).status).toBe(403);
  });

  it("a business owner cannot reach platform administration (API), and cannot make themselves a platform admin", async () => {
    for (const r of [await bizListGET(await req(A.session, "/api/platform/businesses"), ctx()), await bizGET(await req(A.session, `/api/platform/businesses/${B.business.id}`), ctx({ id: B.business.id })),
      await statusPOST(await req(A.session, `/api/platform/businesses/${A.business.id}/status`, "POST", { status: "active" }), ctx({ id: A.business.id })),
      await bizCreatePOST(await req(A.session, "/api/platform/businesses", "POST", { name: "עסק שלי", ownerEmail: "x@test.local" }), ctx()),
      await supportPOST(await req(A.session, `/api/platform/businesses/${B.business.id}/support`, "POST", { reason: "אני בעלים", minutes: 15 }), ctx({ id: B.business.id }))]) expect(r.status).toBe(403);
    const me = await json(await meGET(await req(A.session, "/api/auth/me"), ctx()));
    expect(me.body.data).toMatchObject({ platformAdmin: false, user: { role: "owner" } });
    await settingsPATCH(await req(A.session, "/api/settings", "PATCH", { isPlatformAdmin: true, settings: {} }), ctx());
    expect((await db.account.findUniqueOrThrow({ where: { id: A.account.id } })).isPlatformAdmin).toBe(false);
  });

  it("a person in two businesses has the right role in each (switcher lists only memberships)", async () => {
    const r = await switchPOST(await req(dualInA, "/api/auth/switch", "POST", { businessId: B.business.id }));
    expect((await r.json()).data).toMatchObject({ businessId: B.business.id, role: "owner" });
    const back = await switchPOST(await req(dualInB, "/api/auth/switch", "POST", { businessId: A.business.id }));
    expect((await back.json()).data).toMatchObject({ businessId: A.business.id, role: "agent" });
    expect((await switchPOST(await req(dualInA, "/api/auth/switch", "POST", { businessId: HOME.business.id }))).status).toBe(403);
  });

  it("platform admin: management data without content; support is explicit, read-only, time-boxed and audited", async () => {
    const list = await json(await bizListGET(await req(admin, "/api/platform/businesses"), ctx()));
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining([A.business.id, B.business.id]));
    const detail = await json(await bizGET(await req(admin, `/api/platform/businesses/${A.business.id}`), ctx({ id: A.business.id })));
    expect(detail.body.data).toMatchObject({ billing: { integration: null }, usage: expect.any(Object), health: expect.any(Object) });
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain("לקוחה של A"); expect(text).not.toContain("A-SECRET-TOKEN");

    expect((await supportPOST(await req(admin, `/api/platform/businesses/${A.business.id}/support`, "POST", { reason: "x", minutes: 15 }), ctx({ id: A.business.id }))).status).toBe(400);
    const start = await supportPOST(await req(admin, `/api/platform/businesses/${A.business.id}/support`, "POST", { reason: "בדיקת תקלה בחיבור WhatsApp לפי פנייה", minutes: 15 }), ctx({ id: A.business.id }));
    expect(start.status).toBe(200);
    const supportCookie = start.headers.get("set-cookie")!.split(";")[0];
    // Can read the business (for support)…
    const seen = await json(await contactsGET(await req(supportCookie, "/api/contacts"), ctx()));
    expect(seen.status).toBe(200); expect(JSON.stringify(seen.body)).toContain("לקוחה של A");
    const me = await json(await meGET(await req(supportCookie, "/api/auth/me"), ctx()));
    expect(me.body.data.support).toMatchObject({ businessName: A.business.name });
    // …but changes nothing, sends nothing, dials nothing, reveals nothing.
    expect(await json(await contactsPOST(await req(supportCookie, "/api/contacts", "POST", { fullName: "תמיכה", phone: "0541119999" }), ctx()))).toMatchObject({ status: 403, body: { code: "support_read_only" } });
    expect((await tokenPOST(await req(supportCookie, "/api/telephony/token", "POST"), ctx())).status).toBe(403);
    expect((await contactsGET(await req(supportCookie, "/api/contacts?reveal=1"), ctx())).status).toBe(403);
    // Not a member: not in the business's users, not in the switcher.
    const users = await db.user.findMany({ where: { businessId: A.business.id, isSupport: true } });
    expect(users).toHaveLength(1); expect(users[0].isActive).toBe(false);
    // Audited in the business and the platform logs.
    expect(await db.auditLog.count({ where: { businessId: A.business.id, action: "platform.support_started" } })).toBe(1);
    expect(await db.accessAuditLog.count({ where: { businessId: A.business.id, action: "support.started" } })).toBe(1);
    // Time-boxed: an expired session is out immediately.
    await db.supportSession.updateMany({ where: { businessId: A.business.id, endedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await contactsGET(await req(supportCookie, "/api/contacts"), ctx())).status).toBe(401);
    // A new session, then ending it returns the admin to their own business.
    const again = await supportPOST(await req(admin, `/api/platform/businesses/${A.business.id}/support`, "POST", { reason: "המשך בדיקה של החיבור", minutes: 15 }), ctx({ id: A.business.id }));
    const c2 = again.headers.get("set-cookie")!.split(";")[0];
    const end = await supportEndPOST(await req(c2, "/api/platform/support/end", "POST"));
    expect(end.status).toBe(200);
    expect(await db.supportSession.count({ where: { businessId: A.business.id, endedReason: "ended_by_admin" } })).toBe(1);
    expect((await contactsGET(await req(c2, "/api/contacts"), ctx())).status).toBe(401);
    // Revoking the platform role ends support access at once.
    const third = await supportPOST(await req(admin, `/api/platform/businesses/${B.business.id}/support`, "POST", { reason: "בדיקת הרשאות", minutes: 15 }), ctx({ id: B.business.id }));
    const c3 = third.headers.get("set-cookie")!.split(";")[0];
    await db.account.update({ where: { id: HOME.account.id }, data: { isPlatformAdmin: false } });
    expect((await contactsGET(await req(c3, "/api/contacts"), ctx())).status).toBe(401);
    await db.account.update({ where: { id: HOME.account.id }, data: { isPlatformAdmin: true } });
  });

  it("a new customer business starts empty: no data, connections or secrets copied; the owner joins by invite", async () => {
    const r = await json(await bizCreatePOST(await req(admin, "/api/platform/businesses", "POST", { name: "לקוח חדש בע\"מ", ownerName: "בעלת העסק", ownerEmail: `${crypto.randomUUID()}@test.local`, status: "trial", trialUntil: new Date(Date.now() + 14 * 86400_000).toISOString() }), ctx()));
    expect(r.status).toBe(200);
    const id = r.body.data.business.id; created.push(id);
    expect(r.body.data.inviteUrl).toContain("/invite/");
    const [contacts, creds, stores, users, biz] = await Promise.all([db.contact.count({ where: { businessId: id } }), db.providerCredential.count({ where: { businessId: id } }), db.storeConnection.count({ where: { businessId: id } }), db.user.findMany({ where: { businessId: id } }), db.business.findUniqueOrThrow({ where: { id } })]);
    expect({ contacts, creds, stores }).toEqual({ contacts: 0, creds: 0, stores: 0 });
    expect(biz).toMatchObject({ accessStatus: "trial", settings: {}, modules: { crm: true, telephony: false, whatsapp: false, sms: false, email: false } });
    expect(users).toHaveLength(1); expect(users[0]).toMatchObject({ role: "owner", isActive: false });
    const token = r.body.data.inviteUrl.split("/invite/")[1];
    const acc = await acceptInvite(token, "Strong-Pass-123");
    accounts.push(acc.accountId);
    expect((await db.user.findUniqueOrThrow({ where: { id: users[0].id } })).isActive).toBe(true);
    expect(await db.accessAuditLog.count({ where: { businessId: id, action: "business.created" } })).toBe(1);
  });

  it("lifecycle: suspension needs a reason and the typed name, keeps all data, stops outgoing work; renewal restores it", async () => {
    const contactsBefore = await db.contact.count({ where: { businessId: B.business.id } });
    const impact = await json(await statusGET(await req(admin, `/api/platform/businesses/${B.business.id}/status?status=suspended`), ctx({ id: B.business.id })));
    expect(impact.body.data).toMatchObject({ stops: true }); expect(impact.body.data.effects.join(" ")).toContain("לא נמחק");
    expect((await statusPOST(await req(admin, `/api/platform/businesses/${B.business.id}/status`, "POST", { status: "suspended" }), ctx({ id: B.business.id }))).status).toBe(400);
    expect((await statusPOST(await req(admin, `/api/platform/businesses/${B.business.id}/status`, "POST", { status: "suspended", reason: "חוב פתוח", confirmName: "שם אחר" }), ctx({ id: B.business.id }))).status).toBe(400);
    expect((await statusPOST(await req(admin, `/api/platform/businesses/${B.business.id}/status`, "POST", { status: "suspended", reason: "חוב פתוח", confirmName: B.business.name }), ctx({ id: B.business.id }))).status).toBe(200);
    invalidateEntitlement(B.business.id);
    expect(await businessCanUse(B.business.id, "crm")).toBe(false);
    expect(await withBusiness(B.business.id, () => deliverDueWebhooks(B.business.id))).toEqual({ processed: 0 });
    expect(await db.contact.count({ where: { businessId: B.business.id } })).toBe(contactsBefore);
    expect((await contactsPOST(await req(B.session, "/api/contacts", "POST", { fullName: "x", phone: "0541110777" }), ctx())).status).toBe(403);
    await statusPOST(await req(admin, `/api/platform/businesses/${B.business.id}/status`, "POST", { status: "active", reason: "שולם" }), ctx({ id: B.business.id }));
    invalidateEntitlement(B.business.id);
    expect(await businessCanUse(B.business.id, "crm")).toBe(true);
  });

  it("files stay isolated: another business's attachment is not found", async () => {
    const c = await db.contact.findFirstOrThrow({ where: { businessId: B.business.id } });
    const conv = await db.conversation.create({ data: { businessId: B.business.id, contactId: c.id, channel: "whatsapp" } });
    const m = await db.message.create({ data: { businessId: B.business.id, conversationId: conv.id, channel: "whatsapp", direction: "INBOUND", type: "DOCUMENT", status: "DELIVERED" } });
    const att = await db.messageAttachment.create({ data: { messageId: m.id, url: "/api/attachments/x", mimeType: "application/pdf", fileName: "b.pdf", sizeBytes: 10 } });
    expect([403, 404]).toContain((await attachmentGET(await req(A.session, `/api/attachments/${att.id}`), { params: Promise.resolve({ id: att.id }) })).status);
  });
});
