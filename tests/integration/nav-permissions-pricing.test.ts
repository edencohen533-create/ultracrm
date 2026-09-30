/**
 * Owner-only CRM areas, permission management and per-business custom pricing (real DB, test businesses only –
 * no real business's prices are touched, nothing is charged: renewals run without a payment method):
 *  • "ממתינים לשיחה היום" / "לידים לפי נציג": the owner sees the business; a manager or an agent only themselves,
 *    also when the request is crafted by hand (another agent / "unassigned" → 403);
 *  • distribution / statuses: owner only through the API; the distribution policy isn't returned to others;
 *  • permissions: nobody edits their own; a manager can't grant what they don't have or touch a manager; roles are
 *    changed by the owner only;
 *  • pricing: the fixed order (custom price → one discount → credits → VAT), never negative, credit remainder carried;
 *    platform admin only; preview must match; no retroactive change; versions append-only; a renewal applies a
 *    ₪50 monthly discount and a credit and consumes the credit once; custom usage rate used for new usage.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact } from "@/lib/crm/contacts";
import { createLead, listLeads } from "@/lib/crm/pipeline";
import { waitingToday } from "@/lib/crm/lead-ops";
import { setUserPermissions } from "@/lib/access/manage";
import { price, previewPricing, savePricing, addCredit, EMPTY_TERMS } from "@/server/billing/pricing";
import { runBillingCycle } from "@/server/billing/subscriptions";
import { ratesFor, invalidateRates } from "@/server/billing/usage";
import { GET as waitingGET } from "@/app/api/leads/waiting/route";
import { GET as statusesGET } from "@/app/api/lead-statuses/route";
import { PATCH as userPATCH } from "@/app/api/users/[id]/route";
import { GET as pricingGET, POST as pricingPOST } from "@/app/api/platform/businesses/[id]/pricing/route";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz; let manager: SessionUser, agent: SessionUser, agent2: SessionUser, platform: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const req = async (u: SessionUser, url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(u)}` } });
const api = async (u: SessionUser, fn: (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) =>
  withBusiness(u.businessId, async () => { const r = await fn(await req(u, url, method, body), { params: Promise.resolve(params) }); return { status: r.status, body: await r.json() }; }, u);

describe("owner-only CRM areas, permissions, custom pricing", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("navperm", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id);
    const mk = async (name: string, role: "agent" | "manager", platformAdmin = false) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date(), isPlatformAdmin: platformAdmin } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser; };
    manager = await mk("מנהלת", "manager"); agent = await mk("נציג", "agent"); agent2 = await mk("נציגה", "agent");
    platform = await mk("מנהל פלטפורמה", "agent", true);
    for (const [owner, i] of [[agent.id, 1], [agent2.id, 2], [manager.id, 3]] as const) {
      const c = await run(A.session, () => createContact(A.session, { fullName: `ליד ${i}`, phone: `05288${String(10000 + i + (Date.now() % 9000)).slice(-5)}` }));
      await run(A.session, () => createLead(A.session, { contactId: c.id, ownerUserId: owner }));
    }
  }, 300_000);
  afterAll(async () => { if (A) { await withoutBusiness(async () => { await db.billingDocument.deleteMany({ where: { businessId: A.business.id } }); await db.subscriptionItem.deleteMany({ where: { businessId: A.business.id } }); await db.subscription.deleteMany({ where: { businessId: A.business.id } }); await db.billingCredit.deleteMany({ where: { businessId: A.business.id } }); await db.$executeRawUnsafe(`ALTER TABLE business_pricing DISABLE TRIGGER business_pricing_no_update`); await db.businessPricing.deleteMany({ where: { businessId: A.business.id } }); await db.$executeRawUnsafe(`ALTER TABLE business_pricing ENABLE TRIGGER business_pricing_no_update`); await db.accessAuditLog.deleteMany({ where: { businessId: A.business.id } }); }); await destroyBusiness(A.business.id); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("'ממתינים לשיחה היום' and 'לידים לפי נציג': owner = business, everyone else = only themselves (API too)", async () => {
    const all = await run(A.session, () => waitingToday(A.session, null));
    expect(all.counts.total).toBe(3);
    expect((await run(manager, () => waitingToday(manager, null))).counts.total).toBe(1); // own only, not the team / business
    await expect(run(manager, () => waitingToday(manager, agent.id))).rejects.toMatchObject({ status: 403 });
    expect((await api(manager, waitingGET, "/api/leads/waiting?agent=unassigned")).status).toBe(403);
    expect((await api(agent, waitingGET, `/api/leads/waiting?agent=${agent2.id}`)).status).toBe(403);
    expect((await api(agent, waitingGET, "/api/leads/waiting")).body.data.counts.total).toBe(1);
    const mine = await run(manager, () => listLeads(manager, { page: 1, limit: 30, sort: "createdAt", direction: "desc" } as never));
    expect(mine.byOwner.map((o) => o.id)).toEqual([manager.id]);
    const owner = await run(A.session, () => listLeads(A.session, { page: 1, limit: 30, sort: "createdAt", direction: "desc" } as never));
    expect(owner.byOwner.length).toBe(3);
    // The distribution policy is not returned to a manager.
    expect((await api(manager, statusesGET, "/api/lead-statuses")).body.data.leadAssignment).toBeNull();
  });

  it("permissions: no self-edit, no granting what you don't have, managers don't manage managers, roles by the owner only", async () => {
    await expect(run(manager, () => setUserPermissions(manager, manager.id, { template: "custom", scope: "business", modules: {} }))).rejects.toMatchObject({ code: "self_escalation" });
    await expect(run(manager, () => setUserPermissions(manager, A.user.id, { template: "custom", scope: "own", modules: {} }))).rejects.toMatchObject({ status: 400 });
    await expect(run(agent, () => setUserPermissions(agent, agent2.id, { template: "custom", scope: "own", modules: {} }))).rejects.toMatchObject({ status: 403 });
    // A manager tries to make an agent an owner / manager through the API → refused (owner only).
    expect((await api(manager, userPATCH, `/api/users/${agent.id}`, "PATCH", { role: "owner" }, { id: agent.id })).status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: agent.id } })).role).toBe("agent");
  });

  it("pricing order: custom price → one discount → credits → VAT; never negative; credit remainder carried", () => {
    const base = [{ code: "crm", name: "CRM", quantity: 2, unitPriceMinor: 4900 }];
    const start = new Date("2026-10-01T00:00:00Z");
    const d50 = { type: "fixed" as const, amountMinor: 5000, startsAt: "2026-09-01T00:00:00.000Z", endsAt: null };
    let p = price(base, { ...EMPTY_TERMS, discount: d50 }, [], 1800, start);
    expect(p).toMatchObject({ licensesMinor: 9800, discountMinor: 5000, netMinor: 4800, taxMinor: 864, totalMinor: 5664 });
    p = price(base, { ...EMPTY_TERMS, licensePrices: { crm: 3000 }, discount: { type: "percent", bps: 1000, startsAt: "2026-09-01T00:00:00.000Z" } }, [], 1800, start);
    expect(p).toMatchObject({ licensesMinor: 6000, discountMinor: 600, netMinor: 5400 });
    expect(p.lines[0].basePriceMinor).toBe(4900);
    // A discount larger than the licenses and a big credit → 0, the credit's remainder stays.
    p = price(base, { ...EMPTY_TERMS, discount: { ...d50, amountMinor: 20000 } }, [{ id: "c1", remainingMinor: 3000 }], 1800, start);
    expect(p).toMatchObject({ discountMinor: 9800, creditMinor: 0, netMinor: 0, totalMinor: 0 });
    p = price(base, EMPTY_TERMS, [{ id: "c1", remainingMinor: 3000 }, { id: "c2", remainingMinor: 9000 }], 1800, start);
    expect(p.creditUse).toEqual([{ id: "c1", amountMinor: 3000 }, { id: "c2", amountMinor: 6800 }]);
    expect(p.netMinor).toBe(0);
    // A discount that hasn't started / has ended doesn't apply.
    expect(price(base, { ...EMPTY_TERMS, discount: { ...d50, startsAt: "2026-11-01T00:00:00.000Z" } }, [], 1800, start).discountMinor).toBe(0);
    expect(price(base, { ...EMPTY_TERMS, discount: { ...d50, endsAt: "2026-09-15T00:00:00.000Z" } }, [], 1800, start).discountMinor).toBe(0);
  });

  it("platform admin only; preview must match; no retroactive change; versions append-only; renewal applies ₪50 discount + credit once", async () => {
    expect((await api(A.session, pricingGET, `/api/platform/businesses/${A.business.id}/pricing`, "GET", undefined, { id: A.business.id })).status).toBe(403);
    expect((await api(manager, pricingPOST, `/api/platform/businesses/${A.business.id}/pricing`, "POST", {}, { id: A.business.id })).status).toBe(403);
    // A test subscription (no payment method → nothing is charged), period ended → renewal due.
    const pb = await withoutBusiness(() => db.priceBookVersion.findFirstOrThrow({ orderBy: { version: "asc" } }));
    await withoutBusiness(() => db.priceBookVersion.update({ where: { id: pb.id }, data: { status: "published" } }));
    try {
      const sub = await withoutBusiness(() => db.subscription.create({ data: { businessId: A.business.id, status: "active", priceBookVersionId: pb.id, provider: "sandbox", currentPeriodStart: new Date(Date.now() - 31 * 86400_000), currentPeriodEnd: new Date(Date.now() - 60_000), items: { create: [{ businessId: A.business.id, code: "crm", module: "crm", kind: "per_license", quantity: 2, unitPriceMinor: 4900 }] } } as never }));
      const terms = { ...EMPTY_TERMS, discount: { type: "fixed" as const, amountMinor: 5000, startsAt: new Date(Date.now() - 86400_000).toISOString(), endsAt: null, note: "הנחת פיילוט" } };
      const pv = await previewPricing(A.business.id, terms);
      expect(pv.after).toMatchObject({ licensesMinor: 9800, discountMinor: 5000, totalMinor: 5664 });
      expect(pv.deltaMinor).toBe(5664 - 11564);
      await expect(savePricing(platform, A.business.id, { terms, effectiveFrom: new Date().toISOString(), expectedTotalMinor: 1 })).rejects.toMatchObject({ code: "preview_changed" });
      await expect(savePricing(platform, A.business.id, { terms, effectiveFrom: new Date(Date.now() - 86400_000).toISOString(), expectedTotalMinor: 5664 })).rejects.toMatchObject({ code: "retroactive" });
      const saved = await api(platform, pricingPOST, `/api/platform/businesses/${A.business.id}/pricing`, "POST", { terms, effectiveFrom: new Date(Date.now() - 4 * 60_000).toISOString(), expectedTotalMinor: 5664 }, { id: A.business.id });
      expect(saved.status).toBe(201); expect(saved.body.data.version).toBe(1);
      await expect(withoutBusiness(() => db.businessPricing.updateMany({ where: { businessId: A.business.id }, data: { note: "x" } }))).rejects.toThrow();
      await addCredit(platform, A.business.id, { amountMinor: 1000, reason: "פיצוי תקלה" });
      await runBillingCycle(new Date());
      const doc = await withoutBusiness(() => db.billingDocument.findFirstOrThrow({ where: { subscriptionId: sub.id, kind: "renewal" } }));
      expect(doc).toMatchObject({ subtotalMinor: 3800, taxMinor: 684, totalMinor: 4484 });
      const lines = doc.lines as Array<{ code: string; amountMinor: number }>;
      expect(lines.map((l) => l.code)).toEqual(["crm", "discount", "credit"]);
      expect(lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(3800);
      const credit = await withoutBusiness(() => db.billingCredit.findFirstOrThrow({ where: { businessId: A.business.id } }));
      expect(credit.remainingMinor).toBe(0);
      // Running the cycle again issues nothing new and uses no credit twice.
      await runBillingCycle(new Date());
      expect(await withoutBusiness(() => db.billingDocument.count({ where: { subscriptionId: sub.id, kind: "renewal" } }))).toBe(1);
      expect(await withoutBusiness(() => db.accessAuditLog.count({ where: { businessId: A.business.id, action: { startsWith: "pricing." } } }))).toBe(2);
      // Custom usage rate for new usage (a service the price book doesn't price).
      await savePricing(platform, A.business.id, { terms: { ...terms, usageRates: { sms_segment: 12 } }, effectiveFrom: new Date(Date.now() - 60_000).toISOString(), expectedTotalMinor: (await previewPricing(A.business.id, { ...terms, usageRates: { sms_segment: 12 } })).after.totalMinor });
      invalidateRates(A.business.id);
      const r = await ratesFor(A.business.id);
      expect(r?.rates.find((x) => x.service === "sms_segment")?.unitPriceMinor).toBe(12);
    } finally {
      await withoutBusiness(() => db.priceBookVersion.update({ where: { id: pb.id }, data: { status: pb.status } }));
    }
  });
});
