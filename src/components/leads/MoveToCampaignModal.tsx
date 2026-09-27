"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Modal, Select, Spinner } from "@/components/ui";

/** After "לא מתאים": optionally park the lead in a dialer campaign (e.g. "בריכת לידים אורי"). */
export function MoveToCampaignModal({ leadId, name, onClose, onDone }: { leadId: string; name: string; onClose: () => void; onDone: () => void }) {
  const [lists, setLists] = useState<Array<{ id: string; name: string; isActive: boolean; archivedAt: string | null }> | null>(null);
  const [listId, setListId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Array<{ id: string; name: string; isActive: boolean; archivedAt: string | null; filterJson?: { leadOwnerUserId?: string; system?: string } | null }>>("/api/lists").then((r) => { const act = r.filter((l) => l.isActive && !l.archivedAt && !l.filterJson?.leadOwnerUserId && !l.filterJson?.system); setLists(act); setListId(act[0]?.id ?? ""); }).catch(() => setLists([])); }, []);
  async function move() {
    setBusy(true);
    try { const r = await api.post<{ listName: string }>(`/api/leads/${leadId}/move-to-list`, { listId }); toast.success(`הליד הועבר לקמפיין "${r.listName}"`); onDone(); onClose(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={`להעביר את ${name} לקמפיין?`} footer={<><Button variant="ghost" onClick={onClose} disabled={busy} data-testid="move-skip">לא עכשיו</Button><Button onClick={move} loading={busy} disabled={!listId} data-testid="move-submit">העבר לקמפיין</Button></>}>
      <div className="space-y-3" data-testid="move-to-campaign">
        <p className="text-sm text-muted">הליד סומן &quot;לא מתאים&quot;. אפשר להעביר אותו לקמפיין חייגן (למשל &quot;בריכת לידים&quot;) כדי שיטופל שם בהמשך. הוא יוצא מהתור האישי שלך.</p>
        {lists === null ? <Spinner /> : lists.length ? <Select label="קמפיין" value={listId} onChange={(e) => setListId(e.target.value)} data-testid="move-list">{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select> : <p className="text-sm">אין קמפיינים זמינים. מנהל יכול ליצור קמפיין בתפריט &quot;קמפיינים&quot;.</p>}
      </div>
    </Modal>
  );
}
