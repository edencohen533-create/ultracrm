"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Modal, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

/** After "לא מתאים": optionally park the lead in a dialer campaign (e.g. "בריכת לידים אורי"). */
export function MoveToCampaignModal({ leadId, name, onClose, onDone }: { leadId: string; name: string; onClose: () => void; onDone: () => void }) {
  const [lists, setLists] = useState<Array<{ id: string; name: string; isActive: boolean; archivedAt: string | null }> | null>(null);
  const [listId, setListId] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  useEffect(() => { api.get<Array<{ id: string; name: string; isActive: boolean; archivedAt: string | null; filterJson?: { leadOwnerUserId?: string; system?: string } | null }>>("/api/lists").then((r) => { const act = r.filter((l) => l.isActive && !l.archivedAt && !l.filterJson?.leadOwnerUserId && !l.filterJson?.system); setLists(act); setListId(act[0]?.id ?? ""); }).catch(() => setLists([])); }, []);
  async function move() {
    setBusy(true);
    try { const r = await api.post<{ listName: string }>(`/api/leads/${leadId}/move-to-list`, { listId }); toast.success(t(`הליד הועבר לקמפיין "${r.listName}"`, `Lead moved to campaign "${r.listName}"`)); onDone(); onClose(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t(`להעביר את ${name} לקמפיין?`, `Move ${name} to a campaign?`)} footer={<><Button variant="ghost" onClick={onClose} disabled={busy} data-testid="move-skip">{t("לא עכשיו", "Not now")}</Button><Button onClick={move} loading={busy} disabled={!listId} data-testid="move-submit">{t("העבר לקמפיין", "Move to campaign")}</Button></>}>
      <div className="space-y-3" data-testid="move-to-campaign">
        <p className="text-sm text-muted">{t("הליד סומן \"לא מתאים\". אפשר להעביר אותו לקמפיין חייגן (למשל \"בריכת לידים\") כדי שיטופל שם בהמשך. הוא יוצא מהתור האישי שלך.", "The lead was marked \"Not relevant\". You can move it to a dialer campaign (e.g. \"Lead pool\") to be handled there later. It leaves your personal queue.")}</p>
        {lists === null ? <Spinner /> : lists.length ? <Select label={t("קמפיין", "Campaign")} value={listId} onChange={(e) => setListId(e.target.value)} data-testid="move-list">{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select> : <p className="text-sm">{t("אין קמפיינים זמינים. מנהל יכול ליצור קמפיין בתפריט \"קמפיינים\".", "No campaigns available. A manager can create one from the \"Campaigns\" menu.")}</p>}
      </div>
    </Modal>
  );
}
