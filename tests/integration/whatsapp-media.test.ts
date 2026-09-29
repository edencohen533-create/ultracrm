/**
 * Template header images + WhatsApp connection rules (real DB, Graph API faked in-process – no Meta account):
 *  • chunked upload → checks (JPG/PNG, ≤ 5 MB, 8-bit RGB/RGBA, bytes match the type) → preview; retried chunk is
 *    harmless, wrong offset refused; bad files rejected with a clear reason and removed;
 *  • stored per business: another business cannot read / continue / delete it;
 *  • template submission sends the uploaded bytes to the Resumable Upload API and uses the handle as the sample;
 *  • sending uploads the image to the number (POST /{phone}/media) once and reuses the media id until it expires;
 *  • an existing link-based template still sends its link (compatibility);
 *  • a phone / WABA connected to one business cannot be connected to another; only authorized roles may connect.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, afterEach, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { sealMetaConfig, metaConfigOf } from "@/lib/meta/graph";
import { startImageUpload, appendChunk, finishUpload, deleteAsset, UPLOAD_CHUNK_BYTES } from "@/server/services/media-asset-service";
import { submitMetaTemplate } from "@/server/services/template-submit-service";
import { MetaWhatsAppProvider } from "@/server/providers/meta-whatsapp-provider";
import { assetsTakenElsewhere } from "@/server/services/embedded-signup-service";
import { effectiveAccess, can } from "@/lib/access/engine";
import { GET as mediaGET } from "@/app/api/media/[id]/route";
import { POST as signupStart } from "@/app/api/whatsapp/signup/start/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const realFetch = globalThis.fetch;
const PHONE_ID = `1${String(Date.now()).slice(-12)}`;
const WABA_ID = `2${String(Date.now()).slice(-12)}`;
let credentialId: string;

/** A PNG header with the given bit depth / color type, padded to `size` bytes. */
function png(size: number, depth = 8, color = 2) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(800, 16); b.writeUInt32BE(418, 20); b[24] = depth; b[25] = color;
  for (let i = 33; i < size; i++) b[i] = i % 251;
  return b;
}
/** A JPEG with an SOF0 header (8-bit, `comps` components). */
function jpeg(comps = 3) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xa2, 0x03, 0x20, comps, ...Buffer.alloc(15), 0xff, 0xd9]);
}
async function uploadAll(u: SessionUser, bytes: Buffer, mimeType = "image/png", fileName = "hero.png") {
  const a = await run(u, () => startImageUpload(u, { fileName, mimeType, sizeBytes: bytes.length }));
  for (let o = 0; o < bytes.length; o += UPLOAD_CHUNK_BYTES) await run(u, () => appendChunk(u, a.id, o, bytes.subarray(o, o + UPLOAD_CHUNK_BYTES)));
  return run(u, () => finishUpload(u, a.id));
}
const req = async (u: SessionUser, url: string, method = "GET") => new NextRequest(`http://localhost${url}`, { method, headers: { origin: "http://localhost", cookie: `ultracrm_session=${await signSession(u)}` } });

