"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Modal } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

export interface AccessUser { id: string; fullName: string; role: string }

/**
 * "למי רשימת החיוג פתוחה": all agents, or only the chosen agents (PUT /api/lists/:id/agents). The server enforces it
 * when lists are shown / counted / opened and when a session or a dial starts. Managers and the owner always see every
 * list, so the choice is between agents (a non-agent already on the list stays visible so it's never dropped silently).
 */
export function ListAccessModal({ listId, listName, current, users, onClose, onSaved }: { listId: string; listName?: string; current: string[]; users: AccessUser[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<"all" | "selected">(current.length ? "selected" : "all");
  const [ids, setIds] = useState<string[]>(current);
  const [saving, setSaving] = useState(false);
  const pickable = users.filter((u) => u.role === "agent" || ids.includes(u.id));
  async function save() {
    setSaving(true);
    try {
      await api.put(`/api/lists/${listId}/agents`, { mode, agentIds: mode === "all" ? [] : ids });
      toast.success(mode === "all" ? t("רשימת החיוג פתוחה לכל הנציגים", "The dial list is open to all agents") : t(`רשימת החיוג פתוחה ל-${ids.length} נציגים`, `The dial list is open to ${ids.length} agents`));
      onSaved(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title={listName ? t(`למי רשימת החיוג פתוחה – ${listName}`, `Who the dial list is open to – ${listName}`) : t("למי רשימת החיוג פתוחה", "Who the dial list is open to")}
      footer={<><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button onClick={save} loading={saving} disabled={saving || (mode === "selected" && !ids.length)} data-testid="campaign-access-save">{t("שמור", "Save")}</Button></>}>
      <div className="space-y-2 text-sm" data-testid="campaign-access">
        <label className="flex items-center gap-2"><input type="radio" name="access" checked={mode === "all"} onChange={() => setMode("all")} data-testid="campaign-access-all" /> {t("כל הנציגים בעסק", "All agents in the business")}</label>
        <label className="flex items-center gap-2"><input type="radio" name="access" checked={mode === "selected"} onChange={() => setMode("selected")} data-testid="campaign-access-selected" /> {t("נציגים מסוימים בלבד", "Specific agents only")}</label>
        {mode === "selected" && <div className="flex flex-wrap gap-1.5 ps-6">
          {pickable.length ? pickable.map((u) => (
            <button key={u.id} type="button" data-testid={`campaign-agent-${u.id}`} aria-pressed={ids.includes(u.id)} onClick={() => setIds(ids.includes(u.id) ? ids.filter((x) => x !== u.id) : [...ids, u.id])} className={`h-8 px-3 rounded-md border text-xs ${ids.includes(u.id) ? "bg-accent text-white border-accent" : "border-line text-muted hover:text-text"}`}>{u.fullName}</button>
          )) : <p className="text-xs text-muted">{t("אין נציגים פעילים בעסק.", "No active agents in the business.")}</p>}
        </div>}
        {mode === "selected" && !ids.length && <p className="text-xs text-bad">{t("יש לבחור לפחות נציג אחד.", "Select at least one agent.")}</p>}
        <p className="text-xs text-muted">{t("נציג שלא נבחר לא יראה את הרשימה ולא יוכל להפעיל עליה חייגן. מנהלים ובעל העסק רואים את כל הרשימות. ההרשאה נאכפת בשרת ואינה נותנת גישה ללידים פרטיים של נציגים אחרים.", "An agent who isn't chosen won't see the list or start a dialer on it. Managers and the owner see every list. Enforced on the server; it doesn't grant access to other agents' private leads.")}</p>
      </div>
    </Modal>
  );
}
