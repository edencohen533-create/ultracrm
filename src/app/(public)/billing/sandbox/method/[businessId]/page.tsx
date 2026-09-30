import { notFound } from "next/navigation";
import { billingProvider, sandboxToken } from "@/server/billing/provider";
import { SandboxMethodButtons } from "./buttons";

export const dynamic = "force-dynamic";
/** SANDBOX "update payment method" – the real provider's secure component would appear here. No card fields. */
export default async function SandboxMethod({ params, searchParams }: { params: Promise<{ businessId: string }>; searchParams: Promise<{ t?: string }> }) {
  const { businessId } = await params; const { t } = await searchParams;
  if (billingProvider()?.key !== "sandbox" || t !== sandboxToken(businessId)) notFound();
  return (
    <main dir="rtl" className="mx-auto max-w-sm p-5 text-sm" data-testid="sandbox-method">
      <p className="rounded-md bg-amber-100 p-2 text-amber-900">סביבת בדיקה – עדכון אמצעי תשלום מדומה. אין להזין פרטי כרטיס.</p>
      <SandboxMethodButtons businessId={businessId} t={t!} />
    </main>
  );
}
