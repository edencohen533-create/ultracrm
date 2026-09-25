/**
 * "נתקעתי? שאל את ה-AI" – on the real DB with COACH_PROVIDER=mock: the agent's free-text question is answered with one
 * spoken line + follow-up, grounded in the business's approved knowledge; the answer records which sources really
 * fed it (no transcript → says so); the chat keeps context per call; only the call's agent/manager can use it; a
 * business without the coach enabled gets 409.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.COACH_PROVIDER = "mock";

const { askCoach, chatHistory } = await import("@/server/coach/chat");
const { addSegments } = await import("@/server/coach/session");
const { GET: chatGet, POST: chatPost } = await import("@/app/api/coach/calls/[callId]/chat/route");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);
async function req(url: string, user: SessionUser, body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = (callId: string) => ({ params: Promise.resolve({ callId }) });

describe("coach chat (mock provider, real DB)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let callA: string; let callNoTranscript: string;
  beforeAll(async () => {
    a = await createBusiness("coachchat-a", { modules: { telephony: true } }); b = await createBusiness("coachchat-b", { modules: { telephony: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { coach: { enabled: true, learnFromRecordings: false } } } });
    await db.coachKnowledge.create({ data: { businessId: a.business.id, description: "סטודיו כושר", products: [{ name: "מנוי שנתי", price: "199 ₪ לחודש" }], objections: [{ objection: "זה יקר לי", response: "מבין אותך. כדי שאדע אם זה מתאים – מה הכי חשוב לך לקבל מהאימונים?" }] } });
    const c = await db.contact.create({ data: { businessId: a.business.id, fullName: "רוני לקוחה", phoneE164: "+972501000901", phoneRaw: "0501000901", customFields: { product: "מנוי שנתי" } } });
    await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, title: "מנוי", status: "contacted", ownerUserId: a.user.id } });
    const mk = () => db.call.create({ data: { businessId: a.business.id, userId: a.user.id, contactId: c.id, mode: "manual", direction: "outbound", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+972500000000", status: "answered", answeredAt: new Date() } });
    callA = (await mk()).id; callNoTranscript = (await mk()).id;
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("answers with a line to say + follow-up from approved knowledge; sources say 'no transcript' when there is none", async () => {
    const r = await run(a.session, () => askCoach(callNoTranscript, "היא אומרת שזה יקר ורוצה לחשוב על זה"));
    expect(r.question.role).toBe("agent");
    expect(r.answer.text).toMatch(/מה הכי חשוב לך/); // the business's approved objection response, not an invented price
    expect(r.answer.text.split(" ").length).toBeLessThanOrEqual(30);
    expect(r.answer.followUp).toBeTruthy();
    expect(r.answer.basis).toBe("knowledge_only");
    expect(r.answer.sources).toMatchObject({ transcriptLines: 0, lead: true, product: true, examples: 0, knowledgeObjections: 1, mock: true });
    const session = await db.coachSession.findUniqueOrThrow({ where: { callId: callNoTranscript } });
    expect(session.tokensIn).toBeGreaterThan(0);
  });

  it("uses the live transcript when it exists and keeps the chat context per call", async () => {
    await run(a.session, () => addSegments(callA, [{ speaker: "agent", text: "היי רוני", source: "simulation" }, { speaker: "customer", text: "אני צריכה לחשוב על זה", source: "simulation" }]));
    const first = await run(a.session, () => askCoach(callA, "אמרתי את זה, עכשיו היא שואלת על משלוח"));
    expect(first.answer.sources.transcriptLines).toBe(2);
    const second = await run(a.session, () => askCoach(callA, "ועכשיו היא אומרת שזה יקר"));
    expect(second.answer.text).toMatch(/מה הכי חשוב לך/);
    const history = await run(a.session, () => chatHistory(callA));
    expect(history.map((m) => m.role)).toEqual(["agent", "assistant", "agent", "assistant"]);
    expect(await run(a.session, () => chatHistory(callNoTranscript))).toHaveLength(2); // the other call's chat is separate
  });

  it("API: the call's agent chats; another business gets 404; a business with the coach off gets 409", async () => {
    const res = await chatPost(await req(`/api/coach/calls/${callA}/chat`, a.session, { question: "היא לא בטוחה שזה שווה את זה" }), ctx(callA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.answer.text.length).toBeGreaterThan(5);
    const list = await chatGet(await req(`/api/coach/calls/${callA}/chat`, a.session), ctx(callA));
    expect((await list.json()).data.messages.length).toBeGreaterThanOrEqual(6);
    expect((await chatPost(await req(`/api/coach/calls/${callA}/chat`, b.session, { question: "x y" }), ctx(callA))).status).toBe(404);
    const cB = await db.contact.create({ data: { businessId: b.business.id, fullName: "B", phoneE164: "+972501000902", phoneRaw: "0501000902" } });
    const callB = await db.call.create({ data: { businessId: b.business.id, userId: b.user.id, contactId: cB.id, mode: "manual", direction: "outbound", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: cB.phoneE164, fromE164: "+972500000000", status: "answered", answeredAt: new Date() } });
    expect((await chatPost(await req(`/api/coach/calls/${callB.id}/chat`, b.session, { question: "היא אומרת שזה יקר" }), ctx(callB.id))).status).toBe(409);
    expect(await db.coachChatMessage.count({ where: { businessId: b.business.id } })).toBe(0);
  });
});
