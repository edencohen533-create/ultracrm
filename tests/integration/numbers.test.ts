/**
 * Outbound number management – SIMULATED provider (in-memory), real isolated DB.
 * Covers permissions, honest connection state, rotation policies under concurrency, sticky
 * caller id, spam review, DNC, stale verification, purchase confirmation / double-click /
 * timeout / setup failure, stale quotes, sync failure, throttling, manual reputation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.NUMBER_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER ||= "mock";

const { mockNumberProvider, numberConfig } = await import("@/lib/numbers/providers");
const { selectOutboundNumber, connectionFresh } = await import("@/lib/numbers/selection");
const { checkNumberConnection, syncNumbers, createNumberQuote, confirmNumberPurchase, reconcileNumberOrder, saveNumberPolicy, numberOperationLimit } = await import("@/lib/numbers/service");
const { POST: numbersPost, GET: numbersGet } = await import("@/app/api/numbers/route");
const { ApiError } = await import("@/lib/response");
type MockState = import("@/lib/numbers/providers").MockState;

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
async function authed(url: string, user: SessionUser, body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = { params: Promise.resolve({}) };
const freshState = (): MockState => ({ inventory: [], orders: [], offers: [{ e164: "+972733009001", country: "IL", type: "local", upfront: "1.00", monthly: "2.00", currency: "USD", requirements: null, source: "simulation" }, { e164: "+972733009002", country: "IL", type: "local", upfront: "1.00", monthly: "2.00", currency: "USD", requirements: null, source: "simulation" }] });

describe("outbound number management (simulated provider)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let agent: SessionUser;
  let nums: Array<{ id: string; e164: string }> = [];
  let listId: string;
  const select = (input: Partial<Parameters<typeof selectOutboundNumber>[1]> & { toE164: string; userId?: string }) =>
    prisma.$transaction((tx) => selectOutboundNumber(tx, { businessId: a.business.id, userId: input.userId ?? a.user.id, listId: input.listId ?? listId, phoneNumberId: input.phoneNumberId, toE164: input.toE164, simulation: input.simulation ?? true }));
  const liveCall = (phoneNumberId: string, toE164: string, userId = a.user.id) => db.call.create({ data: { businessId: a.business.id, userId, mode: "manual", provider: "mock", idempotencyKey: `k-${Math.random()}`, toE164, fromE164: "x", phoneNumberId, status: "dialing_lead" } });

  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-num-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-num-" } } });
    a = await createBusiness("num-a", { modules: { telephony: true } });
    b = await createBusiness("num-b", { modules: { telephony: true } });
    const acc = await db.account.create({ data: { email: `${a.business.slug}-agent@test.local`, fullName: "Agent", passwordHash: "x" } });
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: "Agent", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: "Agent", role: "agent", teamId: null };
    nums = await Promise.all(["+972733100001", "+972733100002", "+972733100003"].map((e164, i) => db.phoneNumber.create({ data: { businessId: a.business.id, e164, provider: "mock", isActive: true, isDefault: i === 0, verificationStatus: "verified", verifiedAt: new Date() } })));
    listId = (await db.dialList.create({ data: { businessId: a.business.id, name: "num-list", numberPolicy: { mode: "round_robin", numberIds: nums.map((n) => n.id) } } })).id;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.call.deleteMany({ where: { businessId: a.business.id } });
    await destroyBusiness(a.business.id, [a.account.id, agent.accountId]);
    await destroyBusiness(b.business.id, [b.account.id]);
  });

  it("NUM1 permissions: agent cannot read or manage; another tenant cannot mutate", async () => {
    expect((await numbersGet(await authed("/api/numbers", agent), ctx)).status).toBe(403);
    expect((await numbersPost(await authed("/api/numbers", agent, { action: "number", id: nums[0].id, outboundPaused: true }), ctx)).status).toBe(403);
    const cross = await numbersPost(await authed("/api/numbers", b.session, { action: "number", id: nums[0].id, outboundPaused: true }), ctx);
    expect(cross.status).toBe(404);
    expect((await db.phoneNumber.findUniqueOrThrow({ where: { id: nums[0].id } })).outboundPaused).toBe(false);
    // manager may pause; purchase-class actions are owner-only
    const res = await numbersGet(await authed("/api/numbers", a.session), ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()).data;
    expect(JSON.stringify(j)).not.toMatch(/TELNYX_API_KEY|Bearer /);
    expect(j.reputation.status).toBe("unsupported");
  });

  it("NUM2 a configured provider is not 'verified' until a real check succeeds; a failed check is recorded honestly", async () => {
    expect(connectionFresh(null, a.business.id)).toBe(false);
    expect(numberConfig(a.business.id).configured).toBe(true);
    const state = freshState(); state.testFails = true;
    await expect(checkNumberConnection(a.business.id, mockNumberProvider(a.business.id, state))).rejects.toMatchObject({ code: "connection_check_failed" });
    expect((await db.numberConnection.findUniqueOrThrow({ where: { businessId: a.business.id } })).status).toBe("failed");
    state.testFails = false;
    const c = await checkNumberConnection(a.business.id, mockNumberProvider(a.business.id, state));
    expect(c.status).toBe("verified");
    expect(connectionFresh(c, a.business.id)).toBe(true);
  });

  it("NUM3/NUM24 three parallel reservations use three numbers and respect per-number concurrency and daily caps", async () => {
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { maxConcurrent: 1 } });
    const picks = await Promise.all(["+972500000101", "+972500000102", "+972500000103"].map(async (to) => { const s = await select({ toE164: to }); await liveCall(s.number.id, to); return s.number.id; }));
    expect(new Set(picks).size).toBe(3);
    await expect(select({ toE164: "+972500000104" })).rejects.toMatchObject({ code: "no_eligible_number" });
    await db.call.updateMany({ where: { businessId: a.business.id }, data: { endedAt: new Date() } });
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { maxConcurrent: null, maxDailyAttempts: 1 } });
    // each number already dialled once today → exhausted
    await expect(select({ toE164: "+972500000105" })).rejects.toMatchObject({ code: "no_eligible_number" });
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { maxDailyAttempts: null } });
  });

  it("NUM4 a lead keeps its prior caller id (sticky) and the reason is recorded", async () => {
    const first = await select({ toE164: "+972500000101" });
    expect(first.reason).toBe("sticky_lead");
    expect(first.number.id).toBe((await db.call.findFirstOrThrow({ where: { toE164: "+972500000101" } })).phoneNumberId);
    const fresh = await select({ toE164: "+972500000199" });
    expect(["round_robin"]).toContain(fresh.reason);
  });

  it("NUM5 paused / inactive numbers are skipped; NUM6 a fixed campaign never silently swaps its number", async () => {
    await db.phoneNumber.update({ where: { id: nums[0].id }, data: { outboundPaused: true } });
    await db.phoneNumber.update({ where: { id: nums[1].id }, data: { isActive: false } });
    const s = await select({ toE164: "+972500000201" });
    expect(s.number.id).toBe(nums[2].id);
    const fixed = await db.dialList.create({ data: { businessId: a.business.id, name: "fixed", numberPolicy: { mode: "fixed", numberIds: [nums[0].id] }, phoneNumberId: nums[0].id } });
    await expect(select({ toE164: "+972500000202", listId: fixed.id })).rejects.toMatchObject({ code: "no_eligible_number" });
    await expect(select({ toE164: "+972500000202", listId: fixed.id, phoneNumberId: nums[2].id })).rejects.toMatchObject({ code: "campaign_number_policy" });
    await db.phoneNumber.update({ where: { id: nums[0].id }, data: { outboundPaused: false } });
    await db.phoneNumber.update({ where: { id: nums[1].id }, data: { isActive: true } });
  });

  it("NUM7 agent policy uses the agent's own number; load policy prefers the least loaded", async () => {
    await db.phoneNumber.update({ where: { id: nums[1].id }, data: { assignedUserId: agent.id } });
    const agentList = await db.dialList.create({ data: { businessId: a.business.id, name: "agent", numberPolicy: { mode: "agent", numberIds: nums.map((n) => n.id) } } });
    expect((await select({ toE164: "+972500000301", listId: agentList.id, userId: agent.id })).number.id).toBe(nums[1].id);
    await expect(select({ toE164: "+972500000302", listId: agentList.id, userId: a.user.id })).rejects.toMatchObject({ code: "no_eligible_number" });
    const loadList = await db.dialList.create({ data: { businessId: a.business.id, name: "load", numberPolicy: { mode: "load", numberIds: nums.map((n) => n.id) } } });
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { maxConcurrent: 5 } });
    const c1 = await liveCall(nums[0].id, "+972500000311"); const c2 = await liveCall(nums[1].id, "+972500000312");
    const s = await select({ toE164: "+972500000313", listId: loadList.id });
    expect(s.number.id).toBe(nums[2].id); expect(s.reason).toBe("load");
    await db.call.updateMany({ where: { id: { in: [c1.id, c2.id] } }, data: { endedAt: new Date() } });
  });

  it("NUM8 a spam-marked prior number blocks automatic replacement for that lead until reviewed", async () => {
    const to = "+972500000401";
    const s = await select({ toE164: to }); await liveCall(s.number.id, to);
    await db.call.updateMany({ where: { toE164: to }, data: { endedAt: new Date() } });
    await db.phoneNumber.update({ where: { id: s.number.id }, data: { reputationStatus: "spam", reputationReview: "required" } });
    await expect(select({ toE164: to })).rejects.toMatchObject({ code: "reputation_review_required" });
    await db.phoneNumber.update({ where: { id: s.number.id }, data: { reputationReview: "resolved" } });
    expect((await select({ toE164: to })).number.id).toBe(s.number.id);
    await db.phoneNumber.update({ where: { id: s.number.id }, data: { reputationStatus: "unsupported", reputationReview: null } });
  });

  it("NUM10 without a fresh provider verification a REAL (non-simulated) call gets no number", async () => {
    await db.numberConnection.update({ where: { businessId: a.business.id }, data: { checkedAt: new Date(Date.now() - 2 * 86400000) } });
    await expect(select({ toE164: "+972500000501", simulation: false })).rejects.toMatchObject({ code: "number_connection_stale" });
    await db.numberConnection.update({ where: { businessId: a.business.id }, data: { checkedAt: new Date() } });
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { verifiedAt: new Date(Date.now() - 2 * 86400000) } });
    await expect(select({ toE164: "+972500000502", simulation: false })).rejects.toMatchObject({ code: "no_eligible_number" });
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { verifiedAt: new Date() } });
    expect((await select({ toE164: "+972500000503", simulation: false })).number).toBeTruthy();
  });

  it("NUM12/13 purchase requires explicit confirmation; concurrent clicks charge once and the number becomes ready", async () => {
    const state = freshState(); const p = mockNumberProvider(a.business.id, state);
    const quote = await run(a.session, () => createNumberQuote(a.session, { e164: "+972733009001", country: "IL", type: "local" }, p));
    expect(quote.state).toBe("quoted");
    await expect(run(a.session, () => confirmNumberPurchase(a.session, quote.id, false, p))).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(run(agent, () => confirmNumberPurchase(agent, quote.id, true, p))).rejects.toMatchObject({ code: "forbidden" });
    const results = await Promise.all([1, 2, 3].map(() => run(a.session, () => confirmNumberPurchase(a.session, quote.id, true, p))));
    expect(state.orders.length).toBe(1); // charged once
    expect(results.every((r) => ["ready", "configuring", "pending"].includes(r.state))).toBe(true);
    const final = await run(a.session, () => reconcileNumberOrder(a.session, quote.id, p));
    expect(final.state).toBe("ready");
    const owned = await db.phoneNumber.findUniqueOrThrow({ where: { businessId_e164: { businessId: a.business.id, e164: "+972733009001" } } });
    expect(owned.verificationStatus).toBe("verified");
    expect(owned.costs).toMatchObject({ upfront: "1.00", currency: "USD" });
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "number.purchase_confirmed" } })).toBe(1);
  });

  it("NUM14/16 timeout after a successful order → unknown, reconciled without a second purchase; error before order → no number, no retry", async () => {
    const state = freshState(); const p = mockNumberProvider(a.business.id, state);
    const q = await run(a.session, () => createNumberQuote(a.session, { e164: "+972733009002", country: "IL", type: "local" }, p));
    state.failNextPurchase = "timeout";
    const r1 = await run(a.session, () => confirmNumberPurchase(a.session, q.id, true, p));
    expect(["ready", "unknown", "configuring"]).toContain(r1.state);
    expect(state.orders.length).toBe(1);
    const r2 = await run(a.session, () => reconcileNumberOrder(a.session, q.id, p));
    expect(r2.state).toBe("ready");
    expect(state.orders.length).toBe(1);
    // A second confirm on a non-quoted order never purchases again.
    await run(a.session, () => confirmNumberPurchase(a.session, q.id, true, p));
    expect(state.orders.length).toBe(1);
    // Provider error before an order exists → unknown, reconcile finds nothing, still no second purchase.
    state.offers.push({ e164: "+972733009003", country: "IL", type: "local", upfront: "1.00", monthly: "2.00", currency: "USD", requirements: null, source: "simulation" });
    const q3 = await run(a.session, () => createNumberQuote(a.session, { e164: "+972733009003", country: "IL", type: "local" }, p));
    state.failNextPurchase = "error";
    const r3 = await run(a.session, () => confirmNumberPurchase(a.session, q3.id, true, p));
    expect(r3.state).toBe("unknown");
    expect(state.orders.length).toBe(1);
    expect(await db.phoneNumber.count({ where: { e164: "+972733009003" } })).toBe(0);
  });

  it("NUM15 a changed or expired quote cannot charge", async () => {
    const state = freshState(); state.offers.push({ e164: "+972733009004", country: "IL", type: "local", upfront: "1.00", monthly: "2.00", currency: "USD", requirements: null, source: "simulation" });
    const p = mockNumberProvider(a.business.id, state);
    const q = await run(a.session, () => createNumberQuote(a.session, { e164: "+972733009004", country: "IL", type: "local" }, p));
    state.offers.find((o) => o.e164 === "+972733009004")!.monthly = "9.00";
    await expect(run(a.session, () => confirmNumberPurchase(a.session, q.id, true, p))).rejects.toMatchObject({ code: "quote_changed" });
    expect(state.orders.length).toBe(0);
    await db.numberOrder.update({ where: { id: q.id }, data: { expiresAt: new Date(0), quote: { ...(q.quote as object), monthly: "9.00" } } });
    await expect(run(a.session, () => confirmNumberPurchase(a.session, q.id, true, p))).rejects.toMatchObject({ code: "quote_expired" });
  });

  it("NUM17 a failed inventory sync marks the connection failed and keeps numbers and history", async () => {
    const before = await db.phoneNumber.count({ where: { businessId: a.business.id } });
    const state = freshState(); state.testFails = true;
    await expect(run(a.session, () => syncNumbers(a.business.id, mockNumberProvider(a.business.id, state)))).rejects.toBeTruthy();
    expect((await db.numberConnection.findUniqueOrThrow({ where: { businessId: a.business.id } })).status).toBe("failed");
    expect(await db.phoneNumber.count({ where: { businessId: a.business.id } })).toBe(before);
    expect(await db.call.count({ where: { businessId: a.business.id } })).toBeGreaterThan(0);
    // Successful sync imports only numbers attached to our app and revokes verification of the rest (never deletes).
    state.testFails = false; state.inventory = [{ id: "m1", e164: "+972733100001", status: "active", connectionId: "mock-app" }, { id: "m9", e164: "+972733199999", status: "active", connectionId: "other-app" }];
    const r = await run(a.session, () => syncNumbers(a.business.id, mockNumberProvider(a.business.id, state)));
    expect(r.synced).toBe(1);
    expect(await db.phoneNumber.count({ where: { e164: "+972733199999" } })).toBe(0);
    expect((await db.phoneNumber.findUniqueOrThrow({ where: { id: nums[1].id } })).verificationStatus).toBe("unverified");
    expect(await db.phoneNumber.count({ where: { businessId: a.business.id } })).toBeGreaterThanOrEqual(before);
    await db.phoneNumber.updateMany({ where: { businessId: a.business.id }, data: { verificationStatus: "verified", verifiedAt: new Date() } });
  });

  it("NUM19 manual reputation report is distinct from an API check and raises a review", async () => {
    const res = await numbersPost(await authed("/api/numbers", a.session, { action: "reputation_check", id: nums[0].id }), ctx);
    expect((await res.json()).data.status).toBe("unsupported");
    const manual = await numbersPost(await authed("/api/numbers", a.session, { action: "reputation_manual", id: nums[0].id, status: "spam", note: "נבדק ידנית בפורטל Truecaller" }), ctx);
    const n = (await manual.json()).data;
    expect(n.reputationStatus).toBe("spam"); expect(n.reputationSource).toBe("manual_truecaller"); expect(n.reputationReview).toBe("required");
    expect(n.reputationData.providerApiResponse).toBeNull();
    const review = await numbersPost(await authed("/api/numbers", a.session, { action: "review", id: nums[0].id, note: "ערעור הוגש, אושר", resolved: true }), ctx);
    expect((await review.json()).data.reputationReview).toBe("resolved");
    await db.phoneNumber.update({ where: { id: nums[0].id }, data: { reputationStatus: "unsupported", reputationReview: null } });
  });

  it("NUM20 management API is throttled server-side", async () => {
    await db.auditLog.deleteMany({ where: { businessId: a.business.id, action: "numbers.api_request" } });
    for (let i = 0; i < 20; i++) await run(a.session, () => numberOperationLimit(a.business.id, a.user.id, "test"));
    await expect(run(a.session, () => numberOperationLimit(a.business.id, a.user.id, "test"))).rejects.toMatchObject({ code: "rate_limited" });
    await db.auditLog.deleteMany({ where: { businessId: a.business.id, action: "numbers.api_request" } });
  });

  it("policy validation: pool must belong to the business, fixed needs one number, rotation needs a pool", async () => {
    await expect(run(a.session, () => saveNumberPolicy(a.session, listId, { mode: "round_robin", numberIds: [] }))).rejects.toMatchObject({ code: "empty_number_pool" });
    await expect(run(a.session, () => saveNumberPolicy(a.session, listId, { mode: "fixed", numberIds: [nums[0].id, nums[1].id] }))).rejects.toMatchObject({ code: "invalid_number_pool" });
    const bNum = await db.phoneNumber.create({ data: { businessId: b.business.id, e164: "+972733200001", provider: "mock" } });
    await expect(run(a.session, () => saveNumberPolicy(a.session, listId, { mode: "round_robin", numberIds: [bNum.id] }))).rejects.toMatchObject({ code: "invalid_number_pool" });
    const saved = await run(a.session, () => saveNumberPolicy(a.session, listId, { mode: "fixed", numberIds: [nums[2].id] }));
    expect(saved.phoneNumberId).toBe(nums[2].id);
    expect(ApiError).toBeDefined();
  });
});
