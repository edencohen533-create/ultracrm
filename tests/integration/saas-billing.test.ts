/**
 * SaaS billing acceptance (real DB, SANDBOX billing provider – no money, no card data): price book versions,
 * purchase → verified webhook → licenses, owner without an agent license, license transfer, proration, scheduled
 * reductions, duplicate / late / out-of-order webhooks (no double apply), failed renewal → retries → grace →
 * suspension (data kept) → recovery, cancellation, append-only usage ledger (one charge per key, adjustments,
 * unrated ≠ free, provider-billed not re-billed), budget cap with parallel reservations, two isolated businesses.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { effectiveAccess, invalidateEntitlement } from "@/lib/access/engine";
import { createVersion, ensureLaunchDraft, publishVersion, LAUNCH_ITEMS } from "@/server/billing/pricebook";
import * as billing from "@/server/billing/subscriptions";
import { setLicense } from "@/server/billing/licenses";
import { recordUsage, adjustUsage, usageSummary, invalidateRates } from "@/server/billing/usage";
import { reserveBudget, setPolicy, spentThisMonth } from "@/server/billing/budget";
import { deliverSandboxEvent, sandboxSign } from "@/server/billing/provider";
import { suppressContact } from "@/lib/suppression";
import { GET as billingGET } from "@/app/api/billing/route";
import { POST as webhookPOST } from "@/app/api/billing/webhooks/[provider]/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let agent1: SessionUser, agent2: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const DAY = 86400_000; void DAY;
const RUN = crypto.randomUUID().slice(0, 8);
async function pay(u: SessionUser, desired: Record<string, number>) {
  const q = await run(u, () => billing.quote(u.businessId, desired));
  return run(u, () => billing.checkout(u, { desired, idempotencyKey: crypto.randomUUID(), expectedTotalMinor: q.totalMinor }));
}
const sub = (biz: Biz) => db.subscription.findUniqueOrThrow({ where: { businessId: biz.business.id }, include: { items: true } });
const itemQty = async (biz: Biz, code: string) => (await sub(biz)).items.find((i) => i.code === code)?.quantity;

describe("SaaS billing", { timeout: 900_000 }, () => {
  let v1 = "";
  beforeAll(async () => {
    A = await createBusiness("bill-a", { modules: {} }); B = await createBusiness("bill-b", { modules: {} });
    accounts.push(A.account.id, B.account.id);
    for (const b of [A, B]) await db.business.update({ where: { id: b.business.id }, data: { accessStatus: "setup" } });
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    agent1 = await mk("נציג 1"); agent2 = await mk("נציג 2");
    // Price book: the launch draft (or an existing one) – tests publish their own version and restore afterwards.
    await ensureLaunchDraft();
    v1 = (await createVersion(A.account.id, { licenseItems: LAUNCH_ITEMS, usageRates: [], taxRateBps: 1800, note: "test v1" })).id;
  }, 600_000);
  afterAll(async () => {
    for (const b of [A, B]) if (b) await destroyBusiness(b.business.id).catch(() => undefined);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
    await db.priceBookVersion.deleteMany({ where: { note: { startsWith: "test " } } });
  }, 600_000);

  it("no published price book → no purchase; publishing does not reprice anything existing", async () => {
    await db.priceBookVersion.updateMany({ where: { status: "published" }, data: { status: "superseded" } });
    await expect(run(A.session, () => billing.quote(A.business.id, { crm: 1 }))).rejects.toMatchObject({ code: "no_price_book" });
    await publishVersion(v1);
    const q = await run(A.session, () => billing.quote(A.business.id, { crm: 2, dialer_ai: 1, marketing: 1 }));
    expect(q.subtotalMinor).toBe(2 * 4900 + 19900 + 9900);
    expect(q.taxMinor).toBe(Math.round(q.subtotalMinor * 0.18));
  });

  it("purchase is applied only after a VERIFIED provider payment; the business gets exactly what it bought", async () => {
    const q = await run(A.session, () => billing.quote(A.business.id, { crm: 2, dialer_ai: 1, marketing: 1 }));
    await expect(run(A.session, () => billing.checkout(A.session, { desired: { crm: 2, dialer_ai: 1, marketing: 1 }, idempotencyKey: "k-wrong", expectedTotalMinor: q.totalMinor - 1 }))).rejects.toMatchObject({ code: "quote_changed" });
    await expect(run(agent1, () => billing.checkout(agent1, { desired: { crm: 1 }, idempotencyKey: "k-agent", expectedTotalMinor: 5782 }))).rejects.toMatchObject({ code: "billing_forbidden" });
    const r = await run(A.session, () => billing.checkout(A.session, { desired: { crm: 2, dialer_ai: 1, marketing: 1 }, idempotencyKey: "k-first", expectedTotalMinor: q.totalMinor }));
    expect(r.checkoutUrl).toContain("/billing/sandbox/");
    // Same key again → same document (no second charge).
    const again = await run(A.session, () => billing.checkout(A.session, { desired: { crm: 2, dialer_ai: 1, marketing: 1 }, idempotencyKey: "k-first", expectedTotalMinor: q.totalMinor }));
    expect(again.document!.id).toBe(r.document!.id);
    invalidateEntitlement(A.business.id);
    expect((await effectiveAccess(A.business.id, A.user.id)).modules.telephony.state).toBe("not_in_package"); // nothing before payment
    // A forged / unsigned webhook is refused.
    const raw = JSON.stringify({ eventId: `forged-${RUN}`, type: "payment.succeeded", occurredAt: new Date().toISOString(), documentId: r.document!.id, providerPaymentRef: "x" });
    expect((await webhookPOST(new Request("http://localhost/x", { method: "POST", body: raw, headers: { "x-sandbox-timestamp": String(Math.floor(Date.now() / 1000)), "x-sandbox-signature": "0".repeat(64) } }), { params: Promise.resolve({ provider: "sandbox" }) })).status).toBe(401);
    // A signed success for a payment reference the provider never recorded is not trusted.
    const ts = String(Math.floor(Date.now() / 1000)); const fake = JSON.stringify({ eventId: `fake-ref-${RUN}`, type: "payment.succeeded", occurredAt: new Date().toISOString(), documentId: r.document!.id, providerPaymentRef: `never-recorded-${RUN}` });
    await webhookPOST(new Request("http://localhost/x", { method: "POST", body: fake, headers: { "x-sandbox-timestamp": ts, "x-sandbox-signature": sandboxSign(ts, fake) } }), { params: Promise.resolve({ provider: "sandbox" }) });
    expect((await db.billingDocument.findUniqueOrThrow({ where: { id: r.document!.id } })).status).toBe("open");
    // The provider's real success.
    const ev = await deliverSandboxEvent({ type: "payment.succeeded", documentId: r.document!.id, providerPaymentRef: `sbx_first-${RUN}`, paymentMethodRef: "sandbox_pm_ok", paymentMethodLabel: "•••• 4242", eventId: `evt-first-${RUN}` });
    expect(ev.result).toBe("applied");
    const s = await sub(A);
    expect(s.status).toBe("active"); expect(s.items.map((i) => [i.code, i.quantity]).sort()).toEqual([["crm", 2], ["dialer_ai", 1], ["marketing", 1]]);
    expect((await db.business.findUniqueOrThrow({ where: { id: A.business.id } })).accessStatus).toBe("active");
    invalidateEntitlement(A.business.id);
    const own = await effectiveAccess(A.business.id, A.user.id);
    // The owner manages / views / bills without a license, but doesn't dial or reply as an agent.
    expect(own.modules.telephony.actions).toEqual(expect.arrayContaining(["team_settings", "recordings"]));
    expect(own.modules.telephony.actions).not.toContain("use");
    expect(own.modules.sms.state).toBe("active");
    // Duplicate delivery / a second success / an older failure → nothing applied twice, nothing rolled back.
    expect((await deliverSandboxEvent({ type: "payment.succeeded", documentId: r.document!.id, providerPaymentRef: `sbx_first-${RUN}`, eventId: `evt-first-${RUN}` })).result).toBe("duplicate");
    expect((await deliverSandboxEvent({ type: "payment.succeeded", documentId: r.document!.id, providerPaymentRef: `sbx_first-${RUN}`, eventId: `evt-first-2-${RUN}` })).result).toBe("duplicate");
    expect((await deliverSandboxEvent({ type: "payment.failed", documentId: r.document!.id, occurredAt: new Date(Date.now() - 60_000), eventId: `evt-late-fail-${RUN}` })).result).toBe("stale");
    expect(await db.billingDocument.count({ where: { businessId: A.business.id } })).toBe(1);
    expect((await sub(A)).status).toBe("active");
  });

  it("licenses: one seat per person, moved between employees without a purchase; the owner needs one to work", async () => {
    await run(A.session, () => setLicense(A.session, { userId: agent1.id, module: "telephony", on: true }));
    await expect(run(A.session, () => setLicense(A.session, { userId: agent2.id, module: "telephony", on: true }))).rejects.toMatchObject({ code: "no_seats" });
    await run(A.session, () => setLicense(A.session, { userId: agent1.id, module: "telephony", on: false }));
    await run(A.session, () => setLicense(A.session, { userId: agent2.id, module: "telephony", on: true }));
    expect((await effectiveAccess(A.business.id, agent2.id)).modules.telephony.actions).toContain("use");
    expect((await effectiveAccess(A.business.id, agent1.id)).modules.telephony.state).toBe("not_assigned");
    await run(A.session, () => setLicense(A.session, { userId: A.user.id, module: "crm", on: true }));
    expect((await effectiveAccess(A.business.id, A.user.id)).modules.crm.actions).toContain("edit");
    await expect(run(agent1, () => setLicense(agent1, { userId: agent1.id, module: "crm", on: true }))).rejects.toMatchObject({ code: "billing_forbidden" });
  });

  it("adding mid-period is prorated and shown before confirming; reducing waits for the renewal (date shown)", async () => {
    const s = await sub(A);
    const half = new Date(s.currentPeriodStart!.getTime() + (s.currentPeriodEnd!.getTime() - s.currentPeriodStart!.getTime()) / 2);
    await db.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: new Date(Date.now() - (half.getTime() - s.currentPeriodStart!.getTime())), currentPeriodEnd: new Date(Date.now() + (s.currentPeriodEnd!.getTime() - half.getTime())) } });
    const q = await run(A.session, () => billing.quote(A.business.id, { dialer_ai: 2 }));
    expect(q.lines[0].chargeNowQty).toBe(1);
    expect(Math.abs(q.lines[0].chargeNowMinor - 9950)).toBeLessThanOrEqual(2); // ~half a month of 199 ₪
    const r = await pay(A.session, { dialer_ai: 2 }); // saved method → charged, verified webhook applies
    expect(r.checkoutUrl).toBeNull();
    expect(await itemQty(A, "dialer_ai")).toBe(2);
    // Reduction while 2 CRM licenses are in use? only the owner holds one → 2 → 1 is fine, scheduled only.
    await run(A.session, () => setLicense(A.session, { userId: agent1.id, module: "crm", on: true }));
    const red = await run(A.session, () => billing.quote(A.business.id, { crm: 1 }));
    expect(red.totalMinor).toBe(0); expect(red.reductionsEffectiveAt).toEqual((await sub(A)).currentPeriodEnd);
    await expect(pay(A.session, { crm: 1 })).rejects.toMatchObject({ code: "licenses_in_use" });
    await run(A.session, () => setLicense(A.session, { userId: agent1.id, module: "crm", on: false }));
    await pay(A.session, { crm: 1 });
    const it = (await sub(A)).items.find((i) => i.code === "crm")!;
    expect(it.quantity).toBe(2); expect(it.pendingQuantity).toBe(1);
  });

  it("failed renewal → retries → grace → suspension (data kept) → new card → recovered", async () => {
    const s = await sub(A);
    await db.subscription.update({ where: { id: s.id }, data: { paymentMethodRef: "sandbox_pm_fail_1", currentPeriodEnd: new Date(Date.now() - 1000) } });
    const contact = await db.contact.create({ data: { businessId: A.business.id, fullName: "נתון שנשמר", phoneE164: "+972501112233", phoneRaw: "x" } });
    const c1 = await billing.runBillingCycle();
    expect(c1.renewed).toBeGreaterThanOrEqual(1);
    let now = await sub(A);
    expect(now.status).toBe("past_due"); expect(now.graceUntil).not.toBeNull();
    expect(now.items.find((i) => i.code === "crm")!.quantity).toBe(1); // the scheduled reduction took effect at renewal
    const renewal = await db.billingDocument.findFirstOrThrow({ where: { businessId: A.business.id, kind: "renewal" } });
    expect(renewal.status).toBe("failed");
    // Running the cycle again doesn't create a second renewal document (idempotent per period).
    await billing.runBillingCycle();
    expect(await db.billingDocument.count({ where: { businessId: A.business.id, kind: "renewal" } })).toBe(1);
    const ov = await run(A.session, () => billing.billingOverview(A.session));
    expect(ov.notice?.text).toContain("השירות יוגבל");
    await db.subscription.update({ where: { id: s.id }, data: { graceUntil: new Date(Date.now() - 1000), nextRetryAt: null } });
    await billing.runBillingCycle();
    expect((await db.business.findUniqueOrThrow({ where: { id: A.business.id } })).accessStatus).toBe("suspended");
    expect(await db.contact.count({ where: { id: contact.id } })).toBe(1);
    // A working card: the method update triggers an immediate retry → paid → active again.
    await deliverSandboxEvent({ type: "payment_method.updated", businessId: A.business.id, paymentMethodRef: "sandbox_pm_ok_2", paymentMethodLabel: "•••• 4242" });
    await billing.runBillingCycle();
    now = await sub(A);
    expect(now.status).toBe("active");
    expect((await db.business.findUniqueOrThrow({ where: { id: A.business.id } })).accessStatus).toBe("active");
    expect((await db.billingDocument.findUniqueOrThrow({ where: { id: renewal.id } })).status).toBe("paid");
  });

  it("usage ledger: one charge per key, append-only, adjustments, unrated ≠ free, provider-billed not re-billed", async () => {
    const at = new Date();
    const base = { businessId: A.business.id, module: "telephony", service: "call_minute", unit: "minute", occurredAt: at } as const;
    expect(await run(A.session, () => recordUsage({ ...base, idempotencyKey: "call:x:minutes", quantity: 2.5, billedQuantity: 3 }))).toBe(true);
    expect(await run(A.session, () => recordUsage({ ...base, idempotencyKey: "call:x:minutes", quantity: 2.5, billedQuantity: 3 }))).toBe(false); // retry = no second charge
    await run(A.session, () => recordUsage({ ...base, idempotencyKey: "call:x:minutes:attempt:2", quantity: 0.1, kind: "cost_only", providerCostMinor: 3 }));
    const row = await db.usageEvent.findFirstOrThrow({ where: { businessId: A.business.id, idempotencyKey: "call:x:minutes" } });
    expect(row).toMatchObject({ status: "unrated", priceMinor: null }); // no rate in this price book → never "free"
    await expect(db.usageEvent.update({ where: { id: row.id }, data: { quantity: 1 } })).rejects.toThrow(/append-only/);
    await expect(db.usageEvent.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await adjustUsage(row.id, { quantityDelta: -0.5, priceDeltaMinor: null, reason: "provider CDR shorter", key: "call:x:minutes:adj1" });
    await run(A.session, () => recordUsage({ businessId: A.business.id, module: "whatsapp", service: "whatsapp_message", unit: "message", occurredAt: at, idempotencyKey: "msg:w1", quantity: 1, billedByProvider: true, status: "not_billable" }));
    const summ = await run(A.session, () => usageSummary(A.business.id));
    expect(summ.unratedEvents).toBeGreaterThanOrEqual(1);
    expect(summ.lines.find((l) => l.service === "whatsapp_message")).toMatchObject({ billedByProvider: true, priceMinor: null });
  });

  it("budget: unrated service can't be used commercially; the cap holds under parallel reservations; opt-outs still work", async () => {
    await expect(run(A.session, () => reserveBudget(A.business.id, { service: "call_minute", units: 1, key: "r0" }))).rejects.toMatchObject({ code: "service_unrated" });
    const v2 = await createVersion(A.account.id, { licenseItems: LAUNCH_ITEMS, usageRates: [{ service: "call_minute", unit: "minute", unitPriceMinor: 100, billingIncrementSec: 60 }], taxRateBps: 1800, note: "test v2 rates" });
    await db.subscription.update({ where: { businessId: A.business.id }, data: { priceBookVersionId: v2.id } }); invalidateRates(A.business.id);
    const used = (await run(A.session, () => spentThisMonth(A.business.id))).usedMinor;
    await run(A.session, () => setPolicy(A.business.id, A.user.id, { monthlyCapMinor: used + 1000, alertPercents: [50, 80, 100], hardStop: true }));
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => run(A.session, () => reserveBudget(A.business.id, { service: "call_minute", units: 1, key: `par-${i}` }))));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(10); // 10 × 100 = the cap, never more
    const rej = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toMatchObject({ code: "budget_exceeded" });
    // An opt-out request is never blocked by the budget.
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "מבקש הסרה", phoneE164: "+972501119999", phoneRaw: "x" } });
    await run(A.session, () => suppressContact({ businessId: A.business.id, contactId: c.id, scope: "all", source: "whatsapp", kind: "unsubscribe" }));
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).isBlocked).toBe(true);
  });

  it("cancellation ends at the period end – data kept, business 'cancelled'; other businesses see nothing", async () => {
    await run(A.session, () => billing.cancel(A.session));
    await db.subscription.update({ where: { businessId: A.business.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await billing.runBillingCycle();
    expect((await sub(A)).status).toBe("canceled");
    const b = await db.business.findUniqueOrThrow({ where: { id: A.business.id } });
    expect(b.accessStatus).toBe("cancelled"); expect(await db.contact.count({ where: { businessId: A.business.id } })).toBeGreaterThan(0);
    const res = await billingGET(new NextRequest("http://localhost/api/billing", { headers: { cookie: `ultracrm_session=${await signSession(B.session)}` } }), { params: Promise.resolve({}) });
    const j = await res.json();
    expect(j.data.subscription).toBeNull(); expect(JSON.stringify(j)).not.toContain(A.business.id);
  });

  it("without a provider (production, sandbox off) nothing can be purchased", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PLATFORM_BILLING_SANDBOX", "");
    await expect(pay(B.session, { crm: 1 })).rejects.toMatchObject({ code: "billing_provider_missing" });
    vi.unstubAllEnvs();
  });
});
