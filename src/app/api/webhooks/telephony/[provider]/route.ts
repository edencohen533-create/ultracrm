import { NextRequest, NextResponse } from "next/server";
import type { TelephonyProvider } from "@/generated/prisma/enums";
import { adapterFor, knownProviders } from "@/lib/telephony/registry";
import { processProviderEvent } from "@/lib/telephony/events";

export const dynamic = "force-dynamic";

/**
 * Generic provider webhook: /api/webhooks/telephony/<provider>. Signature (with its replay window) is verified by the
 * provider's adapter on the raw body; the event is stored before it is applied, duplicates and late / reversed
 * events are safe, and a processing error answers 500 so the provider retries (the replay sweep is the safety net).
 * Telnyx keeps its original URL /api/webhooks/telnyx.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!knownProviders().includes(provider as TelephonyProvider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const adapter = adapterFor(provider as TelephonyProvider);
  if (adapter.simulation || !adapter.verifyWebhook || !adapter.parseWebhook) return NextResponse.json({ error: "provider has no webhooks" }, { status: 404 });
  const raw = await req.text();
  if (!adapter.verifyWebhook(raw, req.headers)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const ev = adapter.parseWebhook(body);
  if (!ev) return NextResponse.json({ ignored: true });
  try {
    const r = await processProviderEvent(ev);
    return NextResponse.json({ ok: true, duplicate: r.duplicate });
  } catch (err) {
    console.error(`[webhook/${provider}] processing failed`, err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
