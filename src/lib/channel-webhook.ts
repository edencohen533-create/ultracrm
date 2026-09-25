/**
 * Shared handler for SMS / email provider webhooks:
 *   /api/webhooks/{sms|email}/{provider}/{credentialId}
 * The credential id in the URL selects the verification key (public key / Svix secret) of ONE
 * business. Nothing is touched before the signature is verified; every event is de-duplicated.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailProviderFor, smsProviderFor } from "@/server/channels/registry";
import { ingestProviderEvents } from "@/server/services/delivery-status-service";

const PROVIDER_KEY: Record<string, Record<string, string>> = { sms: { telnyx: "telnyx_sms", mock: "mock_sms" }, email: { resend: "resend", mock: "mock_email" } };

export async function handleChannelWebhook(request: Request, channel: "sms" | "email", providerSlug: string, credentialId: string) {
  const providerKey = PROVIDER_KEY[channel]?.[providerSlug];
  if (!providerKey) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > 1_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const credential = await db.providerCredential.findFirst({ where: { id: credentialId, channel, provider: providerKey } });
  if (!credential) return NextResponse.json({ error: "Unknown credential" }, { status: 404 });
  const provider = channel === "sms" ? smsProviderFor(credential) : emailProviderFor(credential);
  if (!provider.verifyWebhook(request.headers, rawBody)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let events;
  try { events = provider.parseWebhook(rawBody); }
  catch { return NextResponse.json({ error: "Invalid payload" }, { status: 400 }); }
  // Svix/Telnyx deliver a stable per-event id in the headers; prefer it for de-duplication.
  const headerId = request.headers.get("svix-id");
  const results = await ingestProviderEvents(credential, headerId && events.length === 1 ? events.map((e) => ({ ...e, eventId: headerId })) : events);
  return NextResponse.json({ ok: true, results });
}
