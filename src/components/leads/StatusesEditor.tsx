"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, Spinner } from "@/components/ui";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { type LeadStatusItem } from "@/lib/lead-statuses";
import { useT } from "@/components/i18n/LangProvider";

interface Impact { status: LeadStatusItem; deletable: boolean; blockedReason: "only_of_kind" | null; leads: number; openLeads: number; automations: Array<{ id: string; name: string; isActive: boolean; draftOnly?: boolean }>; capiRules: Array<{ id: string; name: string }>; needsReplacement: boolean; replacements: LeadStatusItem[] }

/**
 * The CRM status editor: rename, reorder, add by name, delete a
 * custom status (with its impact and a replacement of the same meaning), reactivate a status that was hidden before.
 * Only the business owner changes the structure – everyone else sees it read-only (the server enforces it too).
 */
export function StatusesEditor({ compact = false }: { compact?: boolean }) {
  const statuses = useLeadStatuses();
  const t = useT();
  const owner = statuses.canEditStructure;
  const [rows, setRows] = useState<LeadStatusItem[]>(statuses.items);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<{ label: string } | null>(null);
  const [deleting, setDeleting] = useState<LeadStatusItem | null>(null);
  useEffect(() => { setRows(statuses.items); }, [statuses.items]);
  const activeRows = rows.filter((r) => r.active);
  const inactiveRows = rows.filter((r) => !r.active);
  const dirty = rows.some((r, i) => r.label !== statuses.items[i]?.label || r.id !== statuses.items[i]?.id);

  const move = (id: string, d: -1 | 1) => setRows((all) => {
    const act = all.filter((r) => r.active); const i = act.findIndex((r) => r.id === id); const j = i + d;
    if (i < 0 || j < 0 || j >= act.length) return all;
    [act[i], act[j]] = [act[j], act[i]];
    return [...act, ...all.filter((r) => !r.active)];
  });
  async function saveOrder(extra?: { id: string; active: true }) {
    setSaving(true);
    try {
      const items = rows.map((r) => ({ id: r.id, label: r.label.trim(), ...(extra?.id === r.id ? { active: true } : {}) }));
      const r = await api.patch<{ items: LeadStatusItem[] }>("/api/lead-statuses", { items });
      statuses.refresh(r.items);
      toast.success(extra ? t("הסטטוס הופעל מחדש", "Status reactivated") : t("הסטטוסים נשמרו – השמות מתעדכנים בכל המסכים", "Statuses saved – names update on every screen"));
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  async function add() {
    if (!adding) return;
    setSaving(true);
    try {
      await api.post("/api/lead-statuses", { label: adding.label.trim(), kind: "qualified" });
      statuses.refresh(); setAdding(null);
      toast.success(t("הסטטוס נוסף", "Status added"));
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-3" data-testid="statuses-editor">
      <p className="text-xs text-muted">{owner
        ? t("שמות וסדר הסטטוסים מנוהלים כאן ומתעדכנים אוטומטית ב-CRM ובחייגן.", "Status names and order are managed here and update automatically in the CRM and dialer.")
        : t("רק בעל העסק יכול לשנות את מבנה הסטטוסים.", "Only the business owner can change the status structure.")}</p>
      {!statuses.items.length ? <div className="flex justify-center p-6"><Spinner /></div> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {activeRows.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5" data-testid={`status-row-${s.id}`}>
              <div className="min-w-0 basis-full sm:basis-auto sm:min-w-[10rem] flex-1"><Input value={s.label} disabled={!owner} onChange={(e) => setRows((r) => r.map((x) => (x.id === s.id ? { ...x, label: e.target.value } : x)))} aria-label={t(`שם הסטטוס ${s.label}`, `Status name ${s.label}`)} data-testid={`status-label-${s.id}`} /></div>
              {owner && <span className="ms-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => move(s.id, -1)} disabled={i === 0} aria-label={t("הזז למעלה", "Move up")}>↑</Button>
                <Button size="sm" variant="ghost" onClick={() => move(s.id, 1)} disabled={i === activeRows.length - 1} aria-label={t("הזז למטה", "Move down")}>↓</Button>
                <Button size="sm" variant="ghost" className="text-bad" onClick={() => setDeleting(s)} data-testid={`status-delete-${s.id}`}>{t("מחק", "Delete")}</Button>
              </span>}
            </li>
          ))}
        </ul>
      )}
      {owner && (adding ? (
        <div className="space-y-2 rounded-lg border border-accent/40 p-3" data-testid="status-add-form">
          <div className="grid gap-2">
            <Input label={t("שם הסטטוס", "Status name")} value={adding.label} maxLength={40} onChange={(e) => setAdding({ ...adding, label: e.target.value })} data-testid="status-add-label" />
          </div>
          <div className="flex gap-2"><Button size="sm" onClick={add} loading={saving} disabled={!adding.label.trim()} data-testid="status-add-save">{t("הוסף", "Add")}</Button><Button size="sm" variant="ghost" onClick={() => setAdding(null)}>{t("ביטול", "Cancel")}</Button></div>
        </div>
      ) : <Button size="sm" variant="secondary" onClick={() => setAdding({ label: "" })} data-testid="status-add">{t("+ הוסף סטטוס", "+ Add status")}</Button>)}
      {inactiveRows.length > 0 && (
        <div className="rounded-lg border border-line p-2" data-testid="statuses-inactive">
          <p className="text-xs font-medium">{t("סטטוסים לא פעילים", "Inactive statuses")}</p>
          <p className="mb-1 text-[11px] text-muted">{t("הוסתרו בעבר – לא מוצעים לבחירה, ולידים שכבר בהם נשארים. הפעלה מחדש רק בפעולה מפורשת.", "Hidden before – not offered for selection; leads already in them stay. Reactivated only explicitly.")}</p>
          {inactiveRows.map((s) => <div key={s.id} className="flex items-center gap-2 py-1 text-sm"><span className="flex-1">{s.label}</span>{owner && <Button size="sm" variant="ghost" onClick={() => void saveOrder({ id: s.id, active: true })} disabled={saving} data-testid={`status-reactivate-${s.id}`}>{t("הפעל מחדש", "Reactivate")}</Button>}</div>)}
        </div>
      )}
      {owner && <div className={compact ? "flex justify-start" : "flex justify-end"}><Button onClick={() => void saveOrder()} loading={saving} disabled={!dirty || rows.some((r) => !r.label.trim())} data-testid="statuses-save">{t("שמור שמות וסדר", "Save names & order")}</Button></div>}
      {deleting && <DeleteStatusDialog status={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); statuses.refresh(); }} />}
    </div>
  );
}

