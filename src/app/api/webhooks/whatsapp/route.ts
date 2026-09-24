import { NextResponse } from "next/server";
import { metaWebhookSchema, InvalidWebhookError } from "@/lib/validation/whatsapp-webhook";
import { db as systemDatabase } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { MetaWhatsAppProvider, type MetaWhatsAppConfig } from "@/server/providers/meta-whatsapp-provider";

export const maxDuration = 60;
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("hub.verify_token");
  if (!token || url.searchParams.get("hub.mode") !== "subscribe") return NextResponse.json({ error: "Verification failed" }, { status: 403 });
  const credentials = await systemDatabase.providerCredential.findMany({
    where: { provider: "meta_whatsapp_cloud_api", config: { path: ["webhookVerifyToken"], equals: token } },
  });
  for (const credential of credentials) {
    const provider = new MetaWhatsAppProvider(credential.config as unknown as MetaWhatsAppConfig, credential.id);
    const challenge = provider.verifyWebhookChallenge("subscribe", token, url.searchParams.get("hub.challenge"));
    if (challenge !== null) return new NextResponse(challenge);
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
  const phoneIds = [...new Set(parsed.data.entry.flatMap((entry) => entry.changes.map((change) => change.value.metadata?.phone_number_id)).filter((id): id is string => Boolean(id)))];
  if (!phoneIds.length) return NextResponse.json({ error: "Missing phone number" }, { status: 400 });
  // Untrusted IDs only select a signature-verification key. No tenant data is touched until every signature is checked.
  const credentials = await systemDatabase.providerCredential.findMany({ where: { provider: "meta_whatsapp_cloud_api", phoneNumberId: { in: phoneIds } } });
  const providers = credentials.map((credential) => ({ credential, provider: new MetaWhatsAppProvider(credential.config as unknown as MetaWhatsAppConfig, credential.id) }));
  if (!providers.length || providers.some(({ provider }) => !provider.verifyWebhook(request.headers, rawBody))) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
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
