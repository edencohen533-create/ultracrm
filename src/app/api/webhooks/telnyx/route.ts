import { NextRequest, NextResponse } from "next/server";
import { parseTelnyxWebhook, verifyTelnyxSignature } from "@/lib/telephony/telnyx";
import { processProviderEvent } from "@/lib/telephony/events";

export const dynamic = "force-dynamic";

/**
 * Telnyx Call Control webhooks. Signature is verified against the account
 * public key (Ed25519). Duplicate / out-of-order deliveries are safe.
 * Always answer quickly with 200 once the event is persisted.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!verifyTelnyxSignature(raw, sig, ts)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const ev = parseTelnyxWebhook(body as Parameters<typeof parseTelnyxWebhook>[0]);
  if (!ev) return NextResponse.json({ ignored: true });
  try {
    const r = await processProviderEvent(ev);
    return NextResponse.json({ ok: true, duplicate: r.duplicate, callId: r.callId });
  } catch (err) {
    console.error("[webhook/telnyx] processing failed", err);
    // 500 makes Telnyx retry – processing is idempotent so that is safe.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
