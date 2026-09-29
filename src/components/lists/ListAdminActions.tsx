"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface ListRef { id: string; name: string; isActive: boolean }

/** "העבר לידים" – selected rows (leadIds) or all rows of `from` to another list of the business. */
export function MoveLeadsDialog({ from, lists, leadIds, onClose, onDone }: { from: ListRef; lists: ListRef[]; leadIds?: string[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const targets = lists.filter((l) => l.id !== from.id);
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  async function move() {
    setBusy(true);
    try {
      const r = await api.post<{ moved: number; merged: number; skippedInCall: number }>(`/api/lists/${from.id}/leads/move`, { toListId: to, ...(leadIds ? { leadIds } : { all: true }) });
      toast.success(t(`הועברו ${r.moved} לידים${r.merged ? `, ${r.merged} אוחדו עם לידים שכבר היו ברשימת היעד` : ""}${r.skippedInCall ? `. ${r.skippedInCall} בשיחה פעילה ולא הועברו` : ""}`, `${r.moved} leads moved${r.merged ? `, ${r.merged} merged with leads already in the target list` : ""}${r.skippedInCall ? `. ${r.skippedInCall} in a live call were not moved` : ""}`));
      onDone(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t("העברת לידים", "Move leads")} footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={move} loading={busy} disabled={!to} data-testid="move-confirm">{t("העבר", "Move")}</Button></>}>
      <div className="space-y-3 text-sm">
        <p>{leadIds ? t(`${leadIds.length} לידים נבחרים מהרשימה "${from.name}"`, `${leadIds.length} selected leads from "${from.name}"`) : t(`כל הלידים ברשימה "${from.name}"`, `All leads in "${from.name}"`)}</p>
        {targets.length === 0 ? <p className="text-muted">{t("אין רשימה אחרת להעברה", "There is no other list to move to")}</p> : (
          <Select label={t("לרשימה", "To list")} value={to} onChange={(e) => setTo(e.target.value)} data-testid="move-target">
            {targets.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isActive ? "" : t(" (לא פעילה)", " (inactive)")}</option>)}
          </Select>
        )}
        <p className="text-xs text-muted">{t("הלידים עוברים עם הסטטוס, הניסיונות, הנציג המטפל, התזמון והחסימות. ההיסטוריה נשמרת. ליד שכבר קיים ברשימת היעד מאוחד ולא משוכפל. ליד שנמצא כרגע בשיחה לא יועבר.", "Leads move with their status, attempts, handling agent, schedule and blocks. History is kept. A lead already in the target list is merged, not duplicated. A lead in a live call is not moved.")}</p>
      </div>
    </Modal>
  );
}

/** Manager actions on a list card: active / inactive, move all leads, delete (with the number of leads). */
export function ListAdminActions({ list, lists, onChanged }: { list: ListRef; lists: ListRef[]; onChanged: () => void }) {
  const t = useT();
  const [moving, setMoving] = useState(false);
  const [del, setDel] = useState<null | { leads: number; callsInProgress: number; openSessions: number; system: string | null }>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await api.patch(`/api/lists/${list.id}`, { isActive: !list.isActive });
      toast.success(list.isActive ? t("הרשימה הושבתה – לא יסופקו ממנה לידים. שיחות פעילות ימשיכו עד סופן", "List deactivated – it will supply no leads. Live calls continue until they end") : t("הרשימה הופעלה", "List activated"));
      onChanged();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function openDelete() {
    try { setConfirmName(""); setDel(await api.get(`/api/lists/${list.id}/deletion`)); } catch (e) { toast.error((e as Error).message); }
  }
  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/api/lists/${list.id}`, { confirmName });
      toast.success(t("הרשימה נמחקה. אנשי הקשר וההיסטוריה שלהם נשמרו", "List deleted. Contacts and their history were kept"));
      setDel(null); onChanged();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3" data-testid={`list-admin-${list.id}`}>
      <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" role="switch" aria-checked={list.isActive} checked={list.isActive} disabled={busy} onChange={toggle} className="h-4 w-4 accent-[var(--accent)]" data-testid="list-active-toggle" />
        {list.isActive ? t("פעילה", "Active") : t("לא פעילה", "Inactive")}
      </label>
      <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setMoving(true)} data-testid="list-move-all">{t("העבר לידים", "Move leads")}</Button>
      <Button size="sm" variant="ghost" className="text-bad" onClick={openDelete} data-testid="list-delete">{t("מחק רשימה", "Delete list")}</Button>
      {moving && <MoveLeadsDialog from={list} lists={lists} onClose={() => setMoving(false)} onDone={onChanged} />}
      {del && (
        <Modal open onClose={() => !busy && setDel(null)} title={t(`מחיקת הרשימה "${list.name}"`, `Delete list "${list.name}"`)} footer={<><Button variant="ghost" onClick={() => setDel(null)} disabled={busy}>{t("ביטול", "Cancel")}</Button>{!del.system && <Button variant="danger" onClick={remove} loading={busy} disabled={confirmName.trim() !== list.name.trim() || del.callsInProgress > 0} data-testid="list-delete-confirm">{t("מחק רשימה", "Delete list")}</Button>}</>}>
          <div className="space-y-3 text-sm" data-testid="list-delete-info">
            {del.system ? <p>{t("זו רשימת מערכת ולא ניתן למחוק אותה. אפשר להשבית אותה.", "This is a system list and cannot be deleted. You can deactivate it.")}</p> : (
              <>
                <p><b>{t(`${del.leads} לידים משויכים לרשימה.`, `${del.leads} leads are in this list.`)}</b> {t("הם יוסרו מהרשימה בלבד – אנשי הקשר, הלידים וההיסטוריה שלהם (שיחות, משימות, הערות) נשמרים.", "They are removed from the list only – the contacts, leads and their history (calls, tasks, notes) are kept.")}</p>
                {del.openSessions > 0 && <p className="text-warn">{t(`${del.openSessions} סשנים פתוחים של נציגים ברשימה ייסגרו.`, `${del.openSessions} open agent sessions on this list will be closed.`)}</p>}
                {del.callsInProgress > 0 && <p className="text-bad">{t("יש שיחה פעילה ברשימה – ניתן למחוק אחרי שהיא תסתיים.", "A call is in progress on this list – you can delete it after it ends.")}</p>}
                <Input label={t(`לאישור, הקלידו את שם הרשימה: ${list.name}`, `To confirm, type the list name: ${list.name}`)} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} data-testid="list-delete-name" />
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
