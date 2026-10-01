/**
 * Settings → package → "ניהול מודולים" (POST /api/platform/businesses/:id/modules), end to end on the real DB:
 *  • platform admin only (a business owner can't change their own package – request only);
 *  • preview changes nothing; confirm saves for THAT business only (another business unchanged);
 *  • removing a module closes it on the server (direct API call → 403), user permissions can't reopen it, and its
 *    data is kept; adding it back makes the data reachable again for users allowed by their permissions;
 *  • a module that comes from the pinned package version can't be switched off here (blocked, explained);
 *    an add-on grant is added / revoked; a paid subscription blocks every switch;
 *  • the upgrade request (non-admin) is recorded and changes nothing.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { effectiveAccess, invalidateEntitlement, businessEntitlement } = await import("@/lib/access/engine");
const modulesRoute = await import("@/app/api/platform/businesses/[id]/modules/route");
const { GET: convGET } = await import("@/app/api/conversations/route");
const { POST: upgradePOST } = await import("@/app/api/access/upgrade-request/route");

type Biz = Awaited<ReturnType<typeof createBusiness>>;
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const req = async (u: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (u: SessionUser, biz: string, body: unknown) => { const r = await modulesRoute.POST(await req(u, `/api/platform/businesses/${biz}/modules`, "POST", body), ctx({ id: biz })); return { status: r.status, body: await r.json() }; };
const included = async (biz: string) => { invalidateEntitlement(biz); return Object.fromEntries(Object.entries((await businessEntitlement(biz)).modules).map(([k, v]) => [k, v.included])); };

describe("business modules dialog", { timeout: 300_000 }, () => {
  let A: Biz, B: Biz, P: Biz; let platform: SessionUser, manager: SessionUser;
  const accounts: string[] = []; let planId = ""; let convId = "";
  beforeAll(async () => {
    A = await createBusiness("mods-a", { modules: { crm: true, telephony: true, whatsapp: true, sms: true, email: true } });
    B = await createBusiness("mods-b", { modules: { crm: true, telephony: true, whatsapp: true, sms: true, email: true } });
    P = await createBusiness("mods-plan");
    const pa = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "פלטפורמה", passwordHash: "x", isPlatformAdmin: true } }); accounts.push(pa.id);
    const pu = await db.user.create({ data: { businessId: B.business.id, accountId: pa.id, email: pa.email, fullName: "פלטפורמה", role: "owner" } });
    platform = { id: pu.id, accountId: pa.id, businessId: B.business.id, email: pa.email, fullName: "פלטפורמה", role: "owner", teamId: null };
    const ma = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "מנהלת", passwordHash: "x" } }); accounts.push(ma.id);
    // A manager whose own permissions explicitly enable WhatsApp
    const mu = await db.user.create({ data: { businessId: A.business.id, accountId: ma.id, email: ma.email, fullName: "מנהלת", role: "manager", permissions: { template: "custom", scope: "business", modules: { crm: { enabled: true, actions: ["view"] }, whatsapp: { enabled: true, actions: ["view", "reply"] } } } } as never });
    manager = { id: mu.id, accountId: ma.id, businessId: A.business.id, email: ma.email, fullName: "מנהלת", role: "manager", teamId: null };
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "לקוחה", phoneE164: "+972501112233", phoneRaw: "x" } });
    convId = (await db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, channel: "whatsapp" } })).id;
    // P: pinned package version with CRM + WhatsApp
    const plan = await db.plan.create({ data: { key: `mods_${crypto.randomUUID().slice(0, 8)}`, name: "חבילת בדיקה", currentVersion: 1 } }); planId = plan.id;
    const v = await db.planVersion.create({ data: { planId, version: 1, name: "חבילת בדיקה", modules: { crm: { included: true, seats: null }, whatsapp: { included: true, seats: null } }, quotas: {} } });
    await db.business.update({ where: { id: P.business.id }, data: { planId, planVersionId: v.id } });
  });
  afterAll(async () => {
    for (const b of [A, B, P]) if (b) { await db.entitlementGrant.deleteMany({ where: { businessId: b.business.id } }); await db.subscriptionItem.deleteMany({ where: { businessId: b.business.id } }).catch(() => undefined); await db.subscription.deleteMany({ where: { businessId: b.business.id } }).catch(() => undefined); await destroyBusiness(b.business.id, [b.account.id]); }
    await db.planVersion.deleteMany({ where: { planId } }); await db.plan.deleteMany({ where: { id: planId } });
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  });

  it("only the platform admin can change modules; a business owner gets 403 (request only, recorded, nothing changes)", async () => {
    expect((await call(A.session, A.business.id, { modules: { whatsapp: false }, confirm: true })).status).toBe(403);
    expect((await call(manager, A.business.id, { modules: { whatsapp: false } })).status).toBe(403);
    const r = await upgradePOST(await req(A.session, "/api/access/upgrade-request", "POST", { modules: ["telephony"], note: "רוצים חייגן" }), ctx());
    expect(r.status).toBe(200);
    expect((await included(A.business.id)).whatsapp).toBe(true);
  });

  it("preview changes nothing; confirm removes WhatsApp for A only; server blocks it; permissions can't reopen it; data kept", async () => {
    expect((await convGET(await req(manager, "/api/conversations"))).status).toBe(200);
    const pv = await call(platform, A.business.id, { modules: { whatsapp: false } });
    expect(pv.status).toBe(200);
    expect(pv.body.data).toMatchObject({ changes: [{ module: "whatsapp", to: false }], blocked: [] });
    expect(pv.body.data.impact.modulesRemoved).toEqual(["whatsapp"]);
    expect((await included(A.business.id)).whatsapp).toBe(true); // preview only
    const ap = await call(platform, A.business.id, { modules: { whatsapp: false }, confirm: true });
    expect(ap.status).toBe(200);
    expect((await included(A.business.id)).whatsapp).toBe(false);
    expect((await included(B.business.id)).whatsapp).toBe(true); // another business untouched
    expect((await db.business.findUniqueOrThrow({ where: { id: A.business.id } })).modules).toMatchObject({ whatsapp: false });
    // Server-side: a direct API call is refused for the owner AND for a manager whose permissions enable WhatsApp
    expect((await convGET(await req(A.session, "/api/conversations"))).status).toBe(403);
    expect((await convGET(await req(manager, "/api/conversations"))).status).toBe(403);
    expect((await effectiveAccess(A.business.id, manager.id)).modules.whatsapp.state).not.toBe("active");
    // Nothing deleted
    expect(await db.conversation.count({ where: { id: convId } })).toBe(1);
  });

  it("adding WhatsApp back: the owner reaches the kept data; the manager's closed permission isn't reopened by itself", async () => {
    const ap = await call(platform, A.business.id, { modules: { whatsapp: true }, confirm: true });
    expect(ap.status).toBe(200);
    expect((await included(A.business.id)).whatsapp).toBe(true);
    const r = await convGET(await req(A.session, "/api/conversations"));
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain(convId);
    expect((await convGET(await req(manager, "/api/conversations"))).status).toBe(403); // re-enable explicitly in permissions
  });

  it("pinned package: a module of the version is blocked (explained); an add-on grant is added and revoked", async () => {
    const off = await call(platform, P.business.id, { modules: { whatsapp: false } });
    expect(off.body.data.blocked).toEqual([expect.objectContaining({ module: "whatsapp" })]);
    expect((await call(platform, P.business.id, { modules: { whatsapp: false }, confirm: true })).status).toBe(409);
    expect((await included(P.business.id)).whatsapp).toBe(true);
    expect((await call(platform, P.business.id, { modules: { sms: true }, confirm: true })).status).toBe(200);
    expect((await included(P.business.id)).sms).toBe(true);
    expect(await db.entitlementGrant.count({ where: { businessId: P.business.id, module: "sms", kind: "addon", revokedAt: null } })).toBe(1);
    expect((await call(platform, P.business.id, { modules: { sms: false }, confirm: true })).status).toBe(200);
    expect((await included(P.business.id)).sms).toBe(false);
    expect(await db.entitlementGrant.count({ where: { businessId: P.business.id, module: "sms", revokedAt: { not: null } } })).toBe(1); // kept as history
  });

  it("a paid subscription defines the modules – every switch is blocked", async () => {
    const sub = await db.subscription.create({ data: { businessId: P.business.id, status: "active" } });
    await db.subscriptionItem.create({ data: { businessId: P.business.id, subscriptionId: sub.id, code: "crm_base", module: "crm", kind: "per_business", quantity: 1, unitPriceMinor: 0 } } as never);
    invalidateEntitlement(P.business.id);
    const r = await call(platform, P.business.id, { modules: { email: true } });
    expect(r.body.data.blocked).toEqual([expect.objectContaining({ module: "email" })]);
  });
});
