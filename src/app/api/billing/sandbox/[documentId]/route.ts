import { z } from "zod";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { billingProvider, deliverSandboxEvent, sandboxToken } from "@/server/billing/provider";

export const dynamic = "force-dynamic";
/** SANDBOX payment page action (no money, no card data): approve / decline → a signed provider webhook. */
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  if (billingProvider()?.key !== "sandbox") return Response.json({ error: "sandbox disabled" }, { status: 404 });
  const { documentId } = await params;
  const b = z.object({ t: z.string(), outcome: z.enum(["approve", "decline"]) }).safeParse(await req.json().catch(() => ({})));
  if (!b.success || b.data.t !== sandboxToken(documentId)) return Response.json({ error: "invalid" }, { status: 403 });
  const doc = await withoutBusiness(() => db.billingDocument.findUnique({ where: { id: documentId }, select: { id: true, status: true } }));
  if (!doc) return Response.json({ error: "not found" }, { status: 404 });
  const ref = `sbx_pay_${crypto.randomUUID()}`;
  const r = await withoutBusiness(() => deliverSandboxEvent({ type: b.data.outcome === "approve" ? "payment.succeeded" : "payment.failed", documentId, providerPaymentRef: ref, paymentMethodRef: b.data.outcome === "approve" ? `sandbox_pm_${crypto.randomUUID().slice(0, 8)}` : null, paymentMethodLabel: b.data.outcome === "approve" ? "כרטיס בדיקה •••• 4242" : null, reason: b.data.outcome === "decline" ? "נדחה בסביבת הבדיקה" : null }));
  return Response.json({ result: r.result });
}
