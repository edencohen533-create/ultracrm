import { handlePaymentWebhook } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Provider notification: verified with this connection's secret, stored once, then the status is asked from the provider. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const raw = await req.text();
  if (raw.length > 200_000) return Response.json({ error: "too large" }, { status: 413 });
  try {
    const r = await handlePaymentWebhook(connectionId, raw, req.headers);
    return Response.json({ ok: r.status === 200 }, { status: r.status });
  } catch (e) {
    console.error("[payments] webhook failed", (e as Error).message.slice(0, 200));
    return Response.json({ error: "retry" }, { status: 500 }); // the provider retries; nothing was applied twice
  }
}
