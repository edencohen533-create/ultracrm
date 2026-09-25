import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { metaWebhookSchema, InvalidWebhookError } from "@/lib/validation/whatsapp-webhook";
import { db as systemDatabase } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { MetaWhatsAppProvider } from "@/server/providers/meta-whatsapp-provider";
import { metaAppEnv, metaConfigOf } from "@/lib/meta/graph";
import { applyAccountUpdate } from "@/server/services/embedded-signup-service";

export const maxDuration = 60;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** App-level signature (one App Secret for every WABA connected through Embedded Signup). */
function verifyAppSignature(headers: Headers, rawBody: string) {
  const secret = metaAppEnv().appSecret;
  const header = headers.get("x-hub-signature-256");
  if (!secret || !header) return false;
  return safeEqual(header, "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
}

/** Meta calls this once when the callback URL is saved in the App Dashboard, then per re-verification. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (!token || url.searchParams.get("hub.mode") !== "subscribe" || challenge === null) return NextResponse.json({ error: "Verification failed" }, { status: 403 });
  const appToken = metaAppEnv().webhookVerifyToken;
  if (appToken && safeEqual(token, appToken)) return new NextResponse(challenge);
  // Manual (per-number) connections keep their own verify token.
  const credentials = await systemDatabase.providerCredential.findMany({
    where: { provider: "meta_whatsapp_cloud_api", config: { path: ["webhookVerifyToken"], equals: token } },
  });
  for (const credential of credentials) {
    const provider = new MetaWhatsAppProvider(metaConfigOf(credential.config), credential.id);
    const c = provider.verifyWebhookChallenge("subscribe", token, challenge);
    if (c !== null) return new NextResponse(c);
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > 2_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = metaWebhookSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });

  const changes = parsed.data.entry.flatMap((entry) => entry.changes.map((change) => ({ entryId: entry.id, change })));
  const phoneIds = [...new Set(changes.map(({ change }) => change.value.metadata?.phone_number_id).filter((id): id is string => Boolean(id)))];
  const wabaIds = [...new Set(changes.map(({ entryId, change }) => change.value.waba_info?.waba_id ?? entryId).filter((id): id is string => Boolean(id)))];
  if (!phoneIds.length && !wabaIds.length) return NextResponse.json({ error: "Missing phone number" }, { status: 400 });

  // Untrusted IDs only select signature-verification keys. Nothing is touched until the signature is verified.
  const appSigned = verifyAppSignature(request.headers, rawBody);
  const credentials = phoneIds.length ? await systemDatabase.providerCredential.findMany({ where: { provider: "meta_whatsapp_cloud_api", phoneNumberId: { in: phoneIds } } }) : [];
  const providers = credentials.map((credential) => ({ credential, provider: new MetaWhatsAppProvider(metaConfigOf(credential.config), credential.id) }));
  if (!appSigned) {
    // Fallback: every addressed number must carry its own App Secret (manual connections) and the signature must match it.
    if (!providers.length || providers.some(({ provider }) => !provider.verifyWebhook(request.headers, rawBody))) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Account-level events (account_update etc.) are routed by WABA id from the stored mapping.
  for (const { entryId, change } of changes) {
    if (change.field === "messages") continue;
    const wabaId = change.value.waba_info?.waba_id ?? entryId;
    if (!wabaId) continue;
    if (!appSigned && !providers.some(({ credential }) => credential.wabaId === wabaId)) continue;
    await applyAccountUpdate(wabaId, change.value.event ?? change.field, { field: change.field, phone: change.value.display_phone_number ?? null, decision: change.value.decision ?? null, currentLimit: change.value.current_limit ?? null });
  }

  // Inactive credentials still receive delivery receipts. Phone bindings are globally unique and never transferred automatically.
  for (const { credential, provider } of providers) {
    if (!await systemDatabase.business.findFirst({ where: { id: credential.businessId, isActive: true }, select: { id: true } })) continue;
    try { await withBusiness(credential.businessId, async () => {
      await provider.receiveWebhook(parsed.data);
      // A signed, schema-valid provider event was processed for this number.
      const { prisma } = await import("@/lib/db");
      await prisma.providerCredential.update({ where: { id: credential.id }, data: { lastWebhookAt: new Date() } });
    }); }
    catch (error) {
      if (error instanceof InvalidWebhookError) return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
      throw error;
    }
  }
  return NextResponse.json({ ok: true });
}
