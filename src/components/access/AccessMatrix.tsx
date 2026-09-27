"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Modal, Panel, Select, Spinner } from "@/components/ui";
import { ACTIONS, DEPENDENCIES, MODULE_LABEL, MODULES, SCOPE_LABEL, TEMPLATES, type DataScope, type ModuleKey, type TemplateKey } from "@/lib/access/catalog";

type Grant = { enabled: boolean; actions: string[] };
export interface AccessUserRow { id: string; fullName: string; email: string; role: string; isActive: boolean; derived: boolean; template: string; scope: DataScope; permissions: Partial<Record<ModuleKey, Grant>>; effective: Record<ModuleKey, { state: string; actions: string[] }> | null }
interface Matrix { users: AccessUserRow[]; seats: Record<ModuleKey, { included: boolean; seats: number | null; used: number; free: number | null }>; entitlement: { planName: string | null; suspended: boolean; modules: Record<ModuleKey, { included: boolean }> }; actor: { id: string; role: string; scope: DataScope; modules: Record<ModuleKey, { state: string; actions: string[] }> } }
const ROLE: Record<string, string> = { owner: "בעלים", manager: "מנהל", agent: "נציג" };
const TPL: Record<string, string> = { owner: "בעלים", custom: "מותאם אישית", business_manager: "מנהל עסק", team_manager: "מנהל צוות", agent: "נציג" };

export function StateBadge({ state }: { state?: string }) {
  if (state === "active") return <Badge tone="good">פעיל</Badge>;
  if (state === "not_in_package") return <Badge>לא בחבילה</Badge>;
  if (state === "suspended") return <Badge tone="bad">מושעה</Badge>;
  return <Badge tone="warn">חסום</Badge>;
}

