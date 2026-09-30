"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

export type Selection = { ids: string[] } | { filter: Record<string, string>; expectedCount: number };
interface Impact { contacts: number; history: { sends: number; calls: number; messages: number; deals: number }; openLeads: number; queuedSends: number; inCall: number; keptBlocks: number }

/**
 * Selected contacts → actions. The page selection and "all N filtered results" are distinct: the second is sent as
 * the filter + the count the user saw, and the server re-runs it (and refuses if the count changed).
 * "הסרה מהרשימה" and "מחיקת איש קשר" are two separate actions with their own confirmation.
 */
export function ContactsBulkBar({ pageIds, selected, allFiltered, total, filter, list, isOwner, onSelectAll, onClear, onDone }: {
  pageIds: string[]; selected: Set<string>; allFiltered: boolean; total: number; filter: Record<string, string>;
  list: { id: string; name: string; dynamic: boolean } | null; isOwner: boolean;
  onSelectAll: () => void; onClear: () => void; onDone: () => void;
}) {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [removing, setRemoving] = useState(false);
  const [del, setDel] = useState<Impact | "loading" | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const count = allFiltered ? total : selected.size;
  if (!count) return null;
  const selection: Selection = allFiltered ? { filter, expectedCount: total } : { ids: [...selected] };
  const pageAll = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  async function remove() {
    if (!list) return; setBusy(true);
    try { const r = await api.post<{ removed: number; futureSendsSkipped: number }>(`/api/distribution-lists/${list.id}/members/remove`, selection); toast.success(t(`הוסרו ${r.removed} מהרשימה${r.futureSendsSkipped ? ` · ${r.futureSendsSkipped} שליחות עתידיות בוטלו` : ""}`, `${r.removed} removed from the list${r.futureSendsSkipped ? ` · ${r.futureSendsSkipped} future sends cancelled` : ""}`)); setRemoving(false); onClear(); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function openDelete() {
    setDel("loading"); setConfirm("");
    try { setDel(await api.post<Impact>("/api/contacts/bulk/impact", selection)); } catch (e) { setDel(null); toast.error((e as Error).message); }
  }
  async function doDelete() {
    if (!del || del === "loading") return; setBusy(true);
    try {
      const r = await api.post<{ deleted: number; failed: Array<{ id: string; reason: string }> }>("/api/contacts/bulk/delete", { selection, confirm });
      if (r.failed.length) toast.warning(t(`נמחקו ${r.deleted}; ${r.failed.length} לא נמחקו: ${r.failed[0].reason}`, `${r.deleted} deleted; ${r.failed.length} not deleted: ${r.failed[0].reason}`));
      else toast.success(t(`נמחקו ${r.deleted} אנשי קשר`, `${r.deleted} contacts deleted`));
      setDel(null); onClear(); onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-sm" data-testid="contacts-bulk-bar">
      <b data-testid="bulk-count">{allFiltered ? t(`כל ${total.toLocaleString(loc)} התוצאות המסוננות נבחרו`, `All ${total.toLocaleString(loc)} filtered results selected`) : t(`${count.toLocaleString(loc)} נבחרו`, `${count.toLocaleString(loc)} selected`)}</b>
      {!allFiltered && pageAll && total > selected.size && total > 20000 && <span className="text-xs text-muted" data-testid="bulk-too-many">{t(`אפשר לפעול על עד 20,000 בפעולה אחת – צמצמו את הסינון (כעת ${total.toLocaleString(loc)})`, `Up to 20,000 per action – narrow the filter (now ${total.toLocaleString(loc)})`)}</span>}
      {!allFiltered && pageAll && total > selected.size && total <= 20000 && <button type="button" className="text-xs underline" onClick={onSelectAll} data-testid="bulk-select-all">{t(`בחירת כל ${total.toLocaleString(loc)} התוצאות המסוננות (לא רק העמוד)`, `Select all ${total.toLocaleString(loc)} filtered results (not just this page)`)}</button>}
      <div className="ms-auto flex flex-wrap gap-2">
        {list && <Button size="sm" variant="secondary" onClick={() => setRemoving(true)} disabled={list.dynamic} title={list.dynamic ? t("רשימה דינמית – משנים את התנאים", "Dynamic list – change its conditions") : undefined} data-testid="bulk-remove-from-list">{t(`הסרה מהרשימה "${list.name}"`, `Remove from list "${list.name}"`)}</Button>}
        {isOwner && <Button size="sm" variant="danger" onClick={() => void openDelete()} data-testid="bulk-delete">{t("מחיקת אנשי קשר", "Delete contacts")}</Button>}
        <Button size="sm" variant="ghost" onClick={onClear}>{t("ביטול בחירה", "Clear selection")}</Button>
      </div>
      {list?.dynamic && <p className="w-full text-xs text-muted">{t("זו רשימה דינמית לפי תנאים – כדי להוציא ממנה אנשי קשר משנים את התנאים או מחריגים קהל.", "This is a dynamic list – to take contacts out of it, change its conditions or exclude an audience.")}</p>}

      {removing && list && <Modal open onClose={() => !busy && setRemoving(false)} title={t(`הסרה מהרשימה "${list.name}"`, `Remove from list "${list.name}"`)} footer={<><Button variant="ghost" onClick={() => setRemoving(false)} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={remove} loading={busy} data-testid="bulk-remove-confirm">{t(`הסר ${count.toLocaleString(loc)}`, `Remove ${count.toLocaleString(loc)}`)}</Button></>}>
        <p className="text-sm">{t(`${count.toLocaleString(loc)} אנשי קשר יוסרו מהרשימה בלבד – הם נשארים ב-CRM עם כל ההיסטוריה. קמפיינים פעילים שהגיעו אליהם רק דרך הרשימה הזו לא ישלחו להם יותר; שליחות שכבר בוצעו נשמרות.`, `${count.toLocaleString(loc)} contacts are removed from this list only – they stay in the CRM with all their history. Active campaigns that reached them only through this list won't send to them anymore; sends already made are kept.`)}</p>
      </Modal>}

      {del && <Modal open onClose={() => !busy && setDel(null)} title={t("מחיקת אנשי קשר", "Delete contacts")} footer={<><Button variant="ghost" onClick={() => setDel(null)} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button variant="danger" onClick={doDelete} loading={busy} disabled={del === "loading" || confirm !== String(del.contacts)} data-testid="bulk-delete-confirm">{t("מחק לצמיתות", "Delete permanently")}</Button></>}>
        {del === "loading" ? <div className="flex justify-center p-6"><Spinner /></div> : (
          <div className="space-y-2 text-sm" data-testid="bulk-delete-impact">
            <p><b>{t(`${del.contacts.toLocaleString(loc)} אנשי קשר יימחקו.`, `${del.contacts.toLocaleString(loc)} contacts will be deleted.`)}</b> {t("הפרטים האישיים נמחקים והם ייעלמו מכל הרשימות והחיפושים. הפעולה אינה הפיכה.", "Their personal details are erased and they disappear from every list and search. This can't be undone.")}</p>
            <ul className="list-disc space-y-0.5 ps-5 text-xs">
              <li>{t(`נשמר לדוחות: ${del.history.sends} שליחות, ${del.history.calls} שיחות, ${del.history.messages} הודעות, ${del.history.deals} עסקאות (לפי מדיניות השמירה).`, `Kept for reports: ${del.history.sends} sends, ${del.history.calls} calls, ${del.history.messages} messages, ${del.history.deals} deals (per the retention policy).`)}</li>
              {del.openLeads > 0 && <li>{t(`${del.openLeads} לידים פתוחים ייסגרו ("איש הקשר נמחק"), ומשימות וחיוגים עתידיים יבוטלו.`, `${del.openLeads} open leads will close ("contact deleted"), and future tasks and dials are cancelled.`)}</li>}
              {del.queuedSends > 0 && <li>{t(`${del.queuedSends} שליחות מתוכננות בקמפיינים לא יישלחו.`, `${del.queuedSends} planned campaign sends won't be sent.`)}</li>}
              {del.inCall > 0 && <li className="text-warn">{t(`${del.inCall} בשיחה פעילה – הם לא יימחקו עכשיו.`, `${del.inCall} are in a live call – they won't be deleted now.`)}</li>}
              <li>{t(`חסימות והסרות מדיוור נשארות (${del.keptBlocks}) – ייבוא מחדש של אותו מספר או אימייל ימשיך להיות חסום.`, `Blocks and unsubscribes stay (${del.keptBlocks}) – re-importing the same number or email stays blocked.`)}</li>
            </ul>
            <Input label={t(`לאישור, הקלידו את מספר אנשי הקשר: ${del.contacts}`, `To confirm, type the number of contacts: ${del.contacts}`)} value={confirm} onChange={(e) => setConfirm(e.target.value)} ltr data-testid="bulk-delete-typed" />
          </div>
        )}
      </Modal>}
    </div>
  );
}
