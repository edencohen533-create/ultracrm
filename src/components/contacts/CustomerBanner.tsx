"use client";

import { useT } from "@/components/i18n/LangProvider";
import { formatDateTime } from "@/lib/client/format";

export interface CustomerSummary {
  isCustomer: boolean;
  purchases: number;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
  handler: { id: string; fullName: string } | null;
  handlerInactive: { id: string; fullName: string } | null;
  openInquiries: Array<{ id: string; status: string; owner: string | null }>;
}

/** Prominent "לקוח קיים" strip – shown before dialing (dialer card) and on the lead / contact. Facts only. */
export function CustomerBanner({ customer, className = "" }: { customer: CustomerSummary | null | undefined; className?: string }) {
  const t = useT();
  if (!customer?.isCustomer) return null;
  return (
    <div role="note" className={`rounded-lg border border-[#b7e4c7] bg-[#ecf9f0] px-3 py-2 text-sm text-[#14532d] ${className}`} data-testid="customer-banner">
      <p className="font-semibold">{t("לקוח קיים", "Existing customer")} · {customer.purchases === 1 ? t("רכישה אחת", "1 purchase") : `${customer.purchases} ${t("רכישות", "purchases")}`}{customer.lastPurchaseAt ? ` · ${t("אחרונה", "last")} ${formatDateTime(customer.lastPurchaseAt)}` : ""}</p>
      <p className="text-xs mt-0.5">
        {customer.handler ? <>{t("נציג מטפל", "Handling agent")}: <b>{customer.handler.fullName}</b></> : customer.handlerInactive ? <>{t("הנציג המטפל אינו פעיל", "Handling agent inactive")} ({customer.handlerInactive.fullName}) – {t("ממתין לשיוך מנהל", "awaiting a manager")}</> : t("אין נציג מטפל", "No handling agent")}
        {customer.openInquiries.length > 0 && <> · {t("פניות פעילות", "Open inquiries")}: {customer.openInquiries.length}</>}
      </p>
    </div>
  );
}
