"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, Textarea } from "@/components/ui";

interface Item { name: string; quantity: string; unitPrice: string; startsAt: string; duration: string; endsAt: string }
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addMonths = (d: string, m: number) => { const [y, mo, da] = d.split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1 + m, da)); return t.toISOString().slice(0, 10); };
const DURATIONS: Array<[string, string]> = [["", "ללא תאריך סיום"], ["1", "חודש"], ["3", "3 חודשים"], ["6", "חצי שנה"], ["12", "שנה"], ["24", "שנתיים"], ["custom", "תאריך אחר…"]];
const blank = (): Item => ({ name: "", quantity: "1", unitPrice: "", startsAt: today(), duration: "12", endsAt: "" });
const endOf = (i: Item) => (i.duration === "custom" ? i.endsAt || null : i.duration ? addMonths(i.startsAt, Number(i.duration)) : null);

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
  const sum = items.reduce((a, i) => a + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  const set = (k: number, patch: Partial<Item>) => setItems((list) => list.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const filled = items.filter((i) => i.name.trim());
  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ dealId: string; amount: number; renewalAt: string | null }>("/api/deals/close", {
        contactId, leadId: leadId || undefined, title: title.trim() || undefined, amount: amount ? Number(amount) : undefined, note: note.trim() || undefined,
        items: filled.map((i) => ({ name: i.name.trim(), quantity: Number(i.quantity) || 1, unitPrice: Number(i.unitPrice) || 0, startsAt: i.startsAt, endsAt: endOf(i) })),
      });
      toast.success(`העסקה נסגרה · ₪${r.amount.toLocaleString("he-IL")}${r.renewalAt ? ` · שיחת חידוש ב-${new Date(r.renewalAt).toLocaleDateString("he-IL")}` : ""}`);
      onDone(r); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={`🎉 עסקה נסגרה – ${name}`} width="max-w-3xl"
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>ביטול</Button><Button onClick={save} loading={busy} disabled={!filled.length && !amount} data-testid="deal-close-save">שמור עסקה</Button></>}>
      <div className="space-y-3" data-testid="deal-close">
        <Input label="שם העסקה (לא חובה)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="למשל: מנוי שנתי" />
        <div>
          <div className="text-sm font-medium mb-1">מה נרכש</div>
          <div className="space-y-2">{items.map((it, k) => (
            <div key={k} className="deal-item-row" data-testid={`deal-item-${k}`}>
              <Input aria-label="מוצר" placeholder="מוצר / שירות" value={it.name} onChange={(e) => set(k, { name: e.target.value })} data-testid={`deal-item-name-${k}`} />
              <Input aria-label="כמות" type="number" min={1} value={it.quantity} onChange={(e) => set(k, { quantity: e.target.value })} ltr className="w-20" />
              <Input aria-label="מחיר ליחידה" type="number" min={0} placeholder="מחיר ₪" value={it.unitPrice} onChange={(e) => set(k, { unitPrice: e.target.value })} ltr className="w-28" data-testid={`deal-item-price-${k}`} />
              <Input aria-label="תאריך רכישה" type="date" value={it.startsAt} onChange={(e) => set(k, { startsAt: e.target.value })} ltr className="w-40" />
              <Select aria-label="משך" value={it.duration} onChange={(e) => set(k, { duration: e.target.value })} className="w-36" data-testid={`deal-item-duration-${k}`}>{DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              {it.duration === "custom" && <Input aria-label="תאריך סיום" type="date" value={it.endsAt} min={it.startsAt} onChange={(e) => set(k, { endsAt: e.target.value })} ltr className="w-40" />}
              {items.length > 1 && <button type="button" onClick={() => setItems((l) => l.filter((_, j) => j !== k))} aria-label="הסר מוצר"><Trash2 size={15} /></button>}
              {endOf(it) && <span className="text-[11px] text-muted w-full">מסתיים ב-{endOf(it)!.split("-").reverse().join(".")} – אז הלקוח ייכנס לחייגן הלקוחות הקיימים לשיחת חידוש</span>}
            </div>))}
          </div>
          <button type="button" className="lead-link mt-1 inline-flex items-center gap-1" onClick={() => setItems((l) => [...l, blank()])}><Plus size={13} />הוסף מוצר</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Input label={`שווי העסקה (ברירת מחדל: סכום המוצרים ₪${sum.toLocaleString("he-IL")})`} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(sum)} ltr data-testid="deal-close-amount" />
        </div>
        <Textarea label="הערה (לא חובה)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="text-xs text-muted">הפרטים נשמרים בהערות של הלקוח, הליד מסומן &quot;הומר לעסקה&quot; והלקוח עובר לרשימת החיוג &quot;לקוחות קיימים – חידושים&quot; (ויוצא משאר רשימות החיוג).</p>
      </div>
    </Modal>
  );
}
