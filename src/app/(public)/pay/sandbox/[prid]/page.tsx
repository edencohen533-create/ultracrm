import { notFound } from "next/navigation";
import { sandboxPage } from "@/server/services/payment-service";
import { SandboxPayButtons } from "./buttons";

export const dynamic = "force-dynamic";

/** The sandbox provider's "payment page": a test stand-in with NO card fields – it can never collect or charge a card. */
export default async function SandboxPay({ params }: { params: Promise<{ prid: string }> }) {
  const { prid } = await params;
  if (!/^sbx_[a-f0-9]{24}$/.test(prid)) notFound();
  const r = await sandboxPage(prid);
  if (!r) notFound();
  return (
    <main dir="rtl" className="mx-auto max-w-sm p-5 text-sm" data-testid="sandbox-pay">
      <p className="rounded-md bg-amber-100 p-2 text-amber-900">סביבת בדיקה – לא מתבצע חיוב ואין להזין פרטי כרטיס.</p>
      <h1 className="mt-4 text-lg font-semibold">{r.description}</h1>
      <p className="mt-1 text-2xl font-bold">₪{(r.amountAgorot / 100).toFixed(2)}</p>
      {r.status === "pending" ? <SandboxPayButtons prid={prid} /> : <p className="mt-4" data-testid="sandbox-status">סטטוס: {r.status}</p>}
    </main>
  );
}
