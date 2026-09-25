/**
 * Embedded Signup – SIMULATED Meta. Every Graph API call is answered by an in-process fake
 * (`fakeGraph`) so the flow, its guards and the persisted mapping are verified end-to-end
 * against the real database without any Meta credentials. Live-Meta behaviour is covered
 * only by the manual checklist in docs/WHATSAPP_EMBEDDED_SIGNUP.md.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "test-app-secret-not-real";
process.env.META_ES_CONFIG_ID = "9999999999";
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-token-test";
process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");

const { startSignup, completeSignup, cancelSignup, checkConnection, disconnectConnection, runSetupSteps, deriveReadiness, applyAccountUpdate } = await import("@/server/services/embedded-signup-service");
const { POST: startRoute } = await import("@/app/api/whatsapp/signup/start/route");
const { POST: actionRoute } = await import("@/app/api/whatsapp/connection/[id]/route");
const { GET: webhookGet, POST: webhookPost } = await import("@/app/api/webhooks/whatsapp/route");
const { openSecret } = await import("@/lib/crypto");

// ───────────────────────── fake Meta Graph ─────────────────────────
const WABA = "111000111000111";
const PHONE = "222000222000222";
const OTHER_PHONE = "333000333000333";
const VALID_CODE = "AQD-valid-code-1234567890";
const TOKEN = "EAAB-business-token-never-logged";

interface Fake { subscribed: Set<string>; registered: Set<string>; pinRequired: boolean; scopes: string[]; granularWabas: string[] | null; tokenValid: boolean; calls: string[]; failSubscribe: boolean; phoneInWaba: boolean }
const fake: Fake = { subscribed: new Set(), registered: new Set(), pinRequired: false, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], granularWabas: [WABA], tokenValid: true, calls: [], failSubscribe: false, phoneInWaba: true };
function resetFake() { Object.assign(fake, { subscribed: new Set(), registered: new Set(), pinRequired: false, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], granularWabas: [WABA], tokenValid: true, calls: [], failSubscribe: false, phoneInWaba: true }); }
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const graphError = (message: string, code: number, status = 400, subcode?: number) => json({ error: { message, code, error_subcode: subcode, type: "OAuthException" } }, status);

const realFetch = globalThis.fetch;
function fakeGraph(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
  fake.calls.push(`${method} ${path}`);
  if (path === "oauth/access_token") {
    if (url.searchParams.get("client_secret") !== process.env.META_APP_SECRET) return Promise.resolve(graphError("Invalid client secret", 1));
    return Promise.resolve(url.searchParams.get("code") === VALID_CODE ? json({ access_token: TOKEN, token_type: "bearer" }) : graphError("Invalid or expired code", 100, 400, 36007));
  }
  if (path === "debug_token") {
    if (url.searchParams.get("access_token") !== `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`) return Promise.resolve(graphError("Invalid app token", 190, 401));
    return Promise.resolve(json({ data: { app_id: process.env.META_APP_ID, is_valid: fake.tokenValid, scopes: fake.scopes, granular_scopes: fake.granularWabas ? fake.scopes.map((scope) => ({ scope, target_ids: fake.granularWabas })) : [], type: "SYSTEM_USER" } }));
  }
  if (auth !== `Bearer ${TOKEN}` || !fake.tokenValid) return Promise.resolve(graphError("Error validating access token", 190, 401));
  if (path === WABA) return Promise.resolve(json({ id: WABA, name: "Test WABA", account_review_status: "APPROVED" }));
  if (path === `${WABA}/phone_numbers`) return Promise.resolve(json({ data: fake.phoneInWaba ? [{ id: PHONE }, { id: OTHER_PHONE }] : [{ id: OTHER_PHONE }], paging: { cursors: {} } }));
  if (path === PHONE || path === OTHER_PHONE) return Promise.resolve(json({ id: path, display_phone_number: path === PHONE ? "+972 50-000-0001" : "+972 50-000-0002", verified_name: "Test Biz", name_status: "APPROVED", code_verification_status: "VERIFIED", quality_rating: "GREEN", platform_type: "CLOUD_API" }));
  if (path === `${WABA}/subscribed_apps`) {
    if (method === "POST") { if (fake.failSubscribe) return Promise.resolve(graphError("Temporary failure", 2, 500)); fake.subscribed.add(WABA); return Promise.resolve(json({ success: true })); }
    if (method === "DELETE") { fake.subscribed.delete(WABA); return Promise.resolve(json({ success: true })); }
    return Promise.resolve(json({ data: fake.subscribed.has(WABA) ? [{ whatsapp_business_api_data: { id: process.env.META_APP_ID, name: "UltraCRM" } }] : [] }));
  }
  if (path.endsWith("/register") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (fake.pinRequired && body.pin !== "654321") return Promise.resolve(graphError("Two step verification PIN mismatch", 133, 400, 2388093));
    fake.registered.add(path.split("/")[0]); return Promise.resolve(json({ success: true }));
  }
  if (path.endsWith("/messages") && method === "POST") return Promise.resolve(json({ messaging_product: "whatsapp", messages: [{ id: `wamid.test.${Date.now()}` }] }));
  return Promise.resolve(graphError(`Unknown fake path ${method} ${path}`, 100, 404));
}

// ───────────────────────── helpers ─────────────────────────
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET!).update(body, "utf8").digest("hex");
async function authed(url: string, user: SessionUser, body: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: JSON.stringify(body) });
}
const startFor = (user: SessionUser) => withBusiness(user.businessId, () => startSignup(user), user);
const completeFor = (user: SessionUser, input: Parameters<typeof completeSignup>[1]) => withBusiness(user.businessId, () => completeSignup(user, input), user);

describe("WhatsApp Embedded Signup (simulated Meta)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let agent: SessionUser;
  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeGraph);
    // Leftovers from an aborted run would collide on the globally-unique phone id.
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-es-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-es-" } } });
    a = await createBusiness("es-a", { modules: { messaging: true } });
    b = await createBusiness("es-b", { modules: { messaging: true } });
    const acc = await db.account.create({ data: { email: `${a.business.slug}-agent@test.local`, fullName: "Agent", passwordHash: await bcrypt.hash("Test1234!", 4) } });
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: "Agent", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: "Agent", role: "agent", teamId: null };
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await destroyBusiness(a.business.id, [a.account.id, agent.accountId]);
    await destroyBusiness(b.business.id, [b.account.id]);
  });
  beforeEach(resetFake);

  it("unauthorized: agent role cannot start a signup (server-side, not only UI)", async () => {
    const res = await startRoute(await authed("/api/whatsapp/signup/start", agent, {}), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    const anon = await startRoute(new NextRequest("http://localhost/api/whatsapp/signup/start", { method: "POST" }), { params: Promise.resolve({}) });
    expect(anon.status).toBe(401);
  });

  it("start returns only public config (app id, config id, state) and reuses the open session on a double click", async () => {
    const res = await startRoute(await authed("/api/whatsapp/signup/start", a.session, {}), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(Object.keys(body).sort()).toEqual(["appId", "configId", "expiresAt", "reused", "state", "version"]);
    expect(JSON.stringify(body)).not.toContain(process.env.META_APP_SECRET);
    const again = (await (await startRoute(await authed("/api/whatsapp/signup/start", a.session, {}), { params: Promise.resolve({}) })).json()).data;
    expect(again.state).toBe(body.state);
    expect(again.reused).toBe(true);
    expect(await db.whatsAppSignupSession.count({ where: { businessId: a.business.id, status: "started" } })).toBe(1);
  });

  it("CSRF: a state issued to business A cannot be completed by business B (and never touches Meta)", async () => {
    const s = await db.whatsAppSignupSession.findFirstOrThrow({ where: { businessId: a.business.id, status: "started" } });
    await expect(completeFor(b.session, { state: s.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "signup_state_mismatch" });
    await expect(completeFor(a.session, { state: "not-a-real-state-xxxxxxxxxxxxxxxx", code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "signup_state_mismatch" });
    expect(fake.calls).toEqual([]);
  });

  it("cancel from the popup marks the session cancelled; nothing is created", async () => {
    const s = await db.whatsAppSignupSession.findFirstOrThrow({ where: { businessId: a.business.id, status: "started" } });
    expect((await withBusiness(a.business.id, () => cancelSignup(a.session, s.state, "user closed", "BUSINESS_ACCOUNT_SELECTION"), a.session)).cancelled).toBe(true);
    expect((await db.whatsAppSignupSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("cancelled");
    expect(await db.providerCredential.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("invalid / expired code → failure recorded, no credential, session single-use", async () => {
    const { session } = await startFor(a.session);
    await expect(completeFor(a.session, { state: session.state, code: "AQD-bad", wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect((await db.whatsAppSignupSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("failed");
    // The same state cannot be replayed with a good code afterwards.
    await expect(completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "signup_already_claimed" });
    expect(await db.providerCredential.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("missing permission → refused with the missing scope named; token discarded", async () => {
    fake.scopes = ["whatsapp_business_management"];
    const { session } = await startFor(a.session);
    await expect(completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "scopes_missing", details: { missing: ["whatsapp_business_messaging"] } });
    expect(await db.providerCredential.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("phone id not inside the granted WABA → refused (ids from the window are never trusted)", async () => {
    fake.phoneInWaba = false;
    const { session } = await startFor(a.session);
    await expect(completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "phone_not_in_waba" });
  });

  it("partial failure (subscribe fails) → needs_action with token kept; retry completes without duplicates", async () => {
    fake.failSubscribe = true;
    const { session } = await startFor(a.session);
    const r = await completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE });
    expect(r.status).toBe("needs_action");
    const c = await db.providerCredential.findUniqueOrThrow({ where: { id: r.credentialId } });
    expect(c.subscribedAt).toBeNull();
    expect(c.registeredAt).toBeNull();
    expect((c.config as Record<string, string>).accessToken).toMatch(/^enc:v1:/);         // sealed at rest
    expect(openSecret((c.config as Record<string, string>).accessToken)).toBe(TOKEN);
    expect(JSON.stringify(c)).not.toContain(TOKEN);   // raw token never in the row
    fake.failSubscribe = false;
    const retry = await withBusiness(a.business.id, () => runSetupSteps(a.session, c.id), a.session);
    expect(retry.status).toBe("connected");
    expect(await db.providerCredential.count({ where: { phoneNumberId: PHONE } })).toBe(1);
    const done = await db.providerCredential.findUniqueOrThrow({ where: { id: c.id } });
    expect(done.subscribedAt).not.toBeNull();
    expect(done.registeredAt).not.toBeNull();
    expect(done.status).toBe("connected");
    expect(done.wabaId).toBe(WABA);
    expect(done.connectionMethod).toBe("embedded_signup");
    expect(done.isDefault).toBe(true);
    expect(fake.subscribed.has(WABA)).toBe(true);
    expect(fake.registered.has(PHONE)).toBe(true);
  });

  it("cross-business: the same phone cannot be linked to business B while A holds it", async () => {
    const { session } = await startFor(b.session);
    await expect(completeFor(b.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE })).rejects.toMatchObject({ code: "phone_bound_elsewhere" });
    expect(await db.providerCredential.count({ where: { businessId: b.business.id } })).toBe(0);
  });

  it("re-running signup for the same phone updates the existing row (no duplicate credential)", async () => {
    const { session } = await startFor(a.session);
    const r = await completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE });
    expect(r.status).toBe("connected");
    expect(await db.providerCredential.count({ where: { businessId: a.business.id, provider: "meta_whatsapp_cloud_api" } })).toBe(1);
  });

  it("2FA pin required → needs_action with pin prompt; submitting the right pin completes registration", async () => {
    fake.pinRequired = true;
    const c = await db.providerCredential.findFirstOrThrow({ where: { phoneNumberId: PHONE } });
    const r1 = await withBusiness(a.business.id, () => runSetupSteps(a.session, c.id), a.session);
    expect(r1.status).toBe("needs_action");
    expect(r1.error).toMatch(/דו-שלבי/);
    const res = await actionRoute(await authed(`/api/whatsapp/connection/${c.id}`, a.session, { action: "retry_setup", pin: "654321" }), { params: Promise.resolve({ id: c.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("connected");
    const cfg = (await db.providerCredential.findUniqueOrThrow({ where: { id: c.id } })).config as Record<string, string>;
    expect(openSecret(cfg.twoStepPin)).toBe("654321");
  });

  it("check connection: revoked at Meta → status revoked + sending blocked, history intact", async () => {
    const c = await db.providerCredential.findFirstOrThrow({ where: { phoneNumberId: PHONE } });
    fake.tokenValid = false;
    const r = await withBusiness(a.business.id, () => checkConnection(a.session, c.id), a.session);
    expect(r.status).toBe("revoked");
    expect((await db.providerCredential.findUniqueOrThrow({ where: { id: c.id } })).sendingBlocked).toBe(true);
    // Grant restored at Meta while the app subscription is still in place → check reports connected again.
    fake.tokenValid = true;
    fake.subscribed.add(WABA);
    const ok = await withBusiness(a.business.id, () => checkConnection(a.session, c.id), a.session);
    expect(ok.status).toBe("connected");
    expect((await db.providerCredential.findUniqueOrThrow({ where: { id: c.id } })).sendingBlocked).toBe(false);
  });

  it("readiness never reports 'connected' from a closed window alone – it needs subscribe + register", () => {
    const base = { isActive: true, sendingBlocked: false, subscribedAt: null, registeredAt: null, codeVerificationStatus: "VERIFIED", tokenCheckedAt: new Date(), lastWebhookAt: null, grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging"], lastConnectionError: null };
    expect(deriveReadiness({ ...base, status: "needs_action", subscribedAt: new Date(), registeredAt: new Date(), lastConnectionError: "pin" }).status).toBe("needs_action");
    expect(deriveReadiness({ ...base, status: "connected" }).status).toBe("connected_not_ready");
    expect(deriveReadiness({ ...base, status: "connected", subscribedAt: new Date() }).sendReady).toBe(false);
    expect(deriveReadiness({ ...base, status: "connected", subscribedAt: new Date(), registeredAt: new Date() }).status).toBe("connected");
    expect(deriveReadiness({ ...base, status: "connected", isActive: false }).status).toBe("disconnected");
  });

  it("disconnect requires explicit confirm, unsubscribes at Meta, keeps the row/history and blocks sends", async () => {
    const c = await db.providerCredential.findFirstOrThrow({ where: { phoneNumberId: PHONE } });
    const noConfirm = await actionRoute(await authed(`/api/whatsapp/connection/${c.id}`, a.session, { action: "disconnect" }), { params: Promise.resolve({ id: c.id }) });
    expect(noConfirm.status).toBe(400);
    const byAgent = await actionRoute(await authed(`/api/whatsapp/connection/${c.id}`, agent, { action: "disconnect", confirm: true }), { params: Promise.resolve({ id: c.id }) });
    expect(byAgent.status).toBe(403);
    const r = await withBusiness(a.business.id, () => disconnectConnection(a.session, c.id, "test"), a.session);
    expect(r.unsubscribed).toBe(true);
    expect(fake.subscribed.has(WABA)).toBe(false);
    const after = await db.providerCredential.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.isActive).toBe(false);
    expect(after.status).toBe("disconnected");
    expect(after.wabaId).toBe(WABA); // mapping/history retained
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "whatsapp.disconnected" } })).toBe(1);
  });

  it("reconnect after disconnect re-uses the same row and returns to connected", async () => {
    const { session } = await startFor(a.session);
    const r = await completeFor(a.session, { state: session.state, code: VALID_CODE, wabaId: WABA, phoneNumberId: PHONE });
    expect(r.status).toBe("connected");
    expect(await db.providerCredential.count({ where: { phoneNumberId: PHONE } })).toBe(1);
    expect((await db.providerCredential.findUniqueOrThrow({ where: { id: r.credentialId } })).isActive).toBe(true);
  });

  describe("webhook", () => {
    const post = (body: unknown, sig?: string | null) => webhookPost(new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", ...(sig === null ? {} : { "x-hub-signature-256": sig ?? sign(JSON.stringify(body)) }) }, body: JSON.stringify(body) }));
    const inbound = (id: string) => ({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "972500000001", phone_number_id: PHONE }, contacts: [{ wa_id: "972509990001", profile: { name: "Test Sender" } }], messages: [{ id, from: "972509990001", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "שלום מבדיקה" } }] } }] }] });

    it("GET verification answers only the app-level verify token", async () => {
      const okRes = await webhookGet(new Request(`http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${process.env.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc123`));
      expect(okRes.status).toBe(200);
      expect(await okRes.text()).toBe("abc123");
      const bad = await webhookGet(new Request("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123"));
      expect(bad.status).toBe(403);
    });

    it("wrong / missing signature → 401 and nothing stored", async () => {
      const body = inbound("wamid.sig-test");
      expect((await post(body, "sha256=" + "0".repeat(64))).status).toBe(401);
      expect((await post(body, null)).status).toBe(401);
      expect(await db.message.count({ where: { inboundKey: "wamid.sig-test" } })).toBe(0);
    });

    it("signed inbound message lands in business A's inbox on the right contact; duplicate delivery stored once", async () => {
      const id = `wamid.dup-${Date.now()}`;
      expect((await post(inbound(id))).status).toBe(200);
      expect((await post(inbound(id))).status).toBe(200); // Meta retries
      const msgs = await db.message.findMany({ where: { inboundKey: id }, include: { conversation: { include: { contact: true } } } });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].conversation.businessId).toBe(a.business.id);
      expect(msgs[0].conversation.contact.phoneE164).toBe("+972509990001");
      const cred = await db.providerCredential.findFirstOrThrow({ where: { phoneNumberId: PHONE } });
      expect(cred.lastWebhookAt).not.toBeNull();
    });

    it("inbound 'הסר' feeds the global suppression list", async () => {
      const body = inbound(`wamid.unsub-${Date.now()}`);
      body.entry[0].changes[0].value.messages[0].text.body = "הסר";
      expect((await post(body)).status).toBe(200);
      const contact = await db.contact.findFirstOrThrow({ where: { businessId: a.business.id, phoneE164: "+972509990001" } });
      expect(await db.suppression.count({ where: { businessId: a.business.id, contactId: contact.id, revokedAt: null } })).toBeGreaterThan(0);
    });

    it("account_update PARTNER_REMOVED (routed by WABA id) marks the connection revoked", async () => {
      const body = { object: "whatsapp_business_account", entry: [{ id: WABA, time: 1, changes: [{ field: "account_update", value: { event: "PARTNER_REMOVED", waba_info: { waba_id: WABA, owner_business_id: "5550001" } } }] }] };
      expect((await post(body)).status).toBe(200);
      const cred = await db.providerCredential.findFirstOrThrow({ where: { phoneNumberId: PHONE } });
      expect(cred.status).toBe("revoked");
      expect(cred.sendingBlocked).toBe(true);
      expect(deriveReadiness(cred).sendReady).toBe(false);
      expect(await applyAccountUpdate("000-unknown", "PARTNER_REMOVED")).toBe(0);
    });
  });
});
