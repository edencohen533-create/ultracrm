"use client";

import { useState } from "react";
import { toast } from "sonner";
import { addMonths, format, isValid, parseISO } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Item { name: string; quantity: string; unitPrice: string; startsAt: string; duration: string; endsAt: string }
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const renewalDate = (d: string, months: number) => { const parsed = parseISO(d); return isValid(parsed) ? format(addMonths(parsed, months), "yyyy-MM-dd") : null; };
const DURATIONS: Array<[string, string, string]> = [["", "ללא תאריך סיום", "No end date"], ["1", "חודש", "1 month"], ["3", "3 חודשים", "3 months"], ["6", "חצי שנה", "6 months"], ["12", "שנה", "1 year"], ["24", "שנתיים", "2 years"], ["custom", "תאריך אחר…", "Other date…"]];
const blank = (): Item => ({ name: "", quantity: "1", unitPrice: "", startsAt: today(), duration: "12", endsAt: "" });
const endOf = (i: Item) => (i.duration === "custom" ? i.endsAt || null : i.duration ? renewalDate(i.startsAt, Number(i.duration)) : null);

/**
 * "עסקה נסגרה" – opened when a lead's status becomes "הומר לעסקה", from "+ עסקה חדשה", or after a sale in the dialer.
 * What was sold, the value and the product period; saved as a won deal + note, and the customer moves to the
 * existing-customers dialer list, which calls them when the product ends.
 */
export function DealCloseModal({ contactId, leadId, name, onClose, onDone }: { contactId: string; leadId?: string | null; name: string; onClose: () => void; onDone: (r: { dealId: string; renewalAt: string | null }) => void }) {
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Item[]>([blank()]);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const sum = items.reduce((a, i) => a + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  const set = (k: number, patch: Partial<Item>) => setItems((list) => list.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const filled = items.filter((i) => i.name.trim());
  const invalidPeriod = filled.some((i) => !isValid(parseISO(i.startsAt)) || (i.duration && !endOf(i)) || (endOf(i) && endOf(i)! < i.startsAt));
  async function save() {
    if (invalidPeriod) return;
    setBusy(true);
    try {
      const r = await api.post<{ dealId: string; amount: number; renewalAt: string | null }>("/api/deals/close", {
        contactId, leadId: leadId || undefined, title: title.trim() || undefined, amount: amount ? Number(amount) : undefined, note: note.trim() || undefined,
        items: filled.map((i) => ({ name: i.name.trim(), quantity: Number(i.quantity) || 1, unitPrice: Number(i.unitPrice) || 0, startsAt: i.startsAt, endsAt: endOf(i) })),
      });
      toast.success(`${t("העסקה נסגרה", "Deal closed")} · ₪${r.amount.toLocaleString(loc)}${r.renewalAt ? ` · ${t(`שיחת חידוש ב-${new Date(r.renewalAt).toLocaleDateString(loc)}`, `Renewal call on ${new Date(r.renewalAt).toLocaleDateString(loc)}`)}` : ""}`);
      onDone(r); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t(`🎉 עסקה נסגרה – ${name}`, `🎉 Deal closed – ${name}`)} width="max-w-3xl"
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={save} loading={busy} disabled={invalidPeriod || (!filled.length && !amount)} data-testid="deal-close-save">{t("שמור עסקה", "Save deal")}</Button></>}>
      <div className="space-y-3" data-testid="deal-close">
        <Input label={t("שם העסקה (לא חובה)", "Deal name (optional)")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("למשל: מנוי שנתי", "e.g. Annual subscription")} />
        <div>
          <div className="text-sm font-medium mb-1">{t("מה נרכש", "What was purchased")}</div>
          <div className="space-y-2">{items.map((it, k) => (
            <div key={k} className="deal-item-row" data-testid={`deal-item-${k}`}>
              <Input aria-label={t("מוצר", "Product")} placeholder={t("מוצר / שירות", "Product / service")} value={it.name} onChange={(e) => set(k, { name: e.target.value })} data-testid={`deal-item-name-${k}`} />
              <Input aria-label={t("כמות", "Quantity")} type="number" min={1} value={it.quantity} onChange={(e) => set(k, { quantity: e.target.value })} ltr className="w-20" />
              <Input aria-label={t("מחיר ליחידה", "Unit price")} type="number" min={0} placeholder={t("מחיר ₪", "Price ₪")} value={it.unitPrice} onChange={(e) => set(k, { unitPrice: e.target.value })} ltr className="w-28" data-testid={`deal-item-price-${k}`} />
              <Input aria-label={t("תאריך רכישה", "Purchase date")} type="date" value={it.startsAt} onChange={(e) => set(k, { startsAt: e.target.value })} ltr className="w-40" />
              <Select aria-label={t("משך", "Duration")} value={it.duration} onChange={(e) => set(k, { duration: e.target.value })} className="w-36" data-testid={`deal-item-duration-${k}`}>{DURATIONS.map(([v, he, en]) => <option key={v} value={v}>{t(he, en)}</option>)}</Select>
              {it.duration === "custom" && <Input aria-label={t("תאריך סיום", "End date")} type="date" value={it.endsAt} min={it.startsAt} onChange={(e) => set(k, { endsAt: e.target.value })} ltr className="w-40" />}
              {items.length > 1 && <button type="button" onClick={() => setItems((l) => l.filter((_, j) => j !== k))} aria-label={t("הסר מוצר", "Remove product")}><Trash2 size={15} /></button>}
              {endOf(it) && <span className="text-[11px] text-muted w-full">{t(`מסתיים ב-${endOf(it)!.split("-").reverse().join(".")} – אז הלקוח ייכנס לחייגן הלקוחות הקיימים לשיחת חידוש`, `Ends on ${endOf(it)!.split("-").reverse().join(".")} – then the customer enters the existing-customers dialer for a renewal call`)}</span>}
            </div>))}
          </div>
          <button type="button" className="lead-link mt-1 inline-flex items-center gap-1" onClick={() => setItems((l) => [...l, blank()])}><Plus size={13} />{t("הוסף מוצר", "Add product")}</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Input label={t(`שווי העסקה (ברירת מחדל: סכום המוצרים ₪${sum.toLocaleString(loc)})`, `Deal value (default: product total ₪${sum.toLocaleString(loc)})`)} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(sum)} ltr data-testid="deal-close-amount" />
        </div>
        <Textarea label={t("הערה (לא חובה)", "Note (optional)")} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="text-xs text-muted">{t("הפרטים נשמרים בהערות של הלקוח, הליד מסומן \"הומר לעסקה\" והלקוח עובר לרשימת החיוג \"לקוחות קיימים – חידושים\" (ויוצא משאר רשימות החיוג).", "The details are saved in the customer's notes, the lead is marked \"Converted to deal\" and the customer moves to the \"Existing customers – renewals\" dial list (and leaves the other dial lists).")}</p>
      </div>
    </Modal>
  );
}
