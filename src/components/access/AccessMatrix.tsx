"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Modal, Panel, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { ACTIONS, DEPENDENCIES, MODULE_LABEL, MODULES, SCOPE_LABEL, TEMPLATES, type DataScope, type ModuleKey, type TemplateKey } from "@/lib/access/catalog";

type Grant = { enabled: boolean; actions: string[] };
export interface AccessUserRow { id: string; fullName: string; email: string; role: string; isActive: boolean; derived: boolean; template: string; scope: DataScope; permissions: Partial<Record<ModuleKey, Grant>>; effective: Record<ModuleKey, { state: string; actions: string[] }> | null }
interface Matrix { users: AccessUserRow[]; seats: Record<ModuleKey, { included: boolean; seats: number | null; used: number; free: number | null }>; entitlement: { planName: string | null; suspended: boolean; modules: Record<ModuleKey, { included: boolean }> }; actor: { id: string; role: string; scope: DataScope; modules: Record<ModuleKey, { state: string; actions: string[] }> } }
const ROLE: Record<string, [string, string]> = { owner: ["בעלים", "Owner"], manager: ["מנהל", "Manager"], agent: ["נציג", "Agent"] };
const TPL: Record<string, [string, string]> = { owner: ["בעלים", "Owner"], custom: ["מותאם אישית", "Custom"], business_manager: ["מנהל עסק", "Business manager"], team_manager: ["מנהל צוות", "Team manager"], agent: ["נציג", "Agent"] };

export function StateBadge({ state }: { state?: string }) {
  const t = useT();
  if (state === "active") return <Badge tone="good">{t("פעיל", "Active")}</Badge>;
  if (state === "not_in_package") return <Badge>{t("לא בחבילה", "Not in plan")}</Badge>;
  if (state === "suspended") return <Badge tone="bad">{t("מושעה", "Suspended")}</Badge>;
  return <Badge tone="warn">{t("חסום", "Blocked")}</Badge>;
}