describe("template header images + connection rules", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    process.env.META_APP_ID = process.env.META_APP_ID || "1234567890";
    A = await createBusiness("wa-media-a", { modules: { crm: true, whatsapp: true } });
    B = await createBusiness("wa-media-b", { modules: { crm: true, whatsapp: true } });
    accounts.push(A.account.id, B.account.id);
    const cred = await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, isDefault: true, status: "connected", wabaId: WABA_ID, phoneNumberId: PHONE_ID, displayPhoneNumber: "+972 50-000-0000",
      config: sealMetaConfig({ accessToken: "EAAtest", phoneNumberId: PHONE_ID, businessAccountId: WABA_ID, webhookVerifyToken: "v" }) as object } });
    credentialId = cred.id;
  }, 600_000);
  afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch; });
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("chunked upload of a valid image (>1 MB); retried chunk is harmless; wrong offset refused; preview only for its business", async () => {
    const bytes = png(Math.round(2.4 * 1024 * 1024));
    const a = await run(A.session, () => startImageUpload(A.session, { fileName: "hero.png", mimeType: "image/png", sizeBytes: bytes.length }));
    await run(A.session, () => appendChunk(A.session, a.id, 0, bytes.subarray(0, UPLOAD_CHUNK_BYTES)));
    // The same first chunk again (network retry) → no duplicate bytes.
    expect(await run(A.session, () => appendChunk(A.session, a.id, 0, bytes.subarray(0, UPLOAD_CHUNK_BYTES)))).toEqual({ received: UPLOAD_CHUNK_BYTES });
    await expect(run(A.session, () => appendChunk(A.session, a.id, 5, bytes.subarray(5, 10)))).rejects.toMatchObject({ code: "bad_offset" });
    // Another business cannot continue, finish or delete it.
    await expect(run(B.session, () => appendChunk(B.session, a.id, UPLOAD_CHUNK_BYTES, bytes.subarray(UPLOAD_CHUNK_BYTES, 2 * UPLOAD_CHUNK_BYTES)))).rejects.toMatchObject({ status: 404 });
    await expect(run(A.session, () => finishUpload(A.session, a.id))).rejects.toMatchObject({ code: "incomplete" });
    for (let o = UPLOAD_CHUNK_BYTES; o < bytes.length; o += UPLOAD_CHUNK_BYTES) await run(A.session, () => appendChunk(A.session, a.id, o, bytes.subarray(o, o + UPLOAD_CHUNK_BYTES)));
    const done = await run(A.session, () => finishUpload(A.session, a.id));
    expect(done).toMatchObject({ status: "ready", width: 800, height: 418, sizeBytes: bytes.length });
    const stored = await run(A.session, () => db.mediaAsset.findUniqueOrThrow({ where: { id: a.id } }));
    expect(Buffer.from(stored.data).equals(bytes)).toBe(true);
    const own = await run(A.session, async () => mediaGET(await req(A.session, `/api/media/${a.id}`), { params: Promise.resolve({ id: a.id }) }));
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("image/png");
    const other = await run(B.session, async () => mediaGET(await req(B.session, `/api/media/${a.id}`), { params: Promise.resolve({ id: a.id }) }));
    expect(other.status).toBe(404);
    await expect(run(B.session, () => deleteAsset(B.session, a.id))).rejects.toMatchObject({ status: 404 });
  });

  it("rejects: wrong type, over 5 MB, bytes not matching the type, palette PNG, CMYK JPEG – each with a reason, bad files removed", async () => {
    await expect(run(A.session, () => startImageUpload(A.session, { fileName: "a.gif", mimeType: "image/gif", sizeBytes: 100 }))).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(run(A.session, () => startImageUpload(A.session, { fileName: "big.png", mimeType: "image/png", sizeBytes: 5 * 1024 * 1024 + 1 }))).rejects.toMatchObject({ code: "file_too_large" });
    await expect(uploadAll(A.session, jpeg(), "image/png", "fake.png")).rejects.toMatchObject({ code: "type_mismatch" });
    await expect(uploadAll(A.session, png(4000, 8, 3))).rejects.toThrow(/פלטת צבעים/);
    await expect(uploadAll(A.session, png(4000, 16, 2))).rejects.toThrow(/8 ביט/);
    await expect(uploadAll(A.session, jpeg(4), "image/jpeg", "cmyk.jpg")).rejects.toThrow(/CMYK/);
    expect((await uploadAll(A.session, jpeg(3), "image/jpeg", "ok.jpg")).status).toBe("ready");
    expect((await uploadAll(A.session, png(4000, 8, 6))).status).toBe("ready"); // RGBA
    expect(await run(A.session, () => db.mediaAsset.count({ where: { businessId: A.business.id, status: "deleted", data: { equals: Buffer.alloc(0) } } }))).toBeGreaterThanOrEqual(4);
  });

  it("submission: the uploaded bytes go to the Resumable Upload API; the handle is the template sample; the template keeps the image", async () => {
    const bytes = png(300_000);
    const asset = await uploadAll(A.session, bytes);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes(`/${process.env.META_APP_ID}/uploads?`)) return Response.json({ id: "upload:MTphdHRhY2g" });
      if (url.includes("/upload:MTphdHRhY2g")) return Response.json({ h: "4::aW1hZ2UtaGFuZGxl" });
      if (url.endsWith(`/${WABA_ID}/message_templates`)) return Response.json({ id: "778899", status: "PENDING" });
      return new Response("unexpected", { status: 500 });
    });
    const tpl = await run(A.session, () => submitMetaTemplate({ name: `promo_${Date.now()}`, language: "he", category: "MARKETING", header: { format: "IMAGE", mediaAssetId: asset.id }, body: "מבצע חדש!", examples: {}, buttons: [] }));
    expect(tpl).toMatchObject({ status: "PENDING_APPROVAL", providerTemplateId: "778899", headerMediaAssetId: asset.id });
    const start = calls.find((c) => c.url.includes("/uploads?"))!;
    expect(start.url).toContain(`file_length=${bytes.length}`); expect(start.url).toContain("file_type=image%2Fpng");
    const put = calls.find((c) => c.url.includes("/upload:"))!;
    expect(Buffer.from(put.init!.body as Uint8Array).equals(bytes)).toBe(true);
    expect((put.init!.headers as Record<string, string>).file_offset).toBe("0");
    const submitted = JSON.parse(String(calls.find((c) => c.url.endsWith("/message_templates"))!.init!.body));
    expect(submitted.components[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2UtaGFuZGxl"] } });
    // In use → cannot be deleted.
    await expect(run(A.session, () => deleteAsset(A.session, asset.id))).rejects.toMatchObject({ code: "in_use" });
    // Another business cannot submit with A's image.
    await db.providerCredential.create({ data: { businessId: B.business.id, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true, isDefault: true, wabaId: `9${WABA_ID.slice(1)}`, phoneNumberId: `9${PHONE_ID.slice(1)}`, config: sealMetaConfig({ accessToken: "EAAb", phoneNumberId: `9${PHONE_ID.slice(1)}`, businessAccountId: `9${WABA_ID.slice(1)}`, webhookVerifyToken: "v" }) as object } });
    await expect(run(B.session, () => submitMetaTemplate({ name: `steal_${Date.now()}`, language: "he", category: "MARKETING", header: { format: "IMAGE", mediaAssetId: asset.id }, body: "x", examples: {}, buttons: [] }))).rejects.toThrow(/לא נמצאה/);
  });

  it("sending: the image is uploaded to the number once, sent by media id, re-uploaded after expiry; link templates still use their link", async () => {
    const asset = await uploadAll(A.session, png(200_000));
    const tpl = await db.template.create({ data: { businessId: A.business.id, name: `img_${Date.now()}`, language: "he", body: "שלום", status: "APPROVED", providerTemplateId: "555", providerAccountId: WABA_ID, headerFormat: "IMAGE", headerMediaAssetId: asset.id } });
    const media: string[] = []; const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/${PHONE_ID}/media`)) { const f = init!.body as FormData; media.push(String(f.get("type"))); return Response.json({ id: `1${media.length}00` }); }
      if (url.endsWith(`/${PHONE_ID}/messages`)) { sent.push(JSON.parse(String(init!.body))); return Response.json({ messages: [{ id: `wamid.${sent.length}` }] }); }
      return new Response("unexpected", { status: 500 });
    });
    const cred = await run(A.session, () => db.providerCredential.findUniqueOrThrow({ where: { id: credentialId } }));
    const provider = new MetaWhatsAppProvider(metaConfigOf(cred.config), credentialId);
    const send = () => run(A.session, () => provider.sendTemplate({ conversationId: "", to: "+972501234567", type: "TEMPLATE", templateId: tpl.id, templateVariables: {} }));
    expect((await send()).status).toBe("ACCEPTED");
    expect((await send()).status).toBe("ACCEPTED");
    expect(media).toEqual(["image/png"]); // uploaded once, reused
    const header = (m: Record<string, unknown>) => ((m.template as { components: Array<{ type: string; parameters: unknown[] }> }).components.find((c) => c.type === "header")!.parameters[0]);
    expect(header(sent[0])).toEqual({ type: "image", image: { id: "1100" } });
    expect(header(sent[1])).toEqual({ type: "image", image: { id: "1100" } });
    await run(A.session, () => db.mediaProviderUpload.updateMany({ where: { assetId: asset.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await send();
    expect(media).toHaveLength(2);
    expect(header(sent[2])).toEqual({ type: "image", image: { id: "1200" } });
    // Compatibility: an explicit link (older templates / campaigns) is sent as a link, no upload.
    await run(A.session, () => provider.sendTemplate({ conversationId: "", to: "+972501234567", type: "TEMPLATE", templateId: tpl.id, templateVariables: {}, templateMedia: { link: "https://example.com/a.jpg" } }));
    expect(header(sent[3])).toEqual({ type: "image", image: { link: "https://example.com/a.jpg" } });
    expect(media).toHaveLength(2);
    // Meta refuses the upload → a clear, retryable failure (nothing sent without the image).
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/media") ? Response.json({ error: { message: "bad" } }, { status: 400 }) : Response.json({ messages: [{ id: "x" }] }));
    await run(A.session, () => db.mediaProviderUpload.deleteMany({ where: { assetId: asset.id } }));
    expect(await send()).toMatchObject({ status: "FAILED", errorCode: "template_media_upload_failed", retryable: true });
  });

  it("connection: a phone or WABA of one business cannot be connected to another; only authorized roles may connect", async () => {
    expect(await assetsTakenElsewhere(B.business.id, { phoneNumberId: PHONE_ID })).toBe("phone");
    expect(await assetsTakenElsewhere(B.business.id, { phoneNumberId: "999", wabaId: WABA_ID })).toBe("waba");
    expect(await assetsTakenElsewhere(A.business.id, { phoneNumberId: PHONE_ID, wabaId: WABA_ID })).toBeNull();
    const mk = async (role: "manager" | "agent", teamScope = false) => {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: role, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
      const team = teamScope ? await db.team.create({ data: { businessId: A.business.id, name: `T${Date.now()}` } }) : null;
      const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: role, role, teamId: team?.id ?? null } });
      return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: role, role, teamId: team?.id ?? null } as SessionUser;
    };
    const manager = await mk("manager"); const agent = await mk("agent");
    expect(can(await effectiveAccess(A.business.id, A.user.id), "whatsapp.connect")).toBe(true);
    expect(can(await effectiveAccess(A.business.id, manager.id), "whatsapp.connect")).toBe(true);
    expect(can(await effectiveAccess(A.business.id, agent.id), "whatsapp.connect")).toBe(false);
    // Team-scoped managers (business setting) are not allowed unless granted explicitly.
    const x = await db.business.findUniqueOrThrow({ where: { id: A.business.id } });
    await db.business.update({ where: { id: A.business.id }, data: { settings: { ...(x.settings as object), permissions: { managerScope: "team" } } as object } });
    const teamManager = await mk("manager", true);
    const acc = await effectiveAccess(A.business.id, teamManager.id);
    expect(acc.template).toBe("team_manager");
    expect(can(acc, "whatsapp.connect")).toBe(false);
    const r = await signupStart(await req(teamManager, "/api/whatsapp/signup/start", "POST"), { params: Promise.resolve({}) });
    expect(r.status).toBe(403);
    const r2 = await signupStart(await req(agent, "/api/whatsapp/signup/start", "POST"), { params: Promise.resolve({}) });
    expect(r2.status).toBe(403);
  });
});
