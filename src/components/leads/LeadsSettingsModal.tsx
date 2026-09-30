"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, cx } from "@/components/ui";
import { CrmSettings } from "@/components/crm-settings/CrmSettings";
import { StatusesEditor } from "@/components/leads/StatusesEditor";
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
      {mode === "assignment" && manager && <AssignmentEditor />}
    </Modal>
  );
}

function AssignmentEditor() {
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
    try { await api.patch("/api/lead-statuses", { leadAssignment: { mode: s.mode, maxOpenLeadsPerAgent: s.maxOpenLeadsPerAgent, agentIds: s.agentIds, perAgentMax: s.perAgentMax ?? {}, notifyWhatsApp: s.notifyWhatsApp ?? { enabled: false, templateId: null } } }); toast.success(t("חלוקת הלידים נשמרה", "Lead distribution saved")); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!s) return null;
  return (
    <div className="space-y-3" data-testid="assignment-editor">
      <p className="text-xs text-muted">{t("חל על לידים חדשים שנוצרים ללא נציג (טופס, ייבוא, WhatsApp, שיחה נכנסת). ליד שנוצר עם נציג, או איש קשר שכבר שייך לנציג, נשארים אצלו; איש קשר שייבא מנהל מחולק לפי המדיניות.", "Applies to new leads created without an agent (form, import, WhatsApp, inbound call). A lead created with an agent, or a contact already owned by an agent, stays with them; a contact imported by a manager is distributed per the policy.")}</p>
      <Select label={t("שיטת חלוקה", "Distribution method")} value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value as LeadAssignmentSettings["mode"] })} data-testid="assignment-mode">
        <option value="least_loaded">{t("לנציג עם הכי פחות לידים פתוחים", "To the agent with the fewest open leads")}</option>
        <option value="round_robin">{t("Round robin – לפי הסדר, נציג אחרי נציג", "Round robin – in order, agent after agent")}</option>
      </Select>
      <Input label={t("ברירת מחדל: מקסימום לידים פתוחים לנציג (0 = ללא הגבלה)", "Default: max open leads per agent (0 = unlimited)")} type="number" min={0} value={String(s.maxOpenLeadsPerAgent)} onChange={(e) => setS({ ...s, maxOpenLeadsPerAgent: Math.max(0, Number(e.target.value) || 0) })} ltr data-testid="assignment-cap" />
      <div>
        <p className="text-sm font-medium mb-1">{t("כמה לידים כל נציג יקבל", "How many leads each agent gets")}</p>
        <p className="text-xs text-muted mb-2">{t("סמן מי משתתף בחלוקה וקבע לכל נציג מקסימום לידים פתוחים. ריק = ברירת המחדל שלמעלה. אם לא מסומן אף נציג – כולם משתתפים.", "Check who takes part in distribution and set each agent's max open leads. Empty = the default above. If no agent is checked – everyone takes part.")}</p>
        <table className="w-full text-sm" data-testid="assignment-agents"><thead><tr className="text-xs text-muted"><th className="text-start p-1">{t("בחלוקה", "In distribution")}</th><th className="text-start p-1">{t("נציג", "Agent")}</th><th className="text-start p-1">{t("מקסימום לידים פתוחים", "Max open leads")}</th></tr></thead><tbody>{users.map((u) => { const on = !s.agentIds.length || s.agentIds.includes(u.id); const per = s.perAgentMax ?? {}; return (
          <tr key={u.id} className="border-t border-line"><td className="p-1"><input type="checkbox" checked={s.agentIds.includes(u.id)} onChange={(e) => setS({ ...s, agentIds: e.target.checked ? [...s.agentIds, u.id] : s.agentIds.filter((x) => x !== u.id) })} aria-label={t(`${u.fullName} בחלוקה`, `${u.fullName} in distribution`)} /></td><td className={cx("p-1", !on && "text-muted")}>{u.fullName}</td>
          <td className="p-1"><input type="number" min={0} className="h-8 w-28 rounded-md border border-line px-2 ltr" placeholder={s.maxOpenLeadsPerAgent ? String(s.maxOpenLeadsPerAgent) : t("ללא הגבלה", "Unlimited")} value={per[u.id] ?? ""} onChange={(e) => { const v = e.target.value; const next = { ...per }; if (v === "") delete next[u.id]; else next[u.id] = Math.max(0, Number(v) || 0); setS({ ...s, perAgentMax: next }); }} data-testid={`assignment-agent-cap-${u.id}`} /></td></tr>); })}</tbody></table>
      </div>
      <p className="text-[11px] text-muted">{t("נציג שהגיע לתקרה מדולג; אם כולם בתקרה הליד נשאר ללא שיוך ומופיע במסנן \"ללא שיוך\".", "An agent at their cap is skipped; if everyone is at the cap the lead stays unassigned and appears under the \"Unassigned\" filter.")}</p>
      <div className="rounded-lg border border-line p-3 space-y-2" data-testid="notify-agent">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={Boolean(s.notifyWhatsApp?.enabled)} onChange={(e) => setS({ ...s, notifyWhatsApp: { templateId: s.notifyWhatsApp?.templateId ?? null, enabled: e.target.checked } })} data-testid="notify-agent-enabled" /> {t("שלח לנציג הודעת WhatsApp לטלפון האישי כשנכנס אליו ליד חדש", "Send the agent a WhatsApp message to their personal phone when a new lead is assigned to them")}</label>
        <p className="text-xs text-muted">{t("נשלח ממספר ה-WhatsApp של העסק, גם בחלוקה אוטומטית ובהעברה מנציג אחר. וואטסאפ מחייב תבנית מאושרת (הנציג לרוב לא כתב לעסק ב-24 השעות האחרונות). משתנים בתבנית:", "Sent from the business's WhatsApp number, also on automatic distribution and on transfer from another agent. WhatsApp requires an approved template (the agent usually hasn't messaged the business in the last 24 hours). Template variables:")} {"{{1}}"} {t("שם הליד", "lead name")}, {"{{2}}"} {t("טלפון", "phone")}, {"{{3}}"} {t("מקור.", "source.")}</p>
        <Select label={t("תבנית", "Template")} value={s.notifyWhatsApp?.templateId ?? ""} onChange={(e) => setS({ ...s, notifyWhatsApp: { enabled: Boolean(s.notifyWhatsApp?.enabled), templateId: e.target.value || null } })} data-testid="notify-agent-template"><option value="">{t("בחר תבנית", "Choose a template")}</option>{templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} · {tpl.status === "APPROVED" ? t("מאושרת", "Approved") : tpl.status === "PENDING" ? t("ממתינה לאישור", "Pending approval") : tpl.status === "REJECTED" ? t("נדחתה", "Rejected") : tpl.status}</option>)}</Select>
        {s.notifyWhatsApp?.enabled && s.notifyWhatsApp.templateId && templates.find((tpl) => tpl.id === s.notifyWhatsApp?.templateId)?.status !== "APPROVED" && <p className="text-xs text-warn">{t("⚠️ התבנית עדיין לא מאושרת – הודעות לא יישלחו עד לאישורה.", "⚠️ The template isn't approved yet – messages won't be sent until it is.")}</p>}
        <div className="text-sm font-medium pt-1">{t("טלפון אישי של כל נציג", "Each agent's personal phone")}</div>
        <div className="grid sm:grid-cols-2 gap-2">{users.map((u) => <div key={u.id} className="flex items-center gap-2 text-sm"><span className="w-28 truncate">{u.fullName}</span><input dir="ltr" className="h-8 flex-1 rounded-md border border-line px-2" placeholder="050-0000000" value={phones[u.id] ?? ""} onChange={(e) => setPhones({ ...phones, [u.id]: e.target.value })} onBlur={async () => { if ((phones[u.id] ?? "") === (u.personalPhone ?? "")) return; try { const r = await api.patch<{ personalPhone: string | null }>(`/api/users/${u.id}`, { personalPhone: phones[u.id] || null }); setUsers((list) => list.map((x) => x.id === u.id ? { ...x, personalPhone: r.personalPhone } : x)); setPhones((p) => ({ ...p, [u.id]: r.personalPhone ?? "" })); toast.success(t(`הטלפון של ${u.fullName} נשמר`, `${u.fullName}'s phone saved`)); } catch (err) { toast.error((err as Error).message); } }} data-testid={`agent-phone-${u.id}`} /></div>)}</div>
        <p className="text-[11px] text-muted">{t("שמירת טלפון זמינה לבעל העסק. נציג בלי טלפון לא יקבל הודעה (מסומן ביומן).", "Saving phones is available to the business owner. An agent without a phone won't get a message (noted in the log).")}</p>
      </div>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="assignment-save">{t("שמור", "Save")}</Button></div>
    </div>
  );
}
