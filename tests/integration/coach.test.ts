/**
 * Real-time sales coach – end to end on the real DB with COACH_PROVIDER=mock (deterministic local provider).
 * Acceptance: live transcript linked to the right call/lead → objection → recommendation grounded in the
 * business's approved knowledge → learning after the call + deal outcome → retrieval in a later call →
 * tenant isolation → the coach never blocks the call.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.COACH_PROVIDER = "mock";

const { addSegments, sessionState, coachStatus } = await import("@/server/coach/session");
const { learnFromCall, attachDealOutcome } = await import("@/server/coach/learning");
const { retrieveExamples } = await import("@/server/coach/retrieval");
const { GET: stateRoute } = await import("@/app/api/coach/calls/[callId]/state/route");
const { POST: segmentsRoute } = await import("@/app/api/coach/calls/[callId]/segments/route");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
async function req(url: string, user: SessionUser, body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}
async function makeCall(businessId: string, userId: string, contactId: string, leadId: string | null, answered = true) {
  return db.call.create({ data: { businessId, userId, contactId, leadId, mode: "manual", direction: "outbound", provider: "mock", idempotencyKey: crypto.randomUUID(), fromE164: "+972733001001", toE164: "+972501000900", status: answered ? "answered" : "dialing_lead", answeredAt: answered ? new Date() : null } });
}

describe("real-time sales coach (mock provider, real DB)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let contactA: string; let leadA: string; let callA: string;

  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-coach-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-coach-" } } });
    a = await createBusiness("coach-a", { modules: { telephony: true } }); b = await createBusiness("coach-b", { modules: { telephony: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { coach: { enabled: true, learnFromRecordings: false } } } });
    await db.coachKnowledge.create({ data: { businessId: a.business.id, description: "סטודיו כושר", products: [{ name: "מנוי שנתי", price: "199 ₪ לחודש" }], objections: [{ objection: "זה יקר לי", response: "מבין אותך. כדי שאדע אם זה מתאים – מה הכי חשוב לך לקבל מהמנוי?" }], forbiddenClaims: ["הבטחת תוצאות"] } });
    const c = await db.contact.create({ data: { businessId: a.business.id, fullName: "דנה לקוחה", phoneE164: "+972501000900", phoneRaw: "0501000900" } });
    contactA = c.id;
    leadA = (await db.lead.create({ data: { businessId: a.business.id, contactId: contactA, title: "מנוי", status: "contacted", ownerUserId: a.user.id } })).id;
    callA = (await makeCall(a.business.id, a.user.id, contactA, null)).id;
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("1–3: transcript segments attach to the right call and lead; an objection yields one short recommendation grounded in approved knowledge", async () => {
    const status = await run(a.session, () => coachStatus(a.user.id));
    expect(status).toMatchObject({ enabled: true, live: true, providers: { mock: true } });
    const t0 = Date.now();
    const r = await run(a.session, () => addSegments(callA, [{ speaker: "agent", text: "היי דנה, מדבר מהסטודיו", source: "simulation" }, { speaker: "customer", text: "תקשיב, זה יקר לי", source: "simulation" }]));
    expect(r.created).toBe(2); expect(r.analyzed).toBe(true);
    const st = await run(a.session, () => sessionState(callA));
    expect(st?.recommendation).toBeTruthy();
    expect(st!.recommendation!.objection).toBe("מחיר");
    expect(st!.recommendation!.sayNow).toMatch(/מה הכי חשוב לך/); // straight from the business's approved objection response
    expect(st!.recommendation!.sayNow.split(" ").length).toBeLessThanOrEqual(25);
    expect(st!.recommendation!.basis).toBe("knowledge_only"); // no reviewed examples yet – marked honestly
    expect(st!.recommendation!.latencyMs).toBeLessThan(Date.now() - t0 + 1);
    const session = await db.coachSession.findUniqueOrThrow({ where: { callId: callA } });
    expect(session).toMatchObject({ leadId: leadA, contactId: contactA, userId: a.user.id, stage: "objection", lastObjection: "מחיר" });
    expect(Number(session.costUsd)).toBeGreaterThan(0);
  });

  it("dedupes the same objection and supersedes when the conversation moves on; feedback dismisses", async () => {
    const before = await db.coachRecommendation.count({ where: { callId: callA } });
    await run(a.session, () => addSegments(callA, [{ speaker: "customer", text: "כן זה פשוט יקר לי", source: "simulation" }]));
    expect(await db.coachRecommendation.count({ where: { callId: callA } })).toBe(before); // same objection → no duplicate card
    await run(a.session, () => addSegments(callA, [{ speaker: "customer", text: "אני צריך לחשוב על זה", source: "simulation" }]));
    const recs = await db.coachRecommendation.findMany({ where: { callId: callA }, orderBy: { createdAt: "asc" } });
    expect(recs.length).toBe(before + 1);
    expect(recs[0].supersededAt).not.toBeNull(); expect(recs[recs.length - 1].supersededAt).toBeNull();
    expect(recs[recs.length - 1].objection).toBe("דחייה");
  });

  it("4: after the call ends and the deal closes, verifiable examples (with quotes) are stored and labelled with the outcome", async () => {
    await run(a.session, () => addSegments(callA, [{ speaker: "agent", text: "מבין אותך. מה הכי חשוב לך לקבל מהמנוי?", source: "simulation" }]));
    await db.call.update({ where: { id: callA }, data: { endedAt: new Date(), talkSeconds: 120, status: "ended" } });
    const learned = await run(a.session, () => learnFromCall(callA));
    expect(learned).toMatchObject({ outcome: "unknown" });
    const ex = await db.coachExample.findMany({ where: { callId: callA } });
    expect(ex.length).toBeGreaterThanOrEqual(1);
    expect(ex[0].status).toBe("pending"); expect(ex[0].quote).toMatch(/יקר/);
    const deal = await db.deal.create({ data: { businessId: a.business.id, contactId: contactA, leadId: leadA, title: "מנוי", stage: "won", status: "won", closedAt: new Date(), ownerUserId: a.user.id } });
    const r = await run(a.session, () => attachDealOutcome(deal.id, "won"));
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect((await db.coachExample.findFirst({ where: { callId: callA } }))!.outcome).toBe("won");
    // second run is idempotent
    expect(await run(a.session, () => learnFromCall(callA))).toMatchObject({ skipped: "already extracted" });
  });

  it("5: an approved example is retrieved for a similar objection in a later call and the recommendation is marked as example-based", async () => {
    const ex = await db.coachExample.findFirstOrThrow({ where: { callId: callA } });
    await db.coachExample.update({ where: { id: ex.id }, data: { status: "approved", editedResponse: "מבין. מה היה הופך את זה למשתלם עבורך?" } });
    const { examples, method } = await run(a.session, () => retrieveExamples(a.business.id, "וואלה זה יקר לי", 3));
    expect(method).toBe("embedding"); // mock embeddings
    expect(examples[0]?.id).toBe(ex.id);
    const call2 = await makeCall(a.business.id, a.user.id, contactA, null);
    await run(a.session, () => addSegments(call2.id, [{ speaker: "customer", text: "זה יקר לי", source: "simulation" }]));
    const st = await run(a.session, () => sessionState(call2.id));
    expect(st!.recommendation!.basis).toBe("examples");
    expect((st!.recommendation!.sources as { exampleIds: string[] }).exampleIds).toContain(ex.id);
    expect(st!.recommendation!.sayNow).toMatch(/משתלם/);
  });

  it("6: business B cannot read A's coach state, examples or knowledge; its own retrieval finds nothing", async () => {
    const res = await stateRoute(await req(`/api/coach/calls/${callA}/state`, b.session), { params: Promise.resolve({ callId: callA }) });
    expect(res.status).toBe(404);
    await run(b.session, async () => {
      expect(await prisma.coachExample.count()).toBe(0);
      expect(await prisma.coachSession.count()).toBe(0);
      expect((await retrieveExamples(b.business.id, "זה יקר לי")).examples).toEqual([]);
    });
  });

  it("7: coach off for the business/agent → 409 and the call is untouched; provider failure marks the session unavailable only", async () => {
    await db.business.update({ where: { id: b.business.id }, data: { settings: { coach: { enabled: false } } } });
    const cB = await db.contact.create({ data: { businessId: b.business.id, fullName: "B", phoneE164: "+972501000901", phoneRaw: "0501000901" } });
    const callB = await makeCall(b.business.id, b.user.id, cB.id, null);
    const res = await segmentsRoute(await req(`/api/coach/calls/${callB.id}/segments`, b.session, { segments: [{ speaker: "customer", text: "יקר", source: "simulation" }] }), { params: Promise.resolve({ callId: callB.id }) });
    expect(res.status).toBe(409);
    expect((await db.call.findUniqueOrThrow({ where: { id: callB.id } })).status).toBe("answered");
    // A's agent switched off individually
    await db.user.update({ where: { id: a.user.id }, data: { coachEnabled: false } });
    expect((await run(a.session, () => coachStatus(a.user.id))).enabled).toBe(false);
    await db.user.update({ where: { id: a.user.id }, data: { coachEnabled: true } });
  });
});
