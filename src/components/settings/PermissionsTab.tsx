"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Panel, Select, Spinner } from "@/components/ui";

interface Perms { managerScope: "business" | "team"; agentSeesUnassigned: boolean; agentTransfer: "none" | "all" | "selected"; agentTransferUserIds: string[] }
interface User { id: string; fullName: string; email: string; role: "owner" | "manager" | "agent"; isActive: boolean; team: { name: string } | null }
const ROLE: Record<User["role"], string> = { owner: "בעלים", manager: "מנהל", agent: "נציג" };

/**
 * "הרשאות": who sees what by role, plus per-user role assignment. Enforced on the server (every list, card, report,
 * search and API uses the same visibility) – the screen only edits the policy.
 */
export function PermissionsTab({ isOwner }: { isOwner: boolean }) {
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
    try { await api.patch("/api/settings", { settings: { permissions: p } }); toast.success("ההרשאות נשמרו"); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  async function setRole(u: User, role: User["role"]) {
    try { await api.patch(`/api/users/${u.id}`, { role }); toast.success(`${u.fullName}: ${ROLE[role]}`); await load(); } catch (e) { toast.error((e as Error).message); }
  }
  if (!p) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const agents = users.filter((u) => u.role === "agent" && u.isActive);
  return (
    <div className="space-y-4" data-testid="permissions-tab">
      <Panel title="מה כל תפקיד רואה">
        <table className="w-full text-sm perm-table"><thead><tr><th className="text-start">תפקיד</th><th className="text-start">לידים, אנשי קשר, שיחות, משימות ודוחות</th><th className="text-start">פעולות</th></tr></thead><tbody>
          <tr><td><Badge tone="accent">בעלים</Badge></td><td>כל הנתונים של כל המשתמשים בעסק</td><td>הכול, כולל הגדרות, הרשאות וחיבורים</td></tr>
          <tr><td><Badge tone="info">מנהל</Badge></td><td><Select aria-label="היקף המנהלים" value={p.managerScope} disabled={!isOwner} onChange={(e) => setP({ ...p, managerScope: e.target.value as Perms["managerScope"] })} data-testid="perm-manager-scope"><option value="business">הנתונים של כל הנציגים בעסק</option><option value="team">רק הצוות שהוא מנהל + הנתונים שלו</option></Select></td><td>שיוך והעברת לידים, דוחות, רשימות חיוג, קמפיינים ואוטומציות</td></tr>
          <tr><td><Badge>נציג</Badge></td><td><div>רק הנתונים שלו: הלידים, אנשי הקשר, השיחות, המשימות והביצועים שלו</div><label className="flex items-center gap-2 mt-1"><input type="checkbox" checked={p.agentSeesUnassigned} disabled={!isOwner} onChange={(e) => setP({ ...p, agentSeesUnassigned: e.target.checked })} data-testid="perm-agent-pool" /> לראות גם לידים ללא שיוך (מאגר משותף)</label></td>
            <td><Select aria-label="העברת לידים על ידי נציגים" value={p.agentTransfer} disabled={!isOwner} onChange={(e) => setP({ ...p, agentTransfer: e.target.value as Perms["agentTransfer"] })} data-testid="perm-agent-transfer"><option value="none">לא יכולים להעביר לידים</option><option value="all">כל הנציגים יכולים להעביר את הלידים שלהם</option><option value="selected">רק נציגים מסוימים…</option></Select>
              {p.agentTransfer === "selected" && <div className="mt-2 space-y-1" data-testid="perm-transfer-users">{agents.map((u) => <label key={u.id} className="flex items-center gap-2"><input type="checkbox" disabled={!isOwner} checked={p.agentTransferUserIds.includes(u.id)} onChange={(e) => setP({ ...p, agentTransferUserIds: e.target.checked ? [...p.agentTransferUserIds, u.id] : p.agentTransferUserIds.filter((x) => x !== u.id) })} />{u.fullName}</label>)}{!agents.length && <span className="text-muted">אין נציגים פעילים</span>}</div>}</td></tr>
        </tbody></table>
        <p className="text-xs text-muted mt-2">ההרשאות נאכפות בשרת בכל מסך, חיפוש, קישור ישיר ו-API. נציג לא יכול לראות נתונים של נציג אחר גם אם יש לו את הקישור.</p>
        {isOwner ? <div className="flex justify-end mt-2"><Button onClick={save} loading={saving} data-testid="perm-save">שמור הרשאות</Button></div> : <p className="text-xs text-muted mt-2">רק בעל העסק יכול לשנות הרשאות.</p>}
      </Panel>
      <Panel title="משתמשים ותפקידים">
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8">שם</th><th className="text-start">אימייל</th><th className="text-start">צוות</th><th className="text-start">תפקיד</th></tr></thead><tbody className="divide-y divide-line">
          {users.map((u) => <tr key={u.id} className={u.isActive ? "" : "opacity-50"}><td className="h-10">{u.fullName}</td><td className="ltr text-start text-muted">{u.email}</td><td className="text-muted">{u.team?.name ?? "—"}</td>
            <td>{isOwner ? <Select aria-label={`תפקיד ${u.fullName}`} value={u.role} onChange={(e) => setRole(u, e.target.value as User["role"])} className="w-32" data-testid={`perm-role-${u.id}`}><option value="agent">נציג</option><option value="manager">מנהל</option><option value="owner">בעלים</option></Select> : ROLE[u.role]}</td></tr>)}
        </tbody></table>
        <p className="text-xs text-muted mt-2">הוספת משתמשים חדשים והשבתה – בלשונית &quot;משתמשים וצוותים&quot;.</p>
      </Panel>
    </div>
  );
}
