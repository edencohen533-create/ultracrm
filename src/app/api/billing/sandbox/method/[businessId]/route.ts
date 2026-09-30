import { z } from "zod";
import { withoutBusiness } from "@/lib/tenant";
import { billingProvider, deliverSandboxEvent, sandboxToken } from "@/server/billing/provider";

export const dynamic = "force-dynamic";
/** SANDBOX "update payment method" (the provider's secure component in real life) – ok or a card that will decline. */
export async function POST(req: Request, { params }: { params: Promise<{ businessId: string }> }) {
  if (billingProvider()?.key !== "sandbox") return Response.json({ error: "sandbox disabled" }, { status: 404 });
  const { businessId } = await params;
  const b = z.object({ t: z.string(), card: z.enum(["ok", "fail"]) }).safeParse(await req.json().catch(() => ({})));
  if (!b.success || b.data.t !== sandboxToken(businessId)) return Response.json({ error: "invalid" }, { status: 403 });
  const r = await withoutBusiness(() => deliverSandboxEvent({ type: "payment_method.updated", businessId, paymentMethodRef: `sandbox_pm_${b.data.card === "fail" ? "fail_" : ""}${crypto.randomUUID().slice(0, 8)}`, paymentMethodLabel: b.data.card === "fail" ? "כרטיס בדיקה שנדחה •••• 0002" : "כרטיס בדיקה •••• 4242" }));
  return Response.json({ result: r.result });
}
