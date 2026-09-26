"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select, cx } from "@/components/ui";
import { CrmSettings } from "@/components/crm-settings/CrmSettings";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import type { LeadAssignmentSettings, LeadStatusConfig } from "@/lib/lead-statuses";

type Tab = "dialer" | "statuses" | "assignment";

/**
 * "הגדרות חייגן" from the leads screen: the per-agent dialer settings (formerly /crm-settings), and for managers the
 * editable lead statuses and the lead-distribution policy (round robin / least loaded, cap per agent).
 */
export function LeadsSettingsModal({ open, onClose, manager, initialTab = "dialer" }: { open: boolean; onClose: () => void; manager: boolean; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  const [dirty, setDirty] = useState(false);
  const close = () => { if (dirty && !window.confirm("יש שינויים בהגדרות החייגן שלא נשמרו. לסגור בלי לשמור?")) return; onClose(); };
  const tabs: Array<[Tab, string]> = [["dialer", "חייגן"], ...(manager ? [["statuses", "סטטוסים"] as [Tab, string], ["assignment", "חלוקת לידים"] as [Tab, string]] : [])];
  return (
    <Modal open={open} onClose={close} title={tab === "statuses" ? "עריכת סטטוסים" : tab === "assignment" ? "חלוקת לידים" : "הגדרות חייגן"} width="max-w-4xl">
      <div className="flex gap-1 border-b border-line mb-3" role="tablist">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("h-9 px-3 text-sm border-b-2 -mb-px", tab === k ? "border-accent font-medium" : "border-transparent text-muted")} data-testid={`leads-settings-tab-${k}`}>{label}</button>)}</div>
      {tab === "dialer" && <CrmSettings embedded onDirtyChange={setDirty} />}
      {tab === "statuses" && manager && <StatusesEditor />}
      {tab === "assignment" && manager && <AssignmentEditor />}
    </Modal>
  );
}

function StatusesEditor() {
  const statuses = useLeadStatuses();
  const [rows, setRows] = useState<LeadStatusConfig[]>(statuses.items);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setRows(statuses.items); }, [statuses.items]);
  const move = (i: number, d: -1 | 1) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  async function save() {
    setSaving(true);
    try { const r = await api.patch<{ items: LeadStatusConfig[] }>("/api/lead-statuses", { leadStatuses: rows }); statuses.refresh(r.items); toast.success("הסטטוסים נשמרו"); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-2" data-testid="statuses-editor">
      <p className="text-xs text-muted">שנה שם, סדר או הסתר סטטוס. המפתח הפנימי נשאר (דוחות ואוטומציות ממשיכים לעבוד); סטטוס מוסתר לא יוצג לבחירה אבל לידים קיימים בו נשארים.</p>
      <ul className="divide-y divide-line">
        {rows.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 py-1.5">
            <span className="text-[11px] text-muted w-20 ltr">{s.key}</span>
            <Input value={s.label} onChange={(e) => setRows((r) => r.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} aria-label={`שם הסטטוס ${s.key}`} className="flex-1" data-testid={`status-label-${s.key}`} />
            <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={s.hidden} onChange={(e) => setRows((r) => r.map((x, j) => j === i ? { ...x, hidden: e.target.checked } : x))} /> מוסתר</label>
            <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="הזז למעלה">↑</Button>
            <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="הזז למטה">↓</Button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="statuses-save">שמור סטטוסים</Button></div>
    </div>
  );
}

function AssignmentEditor() {
  const [s, setS] = useState<LeadAssignmentSettings | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string; isActive: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get<{ leadAssignment: LeadAssignmentSettings }>("/api/lead-statuses").then((r) => setS(r.leadAssignment)).catch((e) => toast.error(e.message));
    api.get<{ items: typeof users }>("/api/users").then((r) => setUsers(r.items.filter((u) => u.isActive && u.role !== "owner"))).catch(() => undefined);
  }, []);
  async function save() {
    if (!s) return; setSaving(true);
    try { await api.patch("/api/lead-statuses", { leadAssignment: { mode: s.mode, maxOpenLeadsPerAgent: s.maxOpenLeadsPerAgent, agentIds: s.agentIds, perAgentMax: s.perAgentMax ?? {} } }); toast.success("חלוקת הלידים נשמרה"); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!s) return null;
  return (
    <div className="space-y-3" data-testid="assignment-editor">
      <p className="text-xs text-muted">חל על לידים חדשים שנוצרים ללא נציג (טופס, ייבוא, WhatsApp, שיחה נכנסת). ליד שנוצר עם נציג, או איש קשר שכבר שייך לנציג, נשארים אצלו; איש קשר שייבא מנהל מחולק לפי המדיניות.</p>
      <Select label="שיטת חלוקה" value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value as LeadAssignmentSettings["mode"] })} data-testid="assignment-mode">
        <option value="least_loaded">לנציג עם הכי פחות לידים פתוחים</option>
        <option value="round_robin">Round robin – לפי הסדר, נציג אחרי נציג</option>
      </Select>
      <Input label="ברירת מחדל: מקסימום לידים פתוחים לנציג (0 = ללא הגבלה)" type="number" min={0} value={String(s.maxOpenLeadsPerAgent)} onChange={(e) => setS({ ...s, maxOpenLeadsPerAgent: Math.max(0, Number(e.target.value) || 0) })} ltr data-testid="assignment-cap" />
      <div>
        <p className="text-sm font-medium mb-1">כמה לידים כל נציג יקבל</p>
        <p className="text-xs text-muted mb-2">סמן מי משתתף בחלוקה וקבע לכל נציג מקסימום לידים פתוחים. ריק = ברירת המחדל שלמעלה. אם לא מסומן אף נציג – כולם משתתפים.</p>
        <table className="w-full text-sm" data-testid="assignment-agents"><thead><tr className="text-xs text-muted"><th className="text-start p-1">בחלוקה</th><th className="text-start p-1">נציג</th><th className="text-start p-1">מקסימום לידים פתוחים</th></tr></thead><tbody>{users.map((u) => { const on = !s.agentIds.length || s.agentIds.includes(u.id); const per = s.perAgentMax ?? {}; return (
          <tr key={u.id} className="border-t border-line"><td className="p-1"><input type="checkbox" checked={s.agentIds.includes(u.id)} onChange={(e) => setS({ ...s, agentIds: e.target.checked ? [...s.agentIds, u.id] : s.agentIds.filter((x) => x !== u.id) })} aria-label={`${u.fullName} בחלוקה`} /></td><td className={cx("p-1", !on && "text-muted")}>{u.fullName}</td>
          <td className="p-1"><input type="number" min={0} className="h-8 w-28 rounded-md border border-line px-2 ltr" placeholder={s.maxOpenLeadsPerAgent ? String(s.maxOpenLeadsPerAgent) : "ללא הגבלה"} value={per[u.id] ?? ""} onChange={(e) => { const v = e.target.value; const next = { ...per }; if (v === "") delete next[u.id]; else next[u.id] = Math.max(0, Number(v) || 0); setS({ ...s, perAgentMax: next }); }} data-testid={`assignment-agent-cap-${u.id}`} /></td></tr>); })}</tbody></table>
      </div>
      <p className="text-[11px] text-muted">נציג שהגיע לתקרה מדולג; אם כולם בתקרה הליד נשאר ללא שיוך ומופיע במסנן &quot;ללא שיוך&quot;.</p>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="assignment-save">שמור</Button></div>
    </div>
  );
}