/** Business manager: users × modules. Only inside this business and the package; the server enforces every rule. */
export function AccessMatrix() {
  const [m, setM] = useState<Matrix | null>(null); const [edit, setEdit] = useState<AccessUserRow | null>(null);
  const load = useCallback(() => api.get<Matrix>("/api/access").then(setM).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  if (!m) return <Spinner />;
  const derived = m.users.filter((u) => u.derived && u.role !== "owner" && u.isActive);
  async function confirmMapping() { try { const r = await api.post<{ confirmed: number }>("/api/access/materialize"); toast.success(`המיפוי אושר עבור ${r.confirmed} משתמשים`); void load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <div className="space-y-4" data-testid="access-matrix">
      {derived.length > 0 && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="access-derived">
        <b>{derived.length} משתמשים</b> עובדים לפי מיפוי אוטומטי מהתפקיד הקודם (אותה גישה שהייתה להם לפני המעבר) ועדיין לא אושרו ידנית: {derived.map((u) => u.fullName).join(", ")}.
        {m.actor.role === "owner" && <Button size="sm" className="ms-2" variant="secondary" onClick={confirmMapping} data-testid="access-confirm-mapping">אשר את המיפוי הנוכחי</Button>}
        <div className="text-xs text-muted mt-1">מודולים שיתווספו לחבילה בעתיד לא ייפתחו אוטומטית למשתמשים – יש להקצות אותם כאן.</div>
      </div>}
      <Panel bodyClassName="p-0" title="מודולים והרשאות לפי משתמש">
        <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="access-table">
          <thead className="text-xs text-muted"><tr><th className="text-start p-2">משתמש</th><th className="text-start">תבנית · היקף</th>
            {MODULES.map((mod) => { const s = m.seats[mod]; return <th key={mod} className="text-start" data-testid={`seats-${mod}`}>{MODULE_LABEL[mod]}<div className="font-normal">{!s.included ? "לא בחבילה" : s.seats === null ? `${s.used} · ללא הגבלה` : `${s.free} פנויים מתוך ${s.seats}`}</div></th>; })}<th /></tr></thead>
          <tbody className="divide-y divide-line">{m.users.map((u) => (
            <tr key={u.id} className={u.isActive ? "" : "opacity-50"} data-testid={`access-row-${u.id}`}>
              <td className="p-2"><div className="font-medium">{u.fullName}</div><div className="text-xs text-muted">{ROLE[u.role] ?? u.role}{u.derived && u.role !== "owner" ? " · מיפוי אוטומטי" : ""}</div></td>
              <td className="text-xs">{TPL[u.template] ?? u.template}<div className="text-muted">{SCOPE_LABEL[u.scope]}</div></td>
              {MODULES.map((mod) => <td key={mod} title={u.effective?.[mod]?.actions.map((a) => (ACTIONS[mod] as Record<string, string>)[a]).join(", ")}><StateBadge state={u.effective?.[mod]?.state} /></td>)}
              <td className="p-2">{u.role !== "owner" && u.id !== m.actor.id && u.isActive && (m.actor.role === "owner" || u.role === "agent") && <Button size="sm" variant="ghost" onClick={() => setEdit(u)} data-testid={`access-edit-${u.id}`}>הגדרות</Button>}</td>
            </tr>))}</tbody></table></div>
        <p className="text-xs text-muted p-2">הגישה בפועל = מה שהעסק רכש ∩ מה שהוקצה למשתמש. ההרשאות נאכפות בשרת בכל מסך, API, ייצוא, משימת רקע ובעוזר ה-AI, וחלות מיד גם על משתמש מחובר.</p>
      </Panel>
      {edit && <UserAccessEditor user={edit} packageModules={m.entitlement.modules} actor={m.actor} endpoint={`/api/access/users/${edit.id}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

/** Edit one user's template, data scope and per-module actions (also used by the platform admin). */
export function UserAccessEditor({ user, packageModules, actor, endpoint, onClose, onSaved }: { user: AccessUserRow; packageModules: Record<ModuleKey, { included: boolean }>; actor: { role: string; modules: Record<ModuleKey, { state: string; actions: string[] }> } | null; endpoint: string; onClose: () => void; onSaved: () => void }) {
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
    try { await api.put(endpoint, { template, scope, modules: mods }); toast.success("ההרשאות נשמרו"); onSaved(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={`הרשאות – ${user.fullName}`} footer={<><Button variant="ghost" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} data-testid="access-save">שמור</Button></>}>
      <div className="space-y-3 text-sm" data-testid="access-editor">
        <div className="grid md:grid-cols-2 gap-3">
          <Select label="תבנית הרשאות" value={template} onChange={(e) => applyTemplate(e.target.value as TemplateKey | "custom")} data-testid="access-template">{(Object.keys(TEMPLATES) as TemplateKey[]).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}<option value="custom">מותאם אישית</option></Select>
          <Select label="היקף נתונים" value={scope} onChange={(e) => { setScope(e.target.value as DataScope); setTemplate("custom"); }} data-testid="access-scope">{(Object.keys(SCOPE_LABEL) as DataScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}</Select>
        </div>
        <p className="text-xs text-muted">היקף הנתונים קובע אילו לידים, אנשי קשר ושיחות המשתמש רואה בכל המודולים. ליד שהועבר ממנו לא יוצג לו, אלא אם ההיקף רחב יותר.</p>
        {MODULES.map((mod) => { const inPkg = packageModules[mod]?.included; const g = mods[mod] ?? { enabled: false, actions: [] }; const dep = DEPENDENCIES.find((d) => d.module === mod); return (
          <div key={mod} className={`rounded-lg border border-line p-3 ${inPkg ? "" : "opacity-60"}`} data-testid={`access-module-${mod}`}>
            <label className="flex items-center gap-2 font-medium"><input type="checkbox" disabled={!inPkg} checked={Boolean(inPkg && g.enabled)} onChange={(e) => { setTemplate("custom"); setMods({ ...mods, [mod]: { ...g, enabled: e.target.checked } }); }} data-testid={`access-enable-${mod}`} />{MODULE_LABEL[mod]}{!inPkg && <Badge>לא כלול בחבילה</Badge>}</label>
            {inPkg && g.enabled && <div className="flex flex-wrap gap-3 mt-2 ps-6">{Object.entries(ACTIONS[mod]).map(([a, label]) => <label key={a} className={`flex items-center gap-1 ${mayGrant(mod, a) ? "" : "opacity-50"}`}><input type="checkbox" disabled={!mayGrant(mod, a)} checked={g.actions.includes(a)} onChange={(e) => { setTemplate("custom"); setMods({ ...mods, [mod]: { ...g, actions: e.target.checked ? [...g.actions, a] : g.actions.filter((x) => x !== a) } }); }} data-testid={`access-${mod}-${a}`} />{label}</label>)}</div>}
            {dep && inPkg && <p className="text-xs text-muted mt-1 ps-6">{dep.note}</p>}
          </div>); })}
        <p className="text-xs text-muted">פעולות שגורמות לשליחה (אישור ושליחת קמפיינים, מענה) נפרדות מהכנת טיוטות. הרשאה אינה מבטלת מכסות, הגבלות שליחה ואישורים קיימים.</p>
      </div>
    </Modal>
  );
}
