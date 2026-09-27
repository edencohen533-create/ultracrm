/**
 * Round 10 on the real DB (external HTTP stubbed): data visibility by role (settings → הרשאות), agent lead transfer
 * permission, move a lead to a dialer campaign, full Meta template submission (header/body/footer/buttons/OTP/media),
 * AI call documentation (transcript + stubbed LLM), post-call WhatsApp template.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { listLeads } = await import("@/lib/crm/pipeline");
const { transferLeads } = await import("@/lib/crm/lead-ops");
const { submitMetaTemplate } = await import("@/server/services/template-submit-service");
const { submitTemplateSchema } = await import("@/lib/validation/template");
const { documentCall } = await import("@/server/coach/documentation");
const { validateTemplateVariables } = await import("@/lib/campaigns");
const { GET: contactsGET } = await import("@/app/api/contacts/route");
const { POST: moveToList } = await import("@/app/api/leads/[id]/move-to-list/route");
const { POST: postCallWa } = await import("@/app/api/dialer/call/[id]/whatsapp/route");
const { GET: targetsGET } = await import("@/app/api/users/transfer-targets/route");

let a: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser, agent2: SessionUser, manager: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const req = async (u: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const setPerms = async (p: Record<string, unknown>) => { const b = await db.business.findUniqueOrThrow({ where: { id: a.business.id } }); const s = (b.settings ?? {}) as Record<string, unknown>; await db.business.update({ where: { id: a.business.id }, data: { settings: { ...s, permissions: { ...((s.permissions as object) ?? {}), ...p } } as object } }); };
let seq = 0;
const lead = async (owner: string | null) => { seq++; const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `איש ${seq}`, phoneE164: `+97253${String(1000000 + seq).slice(-7)}`, phoneRaw: "x", ownerUserId: null } }); return db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: owner } }); };
const page = (u: SessionUser) => run(u, () => listLeads(u, { sort: "createdAt", direction: "desc", page: 1, limit: 100 } as never));

describe("round 10", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("r10", { modules: { crm: true, telephony: true, messaging: true } }); accounts.push(a.account.id);
    const mk = async (name: string, role: "agent" | "manager") => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser; };
    agent = await mk("אורי", "agent"); agent2 = await mk("דנה", "agent"); manager = await mk("מנהל", "manager");
  }, 900_000);
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("visibility: an agent sees only own leads and contacts (no unassigned pool by default); managers see everyone; settings switch pool / team scope", async () => {
    const mine = await lead(agent.id); const other = await lead(agent2.id); const pool = await lead(null);
    const ids = (await page(agent)).items.map((l) => l.id);
    expect(ids).toContain(mine.id); expect(ids).not.toContain(other.id); expect(ids).not.toContain(pool.id);
    const contacts = (await (await contactsGET(await req(agent, "/api/contacts?limit=200"), ctx())).json()).data.items.map((c: { id: string }) => c.id);
    expect(contacts).toContain(mine.contactId); expect(contacts).not.toContain(other.contactId); expect(contacts).not.toContain(pool.contactId);
    const m = (await page(manager)).items.map((l) => l.id);
    expect(m).toEqual(expect.arrayContaining([mine.id, other.id, pool.id]));
    await setPerms({ agentSeesUnassigned: true, managerScope: "team" });
    expect((await page(agent)).items.map((l) => l.id)).toContain(pool.id);
    const teamOnly = (await page(manager)).items.map((l) => l.id);
    expect(teamOnly).not.toContain(mine.id); // the manager has no team
    await setPerms({ agentSeesUnassigned: false, managerScope: "business" });
  });

  it("agent transfer: forbidden by default; allowed for selected agents, only their own leads, to any active user", async () => {
    const mine = await lead(agent.id); const other = await lead(agent2.id);
    await expect(run(agent, () => transferLeads(agent, { leadIds: [mine.id], toUserId: agent2.id }))).rejects.toMatchObject({ status: 403 });
    await setPerms({ agentTransfer: "selected", agentTransferUserIds: [agent.id] });
    const targets = (await (await targetsGET(await req(agent, "/api/users/transfer-targets"), ctx())).json()).data.items.map((u: { id: string }) => u.id);
    expect(targets).toEqual(expect.arrayContaining([agent2.id, manager.id]));
    const r = await run(agent, () => transferLeads(agent, { leadIds: [mine.id, other.id], toUserId: agent2.id }));
    expect(r.transferred).toEqual([mine.id]); expect(r.notFound).toEqual([other.id]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: mine.id } })).ownerUserId).toBe(agent2.id);
    await expect(run(agent2, () => transferLeads(agent2, { leadIds: [mine.id], toUserId: agent.id }))).rejects.toMatchObject({ status: 403 });
  });

  it("'לא מתאים' → move the lead to a dialer campaign (e.g. lead pool); agents only to lists open to them", async () => {
    const l = await lead(agent.id); await db.lead.update({ where: { id: l.id }, data: { status: "unqualified" } });
    const pool = await db.dialList.create({ data: { businessId: a.business.id, name: "בריכת לידים אורי" } });
    const privateList = await db.dialList.create({ data: { businessId: a.business.id, name: "של דנה", agents: { create: [{ userId: agent2.id }] } } });
    expect((await moveToList(await req(agent, `/api/leads/${l.id}/move-to-list`, "POST", { listId: privateList.id }), ctx({ id: l.id }))).status).toBe(404);
    const res = await moveToList(await req(agent, `/api/leads/${l.id}/move-to-list`, "POST", { listId: pool.id }), ctx({ id: l.id }));
    expect(res.status).toBe(200);
    expect(await db.listLead.findFirst({ where: { listId: pool.id, contactId: l.contactId } })).toMatchObject({ status: "pending" });
    expect(await db.auditLog.count({ where: { entityId: l.id, action: "lead.moved_to_list" } })).toBe(1);
  });

  it("template builder: validation mirrors Meta's rules", () => {
    const base = { name: "t_x", language: "he", category: "MARKETING", body: "שלום {{1}}, מבצע!", examples: { "1": "דנה" } };
    expect(submitTemplateSchema.safeParse(base).success).toBe(true);
    expect(submitTemplateSchema.safeParse({ ...base, body: "{{1}} שלום", examples: { "1": "x" } }).success).toBe(false);
    expect(submitTemplateSchema.safeParse({ ...base, buttons: [1, 2, 3].map((i) => ({ type: "URL", text: `a${i}`, url: "https://a.com" })) }).success).toBe(false);
    expect(submitTemplateSchema.safeParse({ ...base, buttons: [{ type: "QUICK_REPLY", text: "a" }, { type: "URL", text: "b", url: "https://a.com" }, { type: "QUICK_REPLY", text: "c" }] }).success).toBe(false);
    expect(submitTemplateSchema.safeParse({ ...base, header: { format: "TEXT", text: "שלום {{1}} {{2}}" } }).success).toBe(false);
    expect(submitTemplateSchema.safeParse({ ...base, header: { format: "IMAGE" } }).success).toBe(false);
    expect(submitTemplateSchema.safeParse({ name: "otp", language: "he", category: "AUTHENTICATION", auth: { addSecurityRecommendation: true, codeExpirationMinutes: 5, otpType: "COPY_CODE" } }).success).toBe(true);
    expect(() => validateTemplateVariables("שלום {{1}}", { "1": "a", h1: "כותרת" })).not.toThrow();
  });

  it("template submission sends every component to Meta (header var, footer, all button types, sample media upload, OTP)", async () => {
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, isDefault: true, config: { accessToken: "EAAtoken", phoneNumberId: "111", businessAccountId: "222" } } });
    process.env.META_APP_ID = "999";
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); calls.push({ url: u, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (u.startsWith("https://cdn.example.com/")) return new Response(Buffer.from("fakejpg"), { status: 200, headers: { "content-type": "image/jpeg" } });
      if (u.includes("/999/uploads")) return Response.json({ id: "upload:abc" });
      if (u.includes("/upload:abc")) return Response.json({ h: "HANDLE123" });
      return Response.json({ id: String(Date.now()), status: "PENDING" });
    }));
    const t = await run(a.session, () => submitMetaTemplate({ name: "order_update", language: "he", category: "UTILITY", header: { format: "TEXT", text: "הזמנה {{1}}", example: "1234" }, body: "שלום {{1}}, ההזמנה בדרך. תודה!", examples: { "1": "דנה" }, footer: "להסרה השיבו הסר",
      buttons: [{ type: "QUICK_REPLY", text: "תודה" }, { type: "QUICK_REPLY", text: "שאלה" }, { type: "URL", text: "מעקב", url: "https://shop.com/o/{{1}}", example: "https://shop.com/o/1234" }, { type: "PHONE_NUMBER", text: "התקשר", phone: "+972501234567" }, { type: "COPY_CODE", example: "SAVE10" }] }));
    expect(t).toMatchObject({ status: "PENDING_APPROVAL", headerFormat: "TEXT" }); expect(t.variables).toEqual(["1", "h1"]);
    const sent = calls.find((c) => c.url.endsWith("/222/message_templates"))!.body as { components: Array<Record<string, unknown>> };
    const byType = (ty: string) => sent.components.find((c) => c.type === ty)!;
    expect(byType("HEADER")).toMatchObject({ format: "TEXT", text: "הזמנה {{1}}", example: { header_text: ["1234"] } });
    expect(byType("BODY")).toMatchObject({ example: { body_text: [["דנה"]] } });
    expect(byType("FOOTER")).toMatchObject({ text: "להסרה השיבו הסר" });
    expect((byType("BUTTONS").buttons as Array<{ type: string }>).map((b) => b.type)).toEqual(["QUICK_REPLY", "QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]);
    await run(a.session, () => submitMetaTemplate({ name: "promo_img", language: "he", category: "MARKETING", header: { format: "IMAGE", mediaUrl: "https://cdn.example.com/p.jpg" }, body: "מבצע חדש!", examples: {} }));
    const img = calls.filter((c) => c.url.endsWith("/222/message_templates")).at(-1)!.body as { components: Array<Record<string, unknown>> };
    expect(img.components[0]).toMatchObject({ type: "HEADER", format: "IMAGE", example: { header_handle: ["HANDLE123"] } });
    await run(a.session, () => submitMetaTemplate({ name: "login_code", language: "he", category: "AUTHENTICATION", auth: { addSecurityRecommendation: true, codeExpirationMinutes: 5, otpType: "COPY_CODE" } }));
    const otp = calls.filter((c) => c.url.endsWith("/222/message_templates")).at(-1)!.body as { components: Array<Record<string, unknown>> };
    expect(otp.components).toEqual([{ type: "BODY", add_security_recommendation: true }, { type: "FOOTER", code_expiration_minutes: 5 }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "העתק קוד" }] }]);
    await db.providerCredential.deleteMany({ where: { businessId: a.business.id, provider: "meta_whatsapp_cloud_api" } });
  });

  it("AI call documentation: timeline from the transcript without an LLM; full AI doc with the LLM; run once per call", async () => {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.COACH_PROVIDER;
    const l = await lead(agent.id);
    const mkCall = () => db.call.create({ data: { businessId: a.business.id, userId: agent.id, contactId: l.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000001", fromE164: "x", status: "ended", answeredAt: new Date(), endedAt: new Date(), talkSeconds: 150, outcomeSavedAt: new Date() } });
    const seg = async (callId: string) => { const s = await db.coachSession.create({ data: { businessId: a.business.id, callId, userId: agent.id } }); let t = 0; for (const [sp, text] of [["agent", "שלום, מדבר אורי"], ["customer", "היי, ראיתי את המודעה"], ["customer", "כמה זה עולה?"], ["agent", "299 לחודש"], ["customer", "יקר לי, אני צריך לחשוב"], ["agent", "אחזור אליך מחר בעשר"]] as const) { await db.coachSegment.create({ data: { businessId: a.business.id, sessionId: s.id, callId, speaker: sp, text, startMs: t, endMs: t + 20_000, source: "simulation" } }); t += 30_000; } };
    const c1 = await mkCall(); await seg(c1.id);
    expect(await run(a.session, () => documentCall(c1.id))).toMatchObject({ documented: "transcript" });
    const d1 = (await db.coachSession.findUniqueOrThrow({ where: { callId: c1.id } })).documentation as { source: string; timeline: Array<{ from: string; details: string }> };
    expect(d1.source).toBe("transcript"); expect(d1.timeline.length).toBeGreaterThanOrEqual(2); expect(d1.timeline[0].details).toContain("שלום, מדבר אורי");
    expect(await run(a.session, () => documentCall(c1.id))).toMatchObject({ skipped: "already documented" });
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: [{ type: "text", text: JSON.stringify({ summary: "הלקוח התעניין אך טען שהמחיר יקר", timeline: [{ from: "00:00", to: "00:30", title: "פתיחה", details: "הצגה" }, { from: "00:30", to: "02:30", title: "מחיר והתנגדות", details: "299 לחודש, יקר" }], customerNeeds: ["מחיר נמוך"], objections: ["יקר"], agreements: ["חזרה מחר"], nextSteps: ["להתקשר מחר ב-10:00"], sentiment: "neutral" }) }], usage: { input_tokens: 500, output_tokens: 200 } })));
    const c2 = await mkCall(); await seg(c2.id);
    expect(await run(a.session, () => documentCall(c2.id))).toMatchObject({ documented: "ai" });
    const d2 = (await db.coachSession.findUniqueOrThrow({ where: { callId: c2.id } })).documentation as { source: string; objections: string[]; nextSteps: string[] };
    expect(d2).toMatchObject({ source: "ai", objections: ["יקר"], nextSteps: ["להתקשר מחר ב-10:00"] });
    if (saved) process.env.ANTHROPIC_API_KEY = saved; else delete process.env.ANTHROPIC_API_KEY;
  });

  it("post-call WhatsApp: the agent sends an approved template to the call's customer; other agents' calls are refused", async () => {
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    const tpl = await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "after_call", language: "he", category: "UTILITY", body: "תודה על השיחה {{1}}", variables: ["1"], status: "APPROVED" } });
    const l = await lead(agent.id); await db.contact.update({ where: { id: l.contactId }, data: { consentStatus: "OPTED_IN" } });
    const call = await db.call.create({ data: { businessId: a.business.id, userId: agent.id, contactId: l.contactId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000002", fromE164: "x", status: "ended", answeredAt: new Date(), endedAt: new Date(), outcomeSavedAt: new Date() } });
    const r = await postCallWa(await req(agent, `/api/dialer/call/${call.id}/whatsapp`, "POST", { templateId: tpl.id, variables: { "1": "דנה" } }), ctx({ id: call.id }));
    const j = await r.json(); expect(r.status).toBe(200);
    const msg = await db.message.findUniqueOrThrow({ where: { id: j.data.messageId } });
    expect(msg.templateId).toBe(tpl.id); expect(msg.status).not.toBe("FAILED");
    expect((await postCallWa(await req(agent2, `/api/dialer/call/${call.id}/whatsapp`, "POST", { templateId: tpl.id, variables: { "1": "x" } }), ctx({ id: call.id }))).status).toBe(404);
  });
});
