"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Select } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

type Item = { id: string; name: string; amountAgorot: number; currency: string };
interface Req { id: string; status: string; amountAgorot: number; currency: string; description: string; paymentUrl: string | null; provider: string; approvalNumber: string | null; receiptUrl: string | null; failureReason: string | null; lateConfirmation: boolean; confirmedAt: string | null; callId: string | null; sentVia: string | null }
interface Options { connection: { connected: boolean; provider?: string; environment?: string }; canEditAmount: boolean; customer: { id: string; name: string; phone: string; email: string | null }; products: Item[]; quotes: Item[]; deals: Item[]; requests: Req[] }

const ils = (a: number) => `₪${(a / 100).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * "תשלום" during a call: a window inside the call screen (no navigation – the call and its audio are untouched).
 * The card is typed only into the provider's own page (embedded here, or a link to the customer). The status shown
 * is the provider's confirmation; closing the window changes nothing and the request keeps being tracked.
 */
export function PaymentModal({ contactId, callId, onClose }: { contactId: string; callId: string | null; onClose: () => void }) {
  const t = useT();
  const [o, setO] = useState<Options | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [req, setReq] = useState<Req | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const key = useRef<string>(newKey()); // one key per attempt – a double click / retry returns the same request

  useEffect(() => { api.get<Options>(`/api/payments/options?contactId=${encodeURIComponent(contactId)}${callId ? `&callId=${encodeURIComponent(callId)}` : ""}`).then((r) => {
    setO(r);
    const open = r.requests.find((x) => ["created", "pending"].includes(x.status) && (!callId || x.callId === callId)) ?? r.requests.find((x) => x.callId === callId && callId);
    if (open) setReq(open);
  }).catch((e) => setErr((e as Error).message)); }, [contactId, callId]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);

  // Track a pending request with the server (which asks the provider) – independent of this window's buttons.
  const refresh = useCallback(async (id: string) => { try { setReq(await api.get<Req>(`/api/payments/${id}`)); } catch { /* keep the last known state */ } }, []);
  useEffect(() => {
    if (!req || !["created", "pending", "cancelled"].includes(req.status)) return;
    const iv = setInterval(() => void refresh(req.id), 3000);
    return () => clearInterval(iv);
  }, [req, refresh]);

  const items: Array<Item & { type: "product" | "quote" | "deal" }> = o ? [...o.products.map((x) => ({ ...x, type: "product" as const })), ...o.quotes.map((x) => ({ ...x, type: "quote" as const })), ...o.deals.map((x) => ({ ...x, type: "deal" as const }))] : [];
  const chosen = pick === "custom" ? null : items.find((i) => `${i.type}:${i.id}` === pick) ?? null;
  const listAmount = chosen?.amountAgorot ?? null;
  const typed = amount.trim() ? Math.round(Number(amount.replace(",", ".")) * 100) : null;
  const finalAmount = o?.canEditAmount && typed ? typed : listAmount;

  async function create() {
    if (!o || (!chosen && pick !== "custom") || !finalAmount || finalAmount <= 0) return;
    setBusy("create");
    try {
      const r = await api.post<Req>("/api/payments", { contactId, callId, source: pick === "custom" ? { type: "custom" } : { type: chosen!.type, id: chosen!.id }, amountAgorot: finalAmount !== listAmount ? finalAmount : null, idempotencyKey: key.current });
      setReq(r);
      if (r.status === "failed") toast.error(r.failureReason ?? t("יצירת עמוד התשלום נכשלה", "Creating the payment page failed"));
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  }
  async function act(kind: "cancel" | "send") {
    if (!req) return;
    setBusy(kind);
    try { setReq(await api.post<Req>(`/api/payments/${req.id}/${kind}`, {})); if (kind === "send") toast.success(t("הקישור נשלח ללקוח בוואטסאפ", "The link was sent to the customer on WhatsApp")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const again = () => { key.current = newKey(); setReq(null); setAmount(""); };

  const STATUS: Record<string, [string, string, "good" | "bad" | "warn" | "neutral"]> = {
    created: ["נוצר", "Created", "neutral"], pending: ["ממתין לתשלום", "Waiting for payment", "warn"], succeeded: ["שולם – אושר על ידי הספק", "Paid – confirmed by the provider", "good"],
    failed: ["נכשל", "Failed", "bad"], cancelled: ["בוטל", "Cancelled", "neutral"], expired: ["פג תוקף", "Expired", "neutral"],
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3" role="dialog" aria-modal="true" aria-label={t("תשלום", "Payment")} data-testid="payment-modal">
      <div className="flex max-h-[95dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-panel shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 className="text-base font-semibold">{t("תשלום", "Payment")}{o?.connection.environment === "test" && <Badge tone="warn" className="ms-2">{t("סביבת בדיקה", "Test")}</Badge>}</h2>
          <button type="button" onClick={onClose} className="rounded px-2 py-1" aria-label={t("סגירה", "Close")} data-testid="payment-close">✕</button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          {err && <p role="alert" className="text-bad">{err}</p>}
          {!o && !err && <p className="text-muted">{t("טוען…", "Loading…")}</p>}
          {o && !o.connection.connected && <p className="text-muted" data-testid="payment-no-provider">{t("לא חובר ספק סליקה לעסק. בעל העסק יכול לחבר אותו בהגדרות → חיבורים → תשלומים.", "No payment provider is connected. The owner can connect one in Settings → Connections → Payments.")}</p>}
          {o && <div className="rounded-md bg-panel-2 p-2 text-xs"><b>{o.customer.name}</b> · <span dir="ltr">{o.customer.phone}</span>{o.customer.email ? <> · <span dir="ltr">{o.customer.email}</span></> : null}</div>}

          {o?.connection.connected && !req && (
            <>
              <Select label={t("עבור מה?", "For what?")} value={pick} onChange={(e) => { setPick(e.target.value); setAmount(""); key.current = newKey(); }} data-testid="payment-item">
                <option value="">{t("בחרו מוצר, הצעה או עסקה", "Choose a product, quote or deal")}</option>
                {o.products.length > 0 && <optgroup label={t("מוצרים", "Products")}>{o.products.map((p) => <option key={p.id} value={`product:${p.id}`}>{p.name} – {ils(p.amountAgorot)}</option>)}</optgroup>}
                {o.quotes.length > 0 && <optgroup label={t("הצעות מחיר שאושרו", "Approved quotes")}>{o.quotes.map((p) => <option key={p.id} value={`quote:${p.id}`}>{p.name} – {ils(p.amountAgorot)}</option>)}</optgroup>}
                {o.deals.length > 0 && <optgroup label={t("עסקאות פתוחות", "Open deals")}>{o.deals.map((p) => <option key={p.id} value={`deal:${p.id}`}>{p.name} – {ils(p.amountAgorot)}</option>)}</optgroup>}
                {o.canEditAmount && <option value="custom">{t("סכום אחר (ללא פריט)", "Other amount (no item)")}</option>}
              </Select>
              {(chosen || pick === "custom") && (
                <div className="flex flex-wrap items-end gap-3">
                  <div><p className="text-xs text-muted">{t("סכום לתשלום", "Amount to pay")}</p><p className="text-xl font-bold" data-testid="payment-amount">{finalAmount ? ils(finalAmount) : "—"}</p></div>
                  {o.canEditAmount ? <Input label={t("שינוי סכום (₪)", "Change amount (₪)")} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); key.current = newKey(); }} placeholder={listAmount ? (listAmount / 100).toFixed(2) : ""} ltr data-testid="payment-amount-edit" />
                    : <p className="text-xs text-muted">{t("שינוי סכום דורש הרשאה", "Changing the amount requires permission")}</p>}
                </div>
              )}
              <Button onClick={create} loading={busy === "create"} disabled={busy === "create" || !finalAmount || finalAmount <= 0} data-testid="payment-create">{t("צור עמוד תשלום מאובטח", "Create a secure payment page")}</Button>
              <p className="text-xs text-muted">{t("פרטי הכרטיס מוזנים רק בעמוד של ספק הסליקה – לא במערכת, לא בתיעוד ולא ב-AI.", "Card details are typed only on the provider's page – never in the CRM, the documentation or the AI.")}</p>
            </>
          )}

          {req && (
            <div className="space-y-2" data-testid="payment-request">
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="payment-status" data-status={req.status} role="status" aria-live="polite"><Badge tone={(STATUS[req.status] ?? STATUS.created)[2]}>{t((STATUS[req.status] ?? STATUS.created)[0], (STATUS[req.status] ?? STATUS.created)[1])}</Badge></span>
                <span>{req.description} · <b>{ils(req.amountAgorot)}</b></span>
              </div>
              {req.lateConfirmation && <p className="text-warn text-xs" data-testid="payment-late">{t("התשלום אושר אצל הספק אחרי שהבקשה בוטלה – הכסף נגבה.", "The provider confirmed the payment after the request was cancelled – the money was collected.")}</p>}
              {req.status === "succeeded" && <p className="text-xs">{req.approvalNumber ? t(`מספר אישור: ${req.approvalNumber}`, `Approval: ${req.approvalNumber}`) : null}{req.receiptUrl ? <> · <a className="underline" href={req.receiptUrl} target="_blank" rel="noreferrer">{t("קבלה", "Receipt")}</a></> : <span className="text-muted"> · {t("לא הופקה קבלה דרך הספק", "No receipt was issued by the provider")}</span>}</p>}
              {req.failureReason && req.status !== "succeeded" && <p className="text-bad text-xs" role="alert">{req.failureReason}</p>}
              {["created", "pending"].includes(req.status) && req.paymentUrl && (
                <>
                  <iframe src={req.paymentUrl} title={t("עמוד התשלום של ספק הסליקה", "Payment provider page")} className="h-[420px] w-full rounded-md border border-line bg-white" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation" referrerPolicy="no-referrer" data-testid="payment-frame" />
                  <div className="flex flex-wrap gap-2">
                    <a className="inline-flex h-8 items-center rounded-md border border-line px-3 text-xs" href={req.paymentUrl} target="_blank" rel="noreferrer">{t("פתח בחלון נפרד", "Open in a new window")}</a>
                    <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(req.paymentUrl!); toast.success(t("הקישור הועתק", "Link copied")); }}>{t("העתק קישור ללקוח", "Copy link for the customer")}</Button>
                    <Button size="sm" variant="secondary" loading={busy === "send"} onClick={() => act("send")} data-testid="payment-send">{req.sentVia ? t("נשלח בוואטסאפ ✓ – שלח שוב", "Sent on WhatsApp ✓ – send again") : t("שלח ללקוח בוואטסאפ", "Send to the customer on WhatsApp")}</Button>
                    <Button size="sm" variant="ghost" className="ms-auto text-bad" loading={busy === "cancel"} onClick={() => act("cancel")} data-testid="payment-cancel">{t("בטל בקשה", "Cancel request")}</Button>
                  </div>
                  <p className="text-xs text-muted">{t("הסטטוס מתעדכן לפי אישור מהספק. סגירת החלון לא מבטלת את הבקשה – אפשר להמשיך בשיחה ולחזור לכאן.", "The status follows the provider's confirmation. Closing this window doesn't cancel the request – you can continue the call and come back.")}</p>
                </>
              )}
              {["succeeded", "failed", "cancelled"].includes(req.status) && <Button size="sm" variant="ghost" onClick={again} data-testid="payment-new">{t("תשלום חדש", "New payment")}</Button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "תשלום" button for the call screens – opens the payment window over the call (no navigation). */
export function PaymentButton({ contactId, callId, size = "sm" }: { contactId: string | null | undefined; callId: string | null | undefined; size?: "sm" | "md" }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!contactId) return null;
  return (
    <>
      <Button size={size} variant="secondary" onClick={() => setOpen(true)} data-testid="payment-open">{t("תשלום", "Payment")}</Button>
      {open && <PaymentModal contactId={contactId} callId={callId ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}
