"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Panel, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Perms { managerScope: "business" | "team"; agentSeesUnassigned: boolean; agentTransfer: "none" | "all" | "selected"; agentTransferUserIds: string[] }
interface User { id: string; fullName: string; email: string; role: "owner" | "manager" | "agent"; isActive: boolean; team: { name: string } | null }
const ROLE: Record<User["role"], [string, string]> = { owner: ["בעלים", "Owner"], manager: ["מנהל", "Manager"], agent: ["נציג", "Agent"] };

/**
 * "הרשאות": who sees what by role, plus per-user role assignment. Enforced on the server (every list, card, report,
 * search and API uses the same visibility) – the screen only edits the policy.
 */
export function PermissionsTab({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const [p, setP] = useState<Perms | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([api.get<{ settings: { permissions: Perms } }>("/api/settings"), api.get<{ items: User[] }>("/api/users")]);
      setP(s.settings.permissions); setUsers(u.items);
    } catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    if (!p) return; setSaving(true);
    try { await api.patch("/api/settings", { settings: { permissions: p } }); toast.success(t("ההרשאות נשמרו", "Permissions saved")); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  async function setRole(u: User, role: User["role"]) {
    try { await api.patch(`/api/users/${u.id}`, { role }); toast.success(`${u.fullName}: ${t(...ROLE[role])}`); await load(); } catch (e) { toast.error((e as Error).message); }
  }
  if (!p) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const agents = users.filter((u) => u.role === "agent" && u.isActive);
  return (
    <div className="space-y-4" data-testid="permissions-tab">
      <Panel title={t("מה כל תפקיד רואה", "What each role sees")}>
        <table className="w-full text-sm perm-table"><thead><tr><th className="text-start">{t("תפקיד", "Role")}</th><th className="text-start">{t("לידים, אנשי קשר, שיחות, משימות ודוחות", "Leads, contacts, calls, tasks and reports")}</th><th className="text-start">{t("פעולות", "Actions")}</th></tr></thead><tbody>
          <tr><td><Badge tone="accent">{t("בעלים", "Owner")}</Badge></td><td>{t("כל הנתונים של כל המשתמשים בעסק", "All data of all users in the business")}</td><td>{t("הכול, כולל הגדרות, הרשאות וחיבורים", "Everything, including settings, permissions and integrations")}</td></tr>
          <tr><td><Badge tone="info">{t("מנהל", "Manager")}</Badge></td><td><Select aria-label={t("היקף המנהלים", "Manager scope")} value={p.managerScope} disabled={!isOwner} onChange={(e) => setP({ ...p, managerScope: e.target.value as Perms["managerScope"] })} data-testid="perm-manager-scope"><option value="business">{t("הנתונים של כל הנציגים בעסק", "Data of all agents in the business")}</option><option value="team">{t("רק הצוות שהוא מנהל + הנתונים שלו", "Only the team they manage + their own data")}</option></Select></td><td>{t("שיוך והעברת לידים, דוחות, רשימות חיוג, קמפיינים ואוטומציות", "Assigning and transferring leads, reports, dial lists, campaigns and automations")}</td></tr>
          <tr><td><Badge>{t("נציג", "Agent")}</Badge></td><td><div>{t("רק הנתונים שלו: הלידים, אנשי הקשר, השיחות, המשימות והביצועים שלו", "Only their own data: their leads, contacts, calls, tasks and performance")}</div><label className="flex items-center gap-2 mt-1"><input type="checkbox" checked={p.agentSeesUnassigned} disabled={!isOwner} onChange={(e) => setP({ ...p, agentSeesUnassigned: e.target.checked })} data-testid="perm-agent-pool" /> {t("לראות גם לידים ללא שיוך (מאגר משותף)", "Also see unassigned leads (shared pool)")}</label></td>
            <td><Select aria-label={t("העברת לידים על ידי נציגים", "Lead transfer by agents")} value={p.agentTransfer} disabled={!isOwner} onChange={(e) => setP({ ...p, agentTransfer: e.target.value as Perms["agentTransfer"] })} data-testid="perm-agent-transfer"><option value="none">{t("לא יכולים להעביר לידים", "Cannot transfer leads")}</option><option value="all">{t("כל הנציגים יכולים להעביר את הלידים שלהם", "All agents can transfer their leads")}</option><option value="selected">{t("רק נציגים מסוימים…", "Only specific agents…")}</option></Select>
              {p.agentTransfer === "selected" && <div className="mt-2 space-y-1" data-testid="perm-transfer-users">{agents.map((u) => <label key={u.id} className="flex items-center gap-2"><input type="checkbox" disabled={!isOwner} checked={p.agentTransferUserIds.includes(u.id)} onChange={(e) => setP({ ...p, agentTransferUserIds: e.target.checked ? [...p.agentTransferUserIds, u.id] : p.agentTransferUserIds.filter((x) => x !== u.id) })} />{u.fullName}</label>)}{!agents.length && <span className="text-muted">{t("אין נציגים פעילים", "No active agents")}</span>}</div>}</td></tr>
        </tbody></table>
        <p className="text-xs text-muted mt-2">{t("ההרשאות נאכפות בשרת בכל מסך, חיפוש, קישור ישיר ו-API. נציג לא יכול לראות נתונים של נציג אחר גם אם יש לו את הקישור.", "Permissions are enforced on the server in every screen, search, direct link and API. An agent cannot see another agent's data even with the link.")}</p>
        {isOwner ? <div className="flex justify-end mt-2"><Button onClick={save} loading={saving} data-testid="perm-save">{t("שמור הרשאות", "Save permissions")}</Button></div> : <p className="text-xs text-muted mt-2">{t("רק בעל העסק יכול לשנות הרשאות.", "Only the business owner can change permissions.")}</p>}
      </Panel>
      <Panel title={t("משתמשים ותפקידים", "Users and roles")}>
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8">{t("שם", "Name")}</th><th className="text-start">{t("אימייל", "Email")}</th><th className="text-start">{t("צוות", "Team")}</th><th className="text-start">{t("תפקיד", "Role")}</th></tr></thead><tbody className="divide-y divide-line">
          {users.map((u) => <tr key={u.id} className={u.isActive ? "" : "opacity-50"}><td className="h-10">{u.fullName}</td><td className="ltr text-start text-muted">{u.email}</td><td className="text-muted">{u.team?.name ?? "—"}</td>
            <td>{isOwner ? <Select aria-label={t(`תפקיד ${u.fullName}`, `Role ${u.fullName}`)} value={u.role} onChange={(e) => setRole(u, e.target.value as User["role"])} className="w-32" data-testid={`perm-role-${u.id}`}><option value="agent">{t("נציג", "Agent")}</option><option value="manager">{t("מנהל", "Manager")}</option><option value="owner">{t("בעלים", "Owner")}</option></Select> : t(...ROLE[u.role])}</td></tr>)}
        </tbody></table>
        <p className="text-xs text-muted mt-2">{t("הוספת משתמשים חדשים והשבתה – בלשונית \"משתמשים וצוותים\".", "Add and deactivate users in the \"Users & Teams\" tab.")}</p>
      </Panel>
    </div>
  );
}
