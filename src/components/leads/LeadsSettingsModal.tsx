"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, cx } from "@/components/ui";
import { CrmSettings } from "@/components/crm-settings/CrmSettings";
import { StatusesEditor } from "@/components/leads/StatusesEditor";
import { DistributionScreen } from "@/components/leads/DistributionScreen";
import type { LeadAssignmentSettings } from "@/lib/lead-statuses";
import { useT } from "@/components/i18n/LangProvider";

/** "settings" = dialer settings + statuses; "statuses" = only the status editor; "assignment" = only lead distribution. */
export type LeadsSettingsMode = "settings" | "statuses" | "assignment";

/**
 * Settings opened from the leads screen – one focused view per entry point, no tabs:
 *  • "הגדרות": the per-agent dialer settings and (managers) the statuses, in one place;
 *  • "עריכת סטטוסים": only the status editor (the same component as inside "הגדרות");
 *  • "חלוקת לידים": only the distribution policy.
 */
export function LeadsSettingsModal({ open, onClose, manager, mode = "settings" }: { open: boolean; onClose: () => void; manager: boolean; mode?: LeadsSettingsMode }) {
  const t = useT();
  const [dirty, setDirty] = useState(false);
  const close = () => { if (dirty && !window.confirm(t("יש שינויים בהגדרות החייגן שלא נשמרו. לסגור בלי לשמור?", "You have unsaved dialer settings changes. Close without saving?"))) return; onClose(); };
  const title = mode === "statuses" ? t("עריכת סטטוסים", "Edit statuses") : mode === "assignment" ? t("חלוקת לידים", "Lead distribution") : t("הגדרות", "Settings");
  return (
    <Modal open={open} onClose={close} title={title} width={mode === "settings" ? "max-w-4xl" : "max-w-2xl"}>
      {mode === "settings" && <div className="space-y-5" data-testid="leads-settings">
        <CrmSettings embedded onDirtyChange={setDirty} />
        {manager && <section className="border-t border-line pt-4" aria-labelledby="settings-statuses"><h3 id="settings-statuses" className="mb-2 text-sm font-semibold">{t("סטטוסים", "Statuses")}</h3><StatusesEditor compact /></section>}
      </div>}
      {mode === "statuses" && manager && <StatusesEditor />}
      {mode === "assignment" && manager && <><DistributionScreen /><AgentNotifySettings /></>}
    </Modal>
  );
}

/** WhatsApp to the agent when a new lead is assigned to them (part of "חלוקת לידים"; owner only). */
function AgentNotifySettings() {
  const [s, setS] = useState<LeadAssignmentSettings | null>(null);
  const t = useT();
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string; isActive: boolean; personalPhone?: string | null }>>([]);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; status: string; body: string }>>([]);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get<{ leadAssignment: LeadAssignmentSettings; templates: typeof templates }>("/api/lead-statuses").then((r) => { setS(r.leadAssignment); setTemplates(r.templates ?? []); }).catch((e) => toast.error(e.message));
    api.get<{ items: typeof users }>("/api/users").then((r) => { const act = r.items.filter((u) => u.isActive && u.role !== "owner"); setUsers(act); setPhones(Object.fromEntries(act.map((u) => [u.id, u.personalPhone ?? ""]))); }).catch(() => undefined);
  }, []);
  async function save() {
    if (!s) return; setSaving(true);
    try { await api.patch("/api/lead-statuses", { leadAssignment: { notifyWhatsApp: s.notifyWhatsApp ?? { enabled: false, templateId: null } } }); toast.success(t("ההודעה לנציג נשמרה", "Agent notification saved")); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!s) return null;
  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4" data-testid="assignment-editor">
      <div className="rounded-lg border border-line p-3 space-y-2" data-testid="notify-agent">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={Boolean(s.notifyWhatsApp?.enabled)} onChange={(e) => setS({ ...s, notifyWhatsApp: { templateId: s.notifyWhatsApp?.templateId ?? null, enabled: e.target.checked } })} data-testid="notify-agent-enabled" /> {t("שלח לנציג הודעת WhatsApp לטלפון האישי כשנכנס אליו ליד חדש", "Send the agent a WhatsApp message to their personal phone when a new lead is assigned to them")}</label>
        <p className="text-xs text-muted">{t("נשלח ממספר ה-WhatsApp של העסק, גם בחלוקה אוטומטית ובהעברה מנציג אחר. וואטסאפ מחייב תבנית מאושרת (הנציג לרוב לא כתב לעסק ב-24 השעות האחרונות). משתנים בתבנית:", "Sent from the business's WhatsApp number, also on automatic distribution and on transfer from another agent. WhatsApp requires an approved template (the agent usually hasn't messaged the business in the last 24 hours). Template variables:")} {"{{1}}"} {t("שם הליד", "lead name")}, {"{{2}}"} {t("טלפון", "phone")}, {"{{3}}"} {t("מקור.", "source.")}</p>
        <Select label={t("תבנית", "Template")} value={s.notifyWhatsApp?.templateId ?? ""} onChange={(e) => setS({ ...s, notifyWhatsApp: { enabled: Boolean(s.notifyWhatsApp?.enabled), templateId: e.target.value || null } })} data-testid="notify-agent-template"><option value="">{t("בחר תבנית", "Choose a template")}</option>{templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} · {tpl.status === "APPROVED" ? t("מאושרת", "Approved") : tpl.status === "PENDING" ? t("ממתינה לאישור", "Pending approval") : tpl.status === "REJECTED" ? t("נדחתה", "Rejected") : tpl.status}</option>)}</Select>
        {s.notifyWhatsApp?.enabled && s.notifyWhatsApp.templateId && templates.find((tpl) => tpl.id === s.notifyWhatsApp?.templateId)?.status !== "APPROVED" && <p className="text-xs text-warn">{t("⚠️ התבנית עדיין לא מאושרת – הודעות לא יישלחו עד לאישורה.", "⚠️ The template isn't approved yet – messages won't be sent until it is.")}</p>}
        <div className="text-sm font-medium pt-1">{t("טלפון אישי של כל נציג", "Each agent's personal phone")}</div>
        <div className="grid sm:grid-cols-2 gap-2">{users.map((u) => <div key={u.id} className="flex items-center gap-2 text-sm"><span className="w-28 truncate">{u.fullName}</span><input dir="ltr" className="h-8 flex-1 rounded-md border border-line px-2" placeholder="050-0000000" value={phones[u.id] ?? ""} onChange={(e) => setPhones({ ...phones, [u.id]: e.target.value })} onBlur={async () => { if ((phones[u.id] ?? "") === (u.personalPhone ?? "")) return; try { const r = await api.patch<{ personalPhone: string | null }>(`/api/users/${u.id}`, { personalPhone: phones[u.id] || null }); setUsers((list) => list.map((x) => x.id === u.id ? { ...x, personalPhone: r.personalPhone } : x)); setPhones((p) => ({ ...p, [u.id]: r.personalPhone ?? "" })); toast.success(t(`הטלפון של ${u.fullName} נשמר`, `${u.fullName}'s phone saved`)); } catch (err) { toast.error((err as Error).message); } }} data-testid={`agent-phone-${u.id}`} /></div>)}</div>
        <p className="text-[11px] text-muted">{t("שמירת טלפון זמינה לבעל העסק. נציג בלי טלפון לא יקבל הודעה (מסומן ביומן).", "Saving phones is available to the business owner. An agent without a phone won't get a message (noted in the log).")}</p>
      </div>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="notify-save">{t("שמור הודעה לנציג", "Save agent notification")}</Button></div>
    </div>
  );
}
