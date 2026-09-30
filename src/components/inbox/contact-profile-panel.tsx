"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/i18n/LangProvider";
import { Badge } from "@/components/ui/badge";
import { Ltr } from "@/components/shared/ltr";
import { DEAL_STAGE_LABEL, LEAD_STATUS_LABEL } from "@/lib/crm/labels";
import type { CustomerFile } from "@/server/services/customer-file-service";

interface Extra {
  consentStatus: string;
  tags: { tag: { id: string; name: string; color: string } }[];
}

const CONSENT_LABELS: Record<string, [string, string]> = {
  OPTED_IN: ["הסכים לדיוור שיווקי", "Opted in to marketing"],
  OPTED_OUT: ["הוסר מדיוור שיווקי", "Opted out of marketing"],
  UNKNOWN: ["לא ידוע", "Unknown"],
};

const CASE_LABEL: Record<string, string> = { not_ordered: "המוצר לא הוזמן", ordered_not_received: "בירור חוסר באספקה", partial: "כמות חלקית – בירור", shipped_separately: "נשלח בנפרד – בירור", promised: "טענה להבטחה", conflict: "סתירה בין מקורות", needs_info: "חסר מידע" };

/** "תיק לקוח" – fixed on the conversation's side on wide screens (the left side in RTL). */
export function ContactProfilePanel({ file, extra }: { file: CustomerFile; extra: Extra }) {
  const t = useT();
  return (
    <aside aria-label={t("תיק לקוח", "Customer file")} data-testid="customer-file" className="hidden h-full w-80 shrink-0 flex-col overflow-y-auto border-s bg-panel lg:flex">
      <FileBody file={file} extra={extra} />
    </aside>
  );
}

/** Narrow screens: the same file in a drawer opened from the conversation header. */
export function CustomerFileDrawerButton({ file, extra }: { file: CustomerFile; extra: Extra }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button type="button" data-testid="customer-file-open" onClick={() => setOpen(true)} className="rounded-md border border-line px-2 py-1 text-xs font-medium lg:hidden" aria-expanded={open}>
        {t("תיק לקוח", "Customer file")}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label={t("סגירה", "Close")} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label={t("תיק לקוח", "Customer file")} data-testid="customer-file-drawer" className="absolute inset-y-0 end-0 flex w-[min(420px,92vw)] flex-col bg-panel shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <span className="text-sm font-semibold">{t("תיק לקוח", "Customer file")}</span>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-sm" aria-label={t("סגירה", "Close")}>✕</button>
            </div>
            <div className="flex-1 overflow-y-auto"><FileBody file={file} extra={extra} /></div>
          </div>
        </div>
      )}
    </>
  );
}

/** A value the CRM does not have is shown as missing – never filled in. */
function Missing() {
  const t = useT();
  return <span className="italic text-muted">{t("חסר", "Missing")}</span>;
}
function Row({ label, value }: { label: string; value: React.ReactNode | null }) {
  return <div className="flex justify-between gap-3 py-0.5 text-sm"><span className="shrink-0 text-muted">{label}</span><span className="min-w-0 break-words text-end">{value ?? <Missing />}</span></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-t border-line px-4 py-3"><h3 className="mb-1.5 text-xs font-semibold text-muted">{title}</h3>{children}</section>;
}