/** Deleting a status: what it affects (leads, automations, Meta rules) and, when used, the replacement (same meaning). */
function DeleteStatusDialog({ status, onClose, onDone }: { status: LeadStatusItem; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [impact, setImpact] = useState<Impact | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Impact>(`/api/lead-statuses/${status.id}`).then((r) => { setImpact(r); setReplacementId(r.replacements[0]?.id ?? ""); }).catch((e) => toast.error((e as Error).message)); }, [status.id]);
  async function confirm() {
    setBusy(true);
    try {
      const r = await api.delete<{ leadsMoved: number; automationsMoved: number; capiRulesMoved: number }>(`/api/lead-statuses/${status.id}`, impact?.needsReplacement ? { replacementId } : {});
      toast.success(t(`הסטטוס נמחק${r.leadsMoved ? ` · ${r.leadsMoved} לידים הועברו` : ""}${r.automationsMoved ? ` · ${r.automationsMoved} אוטומציות עודכנו` : ""}${r.capiRulesMoved ? ` · ${r.capiRulesMoved} כללי המרות עודכנו` : ""}`, `Status deleted${r.leadsMoved ? ` · ${r.leadsMoved} leads moved` : ""}${r.automationsMoved ? ` · ${r.automationsMoved} automations updated` : ""}`));
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t(`מחיקת הסטטוס "${status.label}"`, `Delete status "${status.label}"`)}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button variant="danger" onClick={confirm} loading={busy} disabled={!impact || !impact.deletable || (impact.needsReplacement && !replacementId)} data-testid="status-delete-confirm">{t("מחק סטטוס", "Delete status")}</Button></>}>
      {!impact ? <div className="flex justify-center p-6"><Spinner /></div> : (
        <div className="space-y-3 text-sm" data-testid="status-delete-impact">
          <p>{impact.leads ? t(`${impact.leads} לידים בסטטוס הזה (${impact.openLeads} פתוחים).`, `${impact.leads} leads are in this status (${impact.openLeads} open).`) : t("אין לידים בסטטוס הזה.", "No leads are in this status.")}</p>
          {impact.automations.length > 0 && <div><p>{t(`${impact.automations.length} אוטומציות / מסעות מופעלים מהסטטוס הזה:`, `${impact.automations.length} automations / journeys are triggered by this status:`)}</p><ul className="list-disc ps-5 text-xs">{impact.automations.map((a) => <li key={a.id}>{a.name}{a.draftOnly ? t(" (טיוטה)", " (draft)") : a.isActive ? "" : t(" (כבויה)", " (off)")}</li>)}</ul></div>}
          {impact.capiRules.length > 0 && <div><p>{t(`${impact.capiRules.length} כללי המרות למטא משתמשים בסטטוס הזה:`, `${impact.capiRules.length} Meta conversion rules use this status:`)}</p><ul className="list-disc ps-5 text-xs">{impact.capiRules.map((r) => <li key={r.id}>{r.name}</li>)}</ul></div>}
          {!impact.deletable ? (
            <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs" role="alert" data-testid="status-delete-blocked">{impact.status.kind === "new" ? t("זה הסטטוס שבו כל ליד חדש נכנס למערכת, ולכן אי אפשר למחוק אותו. אפשר לשנות את שמו.", "Every new lead enters the system in this status, so it can't be deleted. You can rename it.") : t("הסטטוס נדרש לתהליכים קיימים ולכן אי אפשר למחוק אותו כעת. אפשר לשנות את שמו.", "This status is required by existing workflows and cannot currently be deleted. You can rename it.")}</p>
          ) : impact.needsReplacement ? <>
            <Select label={t("לאיזה סטטוס להעביר אותם", "Move them to status")} value={replacementId} onChange={(e) => setReplacementId(e.target.value)} data-testid="status-delete-replacement">
              {impact.replacements.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
            <p className="text-xs text-muted">{t("מוצגים סטטוסים חלופיים התואמים לתהליכים הקיימים. לידים לא נמחקים; ההעברה מתועדת והאוטומציות יעודכנו לסטטוס החלופי.", "Available replacements preserve existing workflows. Leads are not deleted; transfers are logged and automations use the replacement status.")}</p>
          </> : <p className="text-xs text-muted">{t("שיחות ורשומות קודמות ימשיכו להציג את השם הזה בהיסטוריה.", "Earlier calls and records keep showing this name in their history.")}</p>}
        </div>
      )}
    </Modal>
  );
}
