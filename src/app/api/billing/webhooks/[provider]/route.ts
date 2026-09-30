import { withoutBusiness } from "@/lib/tenant";
import { handleBillingWebhook } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
/** Platform billing provider webhooks – signature verified, deduped by event id, verified with the provider, applied once. */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const raw = await req.text();
  if (raw.length > 200_000) return Response.json({ error: "too large" }, { status: 413 });
  const r = await withoutBusiness(async () => handleBillingWebhook((await params).provider, req.headers, raw));
  return Response.json({ result: r.result }, { status: r.status });
}