function FileBody({ file, extra }: { file: CustomerFile; extra: Extra }) {
  const t = useT();
  const locale = t.lang === "en" ? "en-GB" : "he-IL";
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : null);
  const money = (v: number | null, cur: string | null) => {
    if (v == null) return null;
    try { return new Intl.NumberFormat(locale, { style: "currency", currency: cur || "ILS", maximumFractionDigits: 2 }).format(v); } catch { return `${v} ${cur ?? ""}`.trim(); }
  };
  const missing = <Missing />;
  const c = file.contact;
  const lead = file.leads.find((l) => l.open) ?? file.leads[0] ?? null;
  const isCustomer = file.purchases.length > 0 || file.orders.length > 0;
  const consent = CONSENT_LABELS[extra.consentStatus];

  return (
    <div className="flex flex-col">
      <div className="px-4 py-3">
        <p className="text-base font-semibold" dir="auto">{c.name}</p>
        <p className="text-sm text-muted"><Ltr>{c.phone}</Ltr></p>
        {c.email && <p className="text-sm text-muted"><Ltr>{c.email}</Ltr></p>}
        <div className="mt-2 flex flex-wrap gap-1">
          {isCustomer && <Badge variant="secondary">{t("לקוח", "Customer")}</Badge>}
          {lead?.open && <Badge variant="outline">{t("ליד פתוח", "Open lead")}</Badge>}
          {consent && <Badge variant="outline">{t(consent[0], consent[1])}</Badge>}
        </div>
      </div>

      {file.restricted && (
        <Section title={t("נתוני CRM", "CRM data")}>
          <p className="text-sm text-muted">{file.restricted === "no_crm" ? t("אין לך הרשאת צפייה ב-CRM, לכן מוצגים רק פרטי הקשר.", "You don't have CRM view permission, so only contact details are shown.") : t("איש הקשר משויך לנציג אחר – פרטי הליד והרכישות אינם מוצגים לך.", "This contact belongs to another agent – lead and purchase details are hidden.")}</p>
        </Section>
      )}

      {!file.restricted && (
        <>
          <Section title={t("ליד", "Lead")}>
            {lead ? (
              <>
                <Row label={t("נציג מטפל", "Owner")} value={lead.owner} />
                <Row label={t("סטטוס", "Status")} value={LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] ?? lead.status} />
                <Row label={t("מקור", "Source")} value={lead.source ?? c.source} />
                <Row label={t("מוצר", "Product")} value={c.product} />
                <Row label={t("קמפיין", "Campaign")} value={c.campaign ?? lead.campaignId} />
                <Row label={t("מודעה", "Ad")} value={c.ad ?? lead.adId} />
                <Row label={t("נוצר", "Created")} value={date(lead.createdAt)} />
                {file.leads.length > 1 && <p className="mt-1 text-xs text-muted">{t(`עוד ${file.leads.length - 1} לידים קודמים`, `${file.leads.length - 1} more earlier leads`)}</p>}
              </>
            ) : <p className="text-sm text-muted">{t("אין ליד לאיש הקשר", "No lead for this contact")}</p>}
            {file.hiddenLeads > 0 && <p className="mt-1 text-xs text-muted">{t(`${file.hiddenLeads} לידים נוספים משויכים לנציג אחר`, `${file.hiddenLeads} more leads belong to another agent`)}</p>}
          </Section>

          {file.opportunities.length > 0 && (
            <Section title={t("הזדמנויות מכירה פתוחות", "Open sales opportunities")}>
              <ul className="space-y-2">{file.opportunities.map((d) => (
                <li key={d.id} className="rounded-md border border-line p-2 text-sm">
                  <p className="font-medium" dir="auto">{d.title}</p>
                  <p className="text-xs text-muted">{DEAL_STAGE_LABEL[d.stage as keyof typeof DEAL_STAGE_LABEL] ?? d.stage} · {money(d.amount, d.currency)}{d.owner ? ` · ${d.owner}` : ""}{d.expectedCloseAt ? ` · ${t("צפי", "Expected")} ${date(d.expectedCloseAt)}` : ""}</p>
                </li>
              ))}</ul>
            </Section>
          )}

          <Section title={t("רכישות", "Purchases")}>
            {file.purchases.length === 0 ? <p className="text-sm text-muted">{t("אין רכישות רשומות", "No recorded purchases")}</p> : (
              <ul className="space-y-2">{file.purchases.map((d) => (
                <li key={d.id} className="rounded-md border border-line p-2 text-sm" data-testid="purchase">
                  <div className="flex justify-between gap-2"><span className="font-medium" dir="auto">{d.title}</span><span className="shrink-0">{money(d.amount, d.currency)}</span></div>
                  <p className="text-xs text-muted">{date(d.closedAt) ?? t("תאריך חסר", "Date missing")}{d.owner ? ` · ${d.owner}` : ""}</p>
                  {d.items.length > 0 && <ul className="mt-1 space-y-0.5 text-xs">{d.items.map((i, n) => (
                    <li key={n} dir="auto">{i.name} × {i.quantity} · {money(i.unitPrice, d.currency)}{i.endsAt ? ` · ${t("עד", "until")} ${date(i.endsAt)}` : ""}</li>
                  ))}</ul>}
                </li>
              ))}</ul>
            )}
          </Section>

          {file.orders.length > 0 && (
            <Section title={t("הזמנות מהחנות", "Store orders")}>
              <ul className="space-y-2">{file.orders.map((o) => (
                <li key={o.id} className="rounded-md border border-line p-2 text-sm">
                  <div className="flex justify-between gap-2"><span className="font-medium">{o.orderId ? t(`הזמנה ${o.orderId}`, `Order ${o.orderId}`) : t("הזמנה (מספר חסר)", "Order (number missing)")}</span><span className="shrink-0">{money(o.total, o.currency) ?? missing}</span></div>
                  <p className="text-xs text-muted">{date(o.at) ?? t("תאריך חסר", "Date missing")} · {o.store}</p>
                  {o.items.length > 0 && <ul className="mt-1 space-y-0.5 text-xs">{o.items.map((i, n) => <li key={n} dir="auto">{i.name}{i.quantity != null ? ` × ${i.quantity}` : ""}{i.price != null ? ` · ${money(i.price, o.currency)}` : ""}</li>)}</ul>}
                  {o.status && <p className="mt-1 text-[11px] text-muted">{t("סטטוס", "Status")}: {o.status}</p>}
                  {o.shipments && o.shipments.length > 0 && <ul className="mt-1 space-y-0.5 text-[11px] text-muted">{o.shipments.map((sh, n) => <li key={n} dir="auto">📦 {sh}</li>)}</ul>}
                  {o.receiptUrl && <a href={o.receiptUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-xs text-accent underline" data-testid="order-receipt">{t("קבלה", "Receipt")}</a>}
                </li>
              ))}</ul>
            </Section>
          )}
        </>
      )}

      {file.cases.length > 0 && (
        <Section title={t("בירורים", "Inquiries")}>
          <ul className="space-y-2" data-testid="service-cases">{file.cases.map((k) => (
            <li key={k.id} className="rounded-md border border-line p-2 text-xs" data-testid={`service-case-${k.id}`}>
              <div className="flex justify-between gap-2"><span className="font-medium">{CASE_LABEL[k.finding] ?? k.finding}{k.orderNumber ? ` · ${t("הזמנה", "Order")} ${k.orderNumber}` : ""}</span><span className={k.status === "open" ? "text-warn" : "text-muted"}>{k.status === "open" ? t("פתוח", "Open") : k.status === "resolved" ? t("טופל", "Resolved") : t("הוסבר ללקוח", "Explained")}</span></div>
              <p className="mt-1 whitespace-pre-wrap" dir="auto">{k.summary}</p>
              {k.sources.length > 0 && <details className="mt-1"><summary className="cursor-pointer text-muted">{t("מקורות", "Sources")} ({k.sources.length})</summary><ul className="mt-1 space-y-0.5">{k.sources.map((src, n) => <li key={n} dir="auto">• {src.label}{src.at ? ` · ${date(src.at) ?? ""}` : ""}</li>)}</ul></details>}
            </li>
          ))}</ul>
        </Section>
      )}

      <Section title={t("קבלות ומסמכים", "Receipts & documents")}>
        {file.documents.length === 0 ? <p className="text-sm text-muted">{t("אין קבלות או מסמכים בשיחות עם הלקוח", "No receipts or documents in conversations with this customer")}</p> : (
          <ul className="space-y-1">{file.documents.map((d) => (
            <li key={d.id} className="text-sm"><a href={d.url} target="_blank" rel="noreferrer" className="break-all text-accent underline" data-testid="customer-document">{d.fileName || t("קובץ", "File")}</a> <span className="text-xs text-muted">· {date(d.createdAt)}</span></li>
          ))}</ul>
        )}
        <p className="mt-1 text-[11px] text-muted">{t("צפייה בלבד – שום מסמך לא נשלח שוב ללקוח מכאן.", "View only – nothing is re-sent to the customer from here.")}</p>
      </Section>

      <Section title={t("תגיות", "Tags")}>
        <div className="flex flex-wrap gap-1">
          {extra.tags.length === 0 && <span className="text-xs text-muted">{t("אין תגיות", "No tags")}</span>}
          {extra.tags.map(({ tag }) => <Badge key={tag.id} variant="outline">{tag.name}</Badge>)}
        </div>
      </Section>

      <div className="border-t border-line px-4 py-3"><Link href={`/contacts/${c.id}`} className="text-sm underline">{t("לכרטיס הלקוח המלא", "Open the full customer card")}</Link></div>
    </div>
  );
}
