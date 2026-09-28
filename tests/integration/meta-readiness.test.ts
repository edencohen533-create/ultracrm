/**
 * Meta App Review readiness (real DB): signed data-deletion / deauthorize callbacks, template status and quality
 * webhooks, the public support form, self-service user deletion and scheduled business deletion + purge.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { parseSignedRequest } from "@/server/services/meta-deletion-service";
import { POST as deletionPOST } from "@/app/api/meta/data-deletion/route";
import { POST as deauthPOST } from "@/app/api/meta/deauthorize/route";
import { POST as webhookPOST } from "@/app/api/webhooks/whatsapp/route";
import { POST as supportPOST } from "@/app/api/public/support/route";
import { deleteMyUser, requestBusinessDeletion, cancelBusinessDeletion, purgeDueBusinesses } from "@/server/services/account-deletion-service";

const SECRET = "test-app-secret-meta";
let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
const accounts: string[] = [];
const b64 = (x: Buffer | string) => Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signed = (payload: object, secret = SECRET) => { const p = b64(JSON.stringify(payload)); return `${b64(crypto.createHmac("sha256", secret).update(p).digest())}.${p}`; };
const form = (sr: string) => new Request("http://localhost/api/meta/data-deletion", { method: "POST", body: new URLSearchParams({ signed_request: sr }) });
const hook = (body: object) => { const raw = JSON.stringify(body); return new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }); };

describe("Meta review readiness", { timeout: 600_000 }, () => {
  let prev: string | undefined;
  beforeAll(async () => {
    prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = SECRET;
    a = await createBusiness("meta-ready", { modules: { crm: true, whatsapp: true } });
    b = await createBusiness("meta-ready-b", { modules: { crm: true, whatsapp: true } });
    accounts.push(a.account.id, b.account.id);
  }, 300_000);
  afterAll(async () => { process.env.META_APP_SECRET = prev; if (a) await destroyBusiness(a.business.id).catch(() => undefined); if (b) await destroyBusiness(b.business.id).catch(() => undefined); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("signed_request: valid is decoded, tampered / wrong secret rejected", () => {
    expect(parseSignedRequest(signed({ user_id: "123", algorithm: "HMAC-SHA256" }), SECRET).user_id).toBe("123");
    expect(() => parseSignedRequest(signed({ user_id: "123" }, "other"), SECRET)).toThrow();
    const [sig] = signed({ user_id: "123" }).split(".");
    expect(() => parseSignedRequest(`${sig}.${b64(JSON.stringify({ user_id: "999" }))}`, SECRET)).toThrow();
  });

  it("data deletion callback → the linked WhatsApp connection is disconnected and erased; status by code; other businesses untouched", async () => {
    const mk = (businessId: string, uid: string, phone: string) => db.providerCredential.create({ data: { businessId, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, wabaId: `w${phone}`, phoneNumberId: phone, displayPhoneNumber: `+972 5${phone}`, config: { accessToken: "sealed:x" }, metaUserIds: [uid] } });
    const mine = await mk(a.business.id, "fb-111", String(Date.now()).slice(-9));
    const other = await mk(b.business.id, "fb-222", String(Date.now() + 1).slice(-9));
    const res = await deletionPOST(form(signed({ user_id: "fb-111", algorithm: "HMAC-SHA256" })));
    expect(res.status).toBe(200);
    const j = await res.json() as { url: string; confirmation_code: string };
    expect(j.url).toContain(`/data-deletion?code=${j.confirmation_code}`);
    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ isActive: false, status: "revoked", config: {}, metaUserIds: [] });
    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ isActive: true });
    expect(await db.metaDeletionRequest.findUniqueOrThrow({ where: { confirmationCode: j.confirmation_code } })).toMatchObject({ status: "completed", businessIds: [a.business.id] });
    expect((await deletionPOST(form("bad.sig"))).status).toBe(400);
    expect((await deauthPOST(form(signed({ user_id: "fb-222" })))).status).toBe(200);
    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ isActive: false, status: "revoked" });
  });

  it("webhooks: template status (approved / rejected with reason) and messaging tier update in real time", async () => {
    const waba = `w${Date.now()}`;
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, wabaId: waba, phoneNumberId: String(Date.now()).slice(-10), displayPhoneNumber: "+972 50-123-4567", config: {} } });
    const tpl = await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "welcome", language: "he", category: "UTILITY", body: "x", status: "PENDING_APPROVAL", providerTemplateId: "777", providerAccountId: waba } });
    const entry = (field: string, value: object) => ({ object: "whatsapp_business_account", entry: [{ id: waba, changes: [{ field, value }] }] });
    expect((await webhookPOST(hook(entry("message_template_status_update", { event: "REJECTED", message_template_id: 777, message_template_name: "welcome", message_template_language: "he", reason: "INVALID_FORMAT" })))).status).toBe(200);
    expect(await db.template.findUniqueOrThrow({ where: { id: tpl.id } })).toMatchObject({ status: "REJECTED", syncError: "Meta: REJECTED – INVALID_FORMAT" });
    await webhookPOST(hook(entry("message_template_status_update", { event: "APPROVED", message_template_id: 777, reason: "NONE" })));
    expect(await db.template.findUniqueOrThrow({ where: { id: tpl.id } })).toMatchObject({ status: "APPROVED", syncError: null });
    await webhookPOST(hook(entry("phone_number_quality_update", { display_phone_number: "972501234567", event: "UPGRADE", current_limit: "TIER_10K" })));
    expect((await db.providerCredential.findFirstOrThrow({ where: { wabaId: waba } })).messagingLimitTier).toBe("TIER_10K");
  });

  it("support form: stored, validated, rate-limited per sender", async () => {
    const send = (body: object) => supportPOST(new Request("http://localhost/api/public/support", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) }));
    expect((await send({ name: "A", email: "bad", topic: "support", message: "hi" })).status).toBe(400);
    const ok = { name: "Test Reviewer", email: "r@example.com", topic: "privacy", message: "Please delete my data", lang: "en" };
    for (let i = 0; i < 5; i++) expect((await send(ok)).status).toBe(201);
    expect((await send(ok)).status).toBe(429);
    await db.supportRequest.deleteMany({ where: { email: "r@example.com" } });
  });

  it("delete my user: personal details erased, sole owner refused; business deletion: scheduled, tokens erased at once, cancel, purge after the date", async () => {
    await expect(withBusiness(a.business.id, () => deleteMyUser(a.session))).rejects.toMatchObject({ code: "last_owner" });
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "דנה כהן", passwordHash: "x" } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: "דנה כהן", role: "agent", personalPhone: "+972501112233" } });
    const agent: SessionUser = { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: "דנה כהן", role: "agent", teamId: null };
    await withBusiness(a.business.id, () => deleteMyUser(agent), agent);
    expect(await db.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ isActive: false, fullName: "משתמש שנמחק", personalPhone: null });
    expect((await db.account.findUniqueOrThrow({ where: { id: acc.id } })).email).toMatch(/@deleted\.invalid$/);
    // Business deletion (owner, typed name).
    await expect(requestBusinessDeletion(b.session, "לא השם")).rejects.toMatchObject({ code: "confirm_mismatch" });
    await expect(requestBusinessDeletion({ ...b.session, role: "manager" }, b.business.name)).rejects.toMatchObject({ status: 403 });
    const cred = await db.providerCredential.create({ data: { businessId: b.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, config: { accessToken: "sealed:y" } } });
    const r = await requestBusinessDeletion(b.session, b.business.name);
    expect(r.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    expect(await db.providerCredential.findUniqueOrThrow({ where: { id: cred.id } })).toMatchObject({ isActive: false, config: {} });
    await cancelBusinessDeletion(b.session);
    expect((await db.business.findUniqueOrThrow({ where: { id: b.business.id } })).deletionScheduledFor).toBeNull();
    await requestBusinessDeletion(b.session, b.business.name);
    expect(await purgeDueBusinesses()).toBe(0);
    await db.business.update({ where: { id: b.business.id }, data: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueBusinesses()).toBe(1);
    expect(await db.business.findUnique({ where: { id: b.business.id } })).toBeNull();
    expect(await db.account.findUnique({ where: { id: b.account.id } })).toBeNull();
  });
});
