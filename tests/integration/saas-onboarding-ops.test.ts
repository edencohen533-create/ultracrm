/**
 * SaaS onboarding + operations acceptance (real DB, SANDBOX billing, SIMULATED telephony – no real payment / call):
 * signup → isolated business with nothing included → purchase + verified payment → licenses → number → agent →
 * lead → test call → documented → usage appears → checklist complete; the other business sees none of it.
 * Plus: support ticket without secrets, deduplicated ops alerts, provider reconciliation findings, export ZIP,
 * offboarding (stop future actions, cancel ≠ delete), restore mode refuses jobs / dials / charges.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { signup } from "@/server/onboarding/signup";
import { onboardingChecklist } from "@/server/onboarding/checklist";
import { createVersion, publishVersion, LAUNCH_ITEMS } from "@/server/billing/pricebook";
import * as billing from "@/server/billing/subscriptions";
import { setLicense } from "@/server/billing/licenses";
import { meterBusiness, usageSummary } from "@/server/billing/usage";
import { deliverSandboxEvent } from "@/server/billing/provider";
import { effectiveAccess, invalidateEntitlement } from "@/lib/access/engine";
import { startCall, reconcileCall, saveOutcome } from "@/lib/dialer/calls";
import { createTicket } from "@/server/ops/support";
import { runOpsChecks } from "@/server/ops/monitor";
import { runReconciliation } from "@/server/billing/reconcile";
import { exportBusiness } from "@/server/offboarding/export";
import { offboardingOverview, stopFutureActions } from "@/server/offboarding/offboarding";
import { requireCronSecret } from "@/lib/api";

let owner: SessionUser, agent: SessionUser, other: Awaited<ReturnType<typeof createBusiness>>; let businessId = "";
const accounts: string[] = []; const RUN = crypto.randomUUID().slice(0, 8);
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);

describe("SaaS onboarding and operations", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    other = await createBusiness("onb-other", { modules: { crm: true, telephony: true } }); accounts.push(other.account.id);
    const v = await createVersion(other.account.id, { licenseItems: LAUNCH_ITEMS, usageRates: [{ service: "call_minute", unit: "minute", unitPriceMinor: 30, billingIncrementSec: 60 }, { service: "phone_number_month", unit: "number_month", unitPriceMinor: 2000 }], taxRateBps: 1800, note: "test onboarding" });
    await publishVersion(v.id);
  }, 600_000);
  afterAll(async () => {
    for (const id of [businessId, other?.business.id].filter(Boolean)) { await db.call.deleteMany({ where: { businessId: id } }); await destroyBusiness(id).catch(() => undefined); }
    await db.account.deleteMany({ where: { id: { in: accounts } } });
    await db.priceBookVersion.deleteMany({ where: { note: { startsWith: "test " } } });
  }, 600_000);

  it("signup → an isolated business with nothing included until a verified payment", async () => {
    const r = await signup({ businessName: `QA מוקד ${RUN}`, fullName: "בעלת המוקד", email: `onb-${RUN}@test.local`, password: "Testpass123", acceptTerms: true, path: "own_crm" }, `10.0.0.${Math.floor(Math.random() * 200)}`);
    businessId = r.business.id; accounts.push(r.account.id);
    owner = { id: r.user.id, accountId: r.account.id, businessId, email: r.account.email, fullName: r.account.fullName, role: "owner", teamId: null };
    await expect(signup({ businessName: "עסק שני", fullName: "משתמש אחר", email: `onb-${RUN}@test.local`, password: "Testpass123", acceptTerms: true }, "10.9.9.9")).rejects.toMatchObject({ code: "account_exists" });
    const acc = await effectiveAccess(businessId, owner.id);
    expect(Object.values(acc.modules).every((m) => m.state === "not_in_package")).toBe(true); // never the legacy "everything"
    expect(await db.contact.count({ where: { businessId } })).toBe(0);
    const c = await run(owner, () => onboardingChecklist(owner));
    expect(c.ready).toBe(false); expect(c.steps.find((s) => s.key === "plan")!.done).toBe(false);
  });

  it("full setup to a test call, and the usage shows in the account", async () => {
    const desired = { crm: 1, dialer_ai: 1 };
    const q = await run(owner, () => billing.quote(businessId, desired));
    const r = await run(owner, () => billing.checkout(owner, { desired, idempotencyKey: `onb-${RUN}`, expectedTotalMinor: q.totalMinor }));
    await deliverSandboxEvent({ type: "payment.succeeded", documentId: r.document!.id, providerPaymentRef: `sbx-onb-${RUN}`, paymentMethodRef: "sandbox_pm_ok", paymentMethodLabel: "•••• 4242" });
    expect((await db.business.findUniqueOrThrow({ where: { id: businessId } })).accessStatus).toBe("active");
    await db.phoneNumber.create({ data: { businessId, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock", isDefault: true, verificationStatus: "verified" } });
    const acc = await db.account.create({ data: { email: `onb-agent-${RUN}@test.local`, fullName: "נציג ראשון", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId, accountId: acc.id, email: acc.email, fullName: "נציג ראשון", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId, email: acc.email, fullName: u.fullName, role: "agent", teamId: null };
    await run(owner, () => setLicense(owner, { userId: agent.id, module: "telephony", on: true }));
    await run(owner, () => setLicense(owner, { userId: agent.id, module: "crm", on: true }));
    invalidateEntitlement(businessId);
    expect((await effectiveAccess(businessId, agent.id)).modules.telephony.actions).toContain("use");
    // A lead (test data) and a test call in SIMULATION – the "…1" number ends as busy after a few seconds.
    const contact = await db.contact.create({ data: { businessId, fullName: "ליד בדיקה", phoneE164: "+972500000001", phoneRaw: "x" } });
    await db.lead.create({ data: { businessId, contactId: contact.id, ownerUserId: agent.id } });
    const call = await run(agent, () => startCall(agent, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: contact.id }));
    for (let i = 0; i < 40; i++) { const c = await run(owner, () => reconcileCall(call.id)); if (c?.endedAt) break; await new Promise((x) => setTimeout(x, 1000)); }
    await run(agent, () => saveOutcome(agent, { callId: call.id, outcome: "busy" }));
    // A little talk time so the call is billable (simulation busy calls have none).
    await db.call.update({ where: { id: call.id }, data: { answeredAt: new Date(Date.now() - 90_000), talkSeconds: 75 } });
    await run(owner, () => meterBusiness(businessId));
    const usage = await run(owner, () => usageSummary(businessId));
    const minutes = usage.lines.find((l) => l.service === "call_minute")!;
    expect(minutes).toMatchObject({ billedQuantity: 2, priceMinor: 60, status: "estimated" }); // 75s → 2 billed minutes × 30
    expect(usage.lines.find((l) => l.service === "phone_number_month")!.priceMinor).toBe(2000);
    await run(owner, () => meterBusiness(businessId)); // re-run: nothing charged twice
    expect(await db.usageEvent.count({ where: { businessId, service: "call_minute" } })).toBe(1);
    const c = await run(owner, () => onboardingChecklist(owner));
    expect(c.steps.filter((s) => s.required && !s.done).map((s) => s.key)).toEqual([]);
    expect(c.ready).toBe(true);
    // The other business sees none of it.
    expect(await withBusiness(other.business.id, () => db.usageEvent.count({ where: { businessId } }), other.session)).toBe(0);
    expect((await withBusiness(other.business.id, () => usageSummary(other.business.id), other.session)).lines).toEqual([]);
  });

  it("support ticket: incident code, context without secrets", async () => {
    const t = await run(agent, () => createTicket(agent, { message: "החייגן לא עולה", context: { route: "/calling/lists?token=abc", userAgent: "UA", errors: [{ at: new Date().toISOString(), status: 500, code: "x", path: "/api/dialer/next-lead?secret=1" }, { at: new Date().toISOString(), code: "leak", path: "/api/x", message: "Bearer uk_live_SECRET" }] } }));
    expect(t.code).toMatch(/^UC-[0-9A-F]{6}$/);
    const row = await db.supportTicket.findUniqueOrThrow({ where: { code: t.code } });
    const ctx = JSON.stringify(row.context);
    expect(ctx).not.toContain("token=abc"); expect(ctx).not.toContain("secret=1"); expect(ctx).not.toContain("uk_live_SECRET");
  });

  it("ops alerts are deduplicated and auto-resolve; reconciliation finds gaps without touching documents", async () => {
    await db.domainEvent.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ businessId, type: "lead.created", dedupeKey: `stuck-${RUN}-${i}`, payload: {}, status: "pending", createdAt: new Date(Date.now() - 20 * 60_000) })) as never });
    await runOpsChecks(); await runOpsChecks();
    const a = await db.platformAlert.findUniqueOrThrow({ where: { fingerprint: `events:stuck:${businessId}` } });
    expect(a.count).toBeGreaterThanOrEqual(2); expect(a.status).toBe("open");
    await db.domainEvent.updateMany({ where: { dedupeKey: { startsWith: `stuck-${RUN}` } }, data: { status: "done" } });
    await runOpsChecks();
    expect((await db.platformAlert.findUniqueOrThrow({ where: { fingerprint: `events:stuck:${businessId}` } })).status).toBe("resolved");
    const ev = await db.usageEvent.findFirstOrThrow({ where: { businessId, service: "call_minute" } });
    const csv = `providerRef,quantity,costMinor,businessRef\n${ev.providerRef ?? "none"},3,40,\nunknown-leg-${RUN},1,12,\n`;
    const docsBefore = await db.billingDocument.findMany({ where: { businessId }, select: { id: true, totalMinor: true } });
    const rec = await runReconciliation(owner.accountId, { provider: "mock", periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(Date.now() + 86400_000), currency: "USD", csv });
    if (ev.providerRef) expect(rec.summary.quantity_diff).toBe(1);
    expect(rec.summary.unassigned).toBe(1);
    expect(await db.billingDocument.findMany({ where: { businessId }, select: { id: true, totalMinor: true } })).toEqual(docsBefore);
  });

  it("export ZIP has the business's tables (and only its own) with secure links for recordings", async () => {
    const r = await run(owner, () => exportBusiness(owner));
    const files = unzipSync(r.zip);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "contacts.csv", "leads.csv", "calls.csv", "usage.csv", "billing_documents.csv", "recordings.csv"]));
    expect(strFromU8(files["contacts.csv"])).toContain("ליד בדיקה");
    expect(strFromU8(files["contacts.csv"])).not.toContain(other.business.id);
    await expect(run(agent, () => exportBusiness(agent))).rejects.toMatchObject({ status: 403 });
  });

  it("offboarding: stop future actions (confirmed), cancel ≠ delete, retention needing decisions is marked", async () => {
    const ov = await run(owner, () => offboardingOverview(owner));
    expect(ov.options.map((o) => o.key)).toEqual(["cancel_subscription", "delete_user", "delete_business"]);
    expect(ov.retentionPolicy.billingRecords).toContain("דורש החלטת");
    await db.dialList.create({ data: { businessId, name: "פעילה" } as never });
    await expect(run(owner, () => stopFutureActions(owner, "שם שגוי"))).rejects.toMatchObject({ code: "confirm_mismatch" });
    const r = await run(owner, () => stopFutureActions(owner, `QA מוקד ${RUN}`));
    expect(r.dialListsDeactivated).toBeGreaterThanOrEqual(1);
    expect(await db.business.count({ where: { id: businessId } })).toBe(1); // nothing deleted
  });

  it("a restored copy (RESTORE_MODE) refuses scheduled jobs, dialing and charging", async () => {
    vi.stubEnv("RESTORE_MODE", "1"); vi.stubEnv("CRON_SECRET", "x");
    expect(() => requireCronSecret(new Request("http://x", { headers: { authorization: "Bearer x" } }))).toThrow(/שחזור/);
    await expect(run(agent, () => startCall(agent, { idempotencyKey: crypto.randomUUID(), mode: "manual", phone: "0500000002" }))).rejects.toMatchObject({ code: "restore_mode" });
    await expect(run(owner, () => billing.checkout(owner, { desired: { crm: 2 }, idempotencyKey: `r-${RUN}`, expectedTotalMinor: 0 }))).rejects.toMatchObject({ code: "billing_provider_missing" });
    vi.unstubAllEnvs();
  });
});
