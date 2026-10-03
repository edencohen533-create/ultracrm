import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { billingProvider, sandboxToken } from "@/server/billing/provider";
import { SandboxBillingButtons } from "./buttons";

export const dynamic = "force-dynamic";

/** SANDBOX platform-billing "payment page": no card fields, no money – approve / decline simulate the provider. */
export default async function SandboxBillingPay({ params, searchParams }: { params: Promise<{ documentId: string }>; searchParams: Promise<{ t?: string }> }) {
  const { documentId } = await params; const { t } = await searchParams;
  if (billingProvider()?.key !== "sandbox" || t !== sandboxToken(documentId)) notFound();
  const doc = await withoutBusiness(() => db.billingDocument.findUnique({ where: { id: documentId }, select: { number: true, totalMinor: true, currency: true, status: true, lines: true } }));
  if (!doc) notFound();
  return (
    <main dir="rtl" className="mx-auto max-w-sm p-5 text-sm" data-testid="sandbox-billing">
      <p className="rounded-md bg-amber-100 p-2 text-amber-900">סביבת בדיקה של חיוב Solina CRM – לא מתבצע חיוב ואין להזין פרטי כרטיס.</p>
      <h1 className="mt-4 text-lg font-semibold">מסמך {doc.number}</h1>
      <ul className="mt-2 text-xs text-gray-600">{(doc.lines as Array<{ name: string; quantity: number; amountMinor: number }>).map((l, i) => <li key={i}>{l.name} × {l.quantity} – ₪{(l.amountMinor / 100).toFixed(2)}</li>)}</ul>
      <p className="mt-2 text-2xl font-bold">₪{(doc.totalMinor / 100).toFixed(2)} <span className="text-xs font-normal">כולל מע״מ</span></p>
      {doc.status === "open" || doc.status === "failed" ? <SandboxBillingButtons documentId={documentId} t={t!} /> : <p className="mt-4" data-testid="sandbox-status">סטטוס: {doc.status}</p>}
    </main>
  );
}