/** Business manager: users × modules. Only inside this business and the package; the server enforces every rule. */
export function AccessMatrix() {
  const t = useT();
  const [m, setM] = useState<Matrix | null>(null); const [edit, setEdit] = useState<AccessUserRow | null>(null);
  const load = useCallback(() => api.get<Matrix>("/api/access").then(setM).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  if (!m) return <Spinner />;
  const derived = m.users.filter((u) => u.derived && u.role !== "owner" && u.isActive);
  async function confirmMapping() { try { const r = await api.post<{ confirmed: number }>("/api/access/materialize"); toast.success(t(`המיפוי אושר עבור ${r.confirmed} משתמשים`, `Mapping confirmed for ${r.confirmed} users`)); void load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <div className="space-y-4" data-testid="access-matrix">
      {derived.length > 0 && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="access-derived">
        <b>{t(`${derived.length} משתמשים`, `${derived.length} users`)}</b> {t("עובדים לפי מיפוי אוטומטי מהתפקיד הקודם (אותה גישה שהייתה להם לפני המעבר) ועדיין לא אושרו ידנית:", "are working under an automatic mapping from their previous role (the same access they had before the migration) and have not been manually confirmed yet:")} {derived.map((u) => u.fullName).join(", ")}.
        {m.actor.role === "owner" && <Button size="sm" className="ms-2" variant="secondary" onClick={confirmMapping} data-testid="access-confirm-mapping">{t("אשר את המיפוי הנוכחי", "Confirm current mapping")}</Button>}
        <div className="text-xs text-muted mt-1">{t("מודולים שיתווספו לחבילה בעתיד לא ייפתחו אוטומטית למשתמשים – יש להקצות אותם כאן.", "Modules added to the plan in the future will not be opened to users automatically – assign them here.")}</div>
      </div>}
      <Panel bodyClassName="p-0" title={t("מודולים והרשאות לפי משתמש", "Modules and permissions per user")}>
        <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="access-table">
          <thead className="text-xs text-muted"><tr><th className="text-start p-2">{t("משתמש", "User")}</th><th className="text-start">{t("תבנית · היקף", "Template · Scope")}</th>
            {MODULES.map((mod) => { const s = m.seats[mod]; return <th key={mod} className="text-start" data-testid={`seats-${mod}`}>{MODULE_LABEL[mod]}<div className="font-normal">{!s.included ? t("לא בחבילה", "Not in plan") : s.seats === null ? t(`${s.used} · ללא הגבלה`, `${s.used} · Unlimited`) : t(`${s.free} פנויים מתוך ${s.seats}`, `${s.free} free of ${s.seats}`)}</div></th>; })}<th /></tr></thead>
          <tbody className="divide-y divide-line">{m.users.map((u) => (
            <tr key={u.id} className={u.isActive ? "" : "opacity-50"} data-testid={`access-row-${u.id}`}>
              <td className="p-2"><div className="font-medium">{u.fullName}</div><div className="text-xs text-muted">{ROLE[u.role] ? t(...ROLE[u.role]) : u.role}{u.derived && u.role !== "owner" ? t(" · מיפוי אוטומטי", " · Auto-mapped") : ""}</div></td>
              <td className="text-xs">{TPL[u.template] ? t(...TPL[u.template]) : u.template}<div className="text-muted">{SCOPE_LABEL[u.scope]}</div></td>
              {MODULES.map((mod) => <td key={mod} title={u.effective?.[mod]?.actions.map((a) => (ACTIONS[mod] as Record<string, string>)[a]).join(", ")}><StateBadge state={u.effective?.[mod]?.state} /></td>)}
              <td className="p-2">{u.role !== "owner" && u.id !== m.actor.id && u.isActive && (m.actor.role === "owner" || u.role === "agent") && <Button size="sm" variant="ghost" onClick={() => setEdit(u)} data-testid={`access-edit-${u.id}`}>{t("הגדרות", "Settings")}</Button>}</td>
            </tr>))}</tbody></table></div>
        <p className="text-xs text-muted p-2">{t("הגישה בפועל = מה שהעסק רכש ∩ מה שהוקצה למשתמש. ההרשאות נאכפות בשרת בכל מסך, API, ייצוא, משימת רקע ובעוזר ה-AI, וחלות מיד גם על משתמש מחובר.", "Effective access = what the business purchased ∩ what was assigned to the user. Permissions are enforced on the server in every screen, API, export, background job and the AI assistant, and apply immediately even to signed-in users.")}</p>
      </Panel>
      {edit && <UserAccessEditor user={edit} packageModules={m.entitlement.modules} actor={m.actor} endpoint={`/api/access/users/${edit.id}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

/** Edit one user's template, data scope and per-module actions (also used by the platform admin). */
export function UserAccessEditor({ user, packageModules, actor, endpoint, onClose, onSaved }: { user: AccessUserRow; packageModules: Record<ModuleKey, { included: boolean }>; actor: { role: string; modules: Record<ModuleKey, { state: string; actions: string[] }> } | null; endpoint: string; onClose: () => void; onSaved: () => void }) {
  const tr = useT();
  const [template, setTemplate] = useState<TemplateKey | "custom">((user.template in TEMPLATES ? user.template : "custom") as TemplateKey | "custom");
  const [scope, setScope] = useState<DataScope>(user.scope);
  const [mods, setMods] = useState<Partial<Record<ModuleKey, Grant>>>(() => structuredClone(user.permissions));
  const [busy, setBusy] = useState(false);
  const limited = actor && actor.role !== "owner"; // managers may grant only what they have
  const mayGrant = (mod: ModuleKey, a: string) => !limited || (actor!.modules[mod]?.state === "active" && actor!.modules[mod].actions.includes(a));
  function applyTemplate(t: TemplateKey | "custom") {
    setTemplate(t); if (t === "custom") return;
    const tp = TEMPLATES[t]; setScope(tp.scope);
    setMods(Object.fromEntries(MODULES.filter((mod) => packageModules[mod]?.included).map((mod) => [mod, { enabled: true, actions: tp.actions[mod].filter((a) => mayGrant(mod, a)) }])));
  }
  async function save() {
    setBusy(true);
    try { await api.put(endpoint, { template, scope, modules: mods }); toast.success(tr("ההרשאות נשמרו", "Permissions saved")); onSaved(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={tr(`הרשאות – ${user.fullName}`, `Permissions – ${user.fullName}`)} footer={<><Button variant="ghost" onClick={onClose}>{tr("ביטול", "Cancel")}</Button><Button onClick={save} loading={busy} data-testid="access-save">{tr("שמור", "Save")}</Button></>}>
      <div className="space-y-3 text-sm" data-testid="access-editor">
        <div className="grid md:grid-cols-2 gap-3">
          <Select label={tr("תבנית הרשאות", "Permission template")} value={template} onChange={(e) => applyTemplate(e.target.value as TemplateKey | "custom")} data-testid="access-template">{(Object.keys(TEMPLATES) as TemplateKey[]).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}<option value="custom">{tr("מותאם אישית", "Custom")}</option></Select>
          <Select label={tr("היקף נתונים", "Data scope")} value={scope} onChange={(e) => { setScope(e.target.value as DataScope); setTemplate("custom"); }} data-testid="access-scope">{(Object.keys(SCOPE_LABEL) as DataScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}</Select>
        </div>
        <p className="text-xs text-muted">{tr("היקף הנתונים קובע אילו לידים, אנשי קשר ושיחות המשתמש רואה בכל המודולים. ליד שהועבר ממנו לא יוצג לו, אלא אם ההיקף רחב יותר.", "The data scope determines which leads, contacts and conversations the user sees across all modules. A lead reassigned away from them will not be shown unless the scope is broader.")}</p>
        {MODULES.map((mod) => { const inPkg = packageModules[mod]?.included; const g = mods[mod] ?? { enabled: false, actions: [] }; const dep = DEPENDENCIES.find((d) => d.module === mod); return (
          <div key={mod} className={`rounded-lg border border-line p-3 ${inPkg ? "" : "opacity-60"}`} data-testid={`access-module-${mod}`}>
            <label className="flex items-center gap-2 font-medium"><input type="checkbox" disabled={!inPkg} checked={Boolean(inPkg && g.enabled)} onChange={(e) => { setTemplate("custom"); setMods({ ...mods, [mod]: { ...g, enabled: e.target.checked } }); }} data-testid={`access-enable-${mod}`} />{MODULE_LABEL[mod]}{!inPkg && <Badge>{tr("לא כלול בחבילה", "Not included in plan")}</Badge>}</label>
            {inPkg && g.enabled && <div className="flex flex-wrap gap-3 mt-2 ps-6">{Object.entries(ACTIONS[mod]).map(([a, label]) => <label key={a} className={`flex items-center gap-1 ${mayGrant(mod, a) ? "" : "opacity-50"}`}><input type="checkbox" disabled={!mayGrant(mod, a)} checked={g.actions.includes(a)} onChange={(e) => { setTemplate("custom"); setMods({ ...mods, [mod]: { ...g, actions: e.target.checked ? [...g.actions, a] : g.actions.filter((x) => x !== a) } }); }} data-testid={`access-${mod}-${a}`} />{label}</label>)}</div>}
            {dep && inPkg && <p className="text-xs text-muted mt-1 ps-6">{dep.note}</p>}
          </div>); })}
        <p className="text-xs text-muted">{tr("פעולות שגורמות לשליחה (אישור ושליחת קמפיינים, מענה) נפרדות מהכנת טיוטות. הרשאה אינה מבטלת מכסות, הגבלות שליחה ואישורים קיימים.", "Actions that trigger sending (approving and sending campaigns, replying) are separate from drafting. A permission does not override existing quotas, sending limits or approvals.")}</p>
      </div>
    </Modal>
  );
}
