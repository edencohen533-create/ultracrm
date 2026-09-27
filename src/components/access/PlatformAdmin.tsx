"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Select, Spinner, Textarea, cx } from "@/components/ui";
import { ACCESS_STATUS_LABEL, DEPENDENCIES, MODULE_LABEL, MODULES, QUOTA_LABEL, QUOTA_METRICS, SOURCE_LABEL, type ModuleKey } from "@/lib/access/catalog";
import { StateBadge, UserAccessEditor, type AccessUserRow } from "./AccessMatrix";

interface BizRow { id: string; name: string; isActive: boolean; accessStatus: string; accessUntil: string | null; billingStatus: string; planVersion: { id: string; version: number; name: string } | null; users: number; needsPackage: boolean; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: string[] }> }
interface Version { id: string; version: number; name: string; modules: Record<string, { included: boolean; seats: number | null }>; quotas: Record<string, number | null>; createdAt: string; businesses: number }
interface Plan { id: string; name: string; description: string | null; currentVersion: number; versions: Version[] }
interface Impact { modulesRemoved: ModuleKey[]; usersLosing: Record<string, Array<{ id: string; fullName: string }>>; seatOverflow: Record<string, { seats: number; holders: Array<{ id: string; fullName: string }> }>; campaigns: Array<{ id: string; name: string; channel: string; status: string }>; journeys: Array<{ id: string; name: string }>; inboxAutomations: number; serviceAgent: boolean; dialerSessions: number; dialLists: number }
type Target = { planVersionId?: string | null; revokeGrantId?: string; addGrant?: { module: ModuleKey; kind: string; seats: number | null; expiresAt: string | null } };
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("he-IL") : "");

export function PlatformAdmin() {
  const [tab, setTab] = useState<"businesses" | "plans" | "requests">("businesses");
  return (
    <div className="p-5 space-y-4 max-w-6xl" data-testid="platform-admin">
      <h1 className="text-lg font-semibold">ניהול פלטפורמה – חבילות והרשאות</h1>
      <div className="flex gap-1 border-b border-line">{([["businesses", "עסקים"], ["plans", "חבילות"], ["requests", "בקשות והיסטוריה"]] as const).map(([k, l]) => <button key={k} onClick={() => setTab(k)} data-testid={`platform-tab-${k}`} className={cx("px-4 h-10 text-sm -mb-px border-b-2", tab === k ? "border-accent text-accent font-semibold" : "border-transparent text-muted")}>{l}</button>)}</div>
      {tab === "businesses" && <Businesses />}
      {tab === "plans" && <Plans />}
      {tab === "requests" && <Requests />}
    </div>
  );
}

// ─── businesses ──────────────────────────────────────────────────────────────────────────────────────────────────
function Businesses() {
  const [rows, setRows] = useState<BizRow[] | null>(null); const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ items: BizRow[] }>("/api/platform/businesses").then((r) => setRows(r.items)).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <Spinner />;
  return (
    <>
      <Panel bodyClassName="p-0"><table className="w-full text-sm" data-testid="platform-businesses"><thead className="text-xs text-muted"><tr><th className="text-start p-2">עסק</th><th className="text-start">חבילה</th><th className="text-start">גישה</th>{MODULES.map((m) => <th key={m} className="text-start">{MODULE_LABEL[m]}</th>)}<th /></tr></thead>
        <tbody className="divide-y divide-line">{rows.map((b) => (
          <tr key={b.id} data-testid="platform-business-row">
            <td className="p-2 font-medium">{b.name}<div className="text-xs text-muted">{b.users} משתמשים</div></td>
            <td>{b.planVersion ? `${b.planVersion.name} · v${b.planVersion.version}` : <Badge tone="warn">נדרש שיוך חבילה</Badge>}</td>
            <td><Badge tone={b.accessStatus === "active" ? "good" : b.accessStatus === "suspended" ? "bad" : "warn"}>{ACCESS_STATUS_LABEL[b.accessStatus]}{b.accessUntil ? ` · ${fmt(b.accessUntil)}` : ""}</Badge></td>
            {MODULES.map((m) => <td key={m} className="text-xs">{b.modules[m].included ? <><Badge tone="good">✓</Badge> <span className="text-muted">{b.modules[m].seats === null ? "∞" : b.modules[m].seats}</span><div className="text-muted">{b.modules[m].sources.map((s) => SOURCE_LABEL[s] ?? s).join(" + ")}</div></> : "—"}</td>)}
            <td className="p-2"><Button size="sm" variant="ghost" onClick={() => setOpen(b.id)} data-testid={`platform-open-${b.id}`}>ניהול</Button></td>
          </tr>))}</tbody></table></Panel>
      {open && <BusinessDetail id={open} onClose={() => { setOpen(null); void load(); }} />}
    </>
  );
}

interface Detail { business: { id: string; name: string; accessStatus: string; accessUntil: string | null; billingStatus: string; planVersionId: string | null }; entitlement: { planName: string | null; planVersion: number | null; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: Array<{ type: string; expiresAt: string | null; grantId?: string }> }> }; seats: Record<ModuleKey, { used: number; seats: number | null; free: number | null }>; grants: Array<{ id: string; module: string; kind: string; seats: number | null; expiresAt: string | null; revokedAt: string | null; note: string | null; createdAt: string }>; users: AccessUserRow[]; audit: Array<{ id: string; action: string; createdAt: string; targetUserId: string | null }> }

function BusinessDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null); const [plans, setPlans] = useState<Plan[]>([]); const [edit, setEdit] = useState<AccessUserRow | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [status, setStatus] = useState("active"); const [until, setUntil] = useState("");
  const [grant, setGrant] = useState<{ module: ModuleKey; kind: string; seats: string; expiresAt: string }>({ module: "crm", kind: "trial", seats: "", expiresAt: "" });
  const load = useCallback(async () => {
    try { const r = await api.get<Detail>(`/api/platform/businesses/${id}`); setD(r); setStatus(r.business.accessStatus); setUntil(r.business.accessUntil?.slice(0, 10) ?? ""); setPlans((await api.get<{ items: Plan[] }>("/api/platform/plans")).items); }
    catch (e) { toast.error((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function saveStatus() { try { await api.post(`/api/platform/businesses/${id}/status`, { status, until: until ? new Date(`${until}T23:59:59`).toISOString() : null }); toast.success("סטטוס הגישה עודכן"); void load(); } catch (e) { toast.error((e as Error).message); } }
  if (!d) return <Modal open onClose={onClose} title="טוען…"><Spinner /></Modal>;
  const versions = plans.flatMap((p) => p.versions.map((v) => ({ ...v, planName: p.name })));
  return (
    <Modal open onClose={onClose} width="max-w-5xl" title={`ניהול העסק: ${d.business.name}`}>
      <div className="space-y-4 text-sm" data-testid="platform-business-detail">
        <Panel title="זכאות בפועל ומקורה">
          <table className="w-full text-sm"><tbody className="divide-y divide-line">{MODULES.map((m) => { const x = d.entitlement.modules[m]; return (
            <tr key={m} data-testid={`platform-ent-${m}`}><td className="py-1.5 w-40 font-medium">{MODULE_LABEL[m]}</td><td>{x.included ? <Badge tone="good">כלול</Badge> : <Badge>לא כלול</Badge>}</td>
              <td className="text-xs text-muted">{x.sources.map((s) => `${SOURCE_LABEL[s.type] ?? s.type}${s.expiresAt ? ` (עד ${fmt(s.expiresAt)})` : ""}`).join(" + ") || "—"}</td>
              <td className="tabular text-xs">{x.included ? (x.seats === null ? `${d.seats[m].used} · ללא הגבלה` : `${d.seats[m].used}/${x.seats}`) : ""}</td></tr>); })}</tbody></table>
        </Panel>
        <div className="grid md:grid-cols-2 gap-3">
          <Panel title="חבילה">
            <Select label="שיוך לגרסת חבילה" value={d.business.planVersionId ?? ""} onChange={(e) => setTarget({ planVersionId: e.target.value || null })} data-testid="platform-assign-version">
              <option value="">ללא חבילה (ברירת מחדל קודמת)</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.planName} · גרסה {v.version}</option>)}
            </Select>
            <p className="text-xs text-muted mt-1">כל שינוי מציג קודם את ההשפעה ודורש אישור.</p>
          </Panel>
          <Panel title="סטטוס גישה (נפרד מתשלום)">
            <div className="flex flex-wrap gap-2 items-end">
              <Select label="סטטוס" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="platform-status">{Object.entries(ACCESS_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              {(status === "trial" || status === "grace") && <Input label="עד תאריך" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
              <Button size="sm" onClick={saveStatus} data-testid="platform-status-save">שמור</Button>
            </div>
            <p className="text-xs text-muted mt-1">תשלום: {d.business.billingStatus === "manual" ? "שיוך ידני – אין חיבור לסליקה, התשלום אינו מאומת" : d.business.billingStatus}</p>
          </Panel>
        </div>
        <Panel title="תוספות, ניסיונות והרשאות זמניות">
          <div className="flex flex-wrap gap-2 items-end">
            <Select label="מודול" value={grant.module} onChange={(e) => setGrant({ ...grant, module: e.target.value as ModuleKey })}>{MODULES.map((m) => <option key={m} value={m}>{MODULE_LABEL[m]}</option>)}</Select>
            <Select label="סוג" value={grant.kind} onChange={(e) => setGrant({ ...grant, kind: e.target.value })}><option value="addon">תוספת</option><option value="trial">ניסיון</option><option value="temporary">הרשאה זמנית</option></Select>
            <Input label="מושבים (ריק = ללא הגבלה)" type="number" value={grant.seats} onChange={(e) => setGrant({ ...grant, seats: e.target.value })} />
            <Input label="תפוגה" type="date" value={grant.expiresAt} onChange={(e) => setGrant({ ...grant, expiresAt: e.target.value })} />
            <Button size="sm" onClick={() => setTarget({ addGrant: { module: grant.module, kind: grant.kind, seats: grant.seats === "" ? null : Number(grant.seats), expiresAt: grant.expiresAt ? new Date(`${grant.expiresAt}T23:59:59`).toISOString() : null } })} data-testid="platform-add-grant">הוסף</Button>
          </div>
          <ul className="mt-2 divide-y divide-line">{d.grants.map((g) => <li key={g.id} className="flex items-center gap-2 py-1 text-xs"><span className="w-32">{MODULE_LABEL[g.module as ModuleKey] ?? g.module}</span><Badge>{SOURCE_LABEL[g.kind] ?? g.kind}</Badge><span>{g.seats === null ? "ללא הגבלת מושבים" : `${g.seats} מושבים`}</span>{g.expiresAt && <span>עד {fmt(g.expiresAt)}</span>}{g.revokedAt ? <Badge tone="neutral">בוטל</Badge> : <Button size="sm" variant="ghost" onClick={() => setTarget({ revokeGrantId: g.id })}>בטל</Button>}</li>)}</ul>
        </Panel>
        <Panel title="משתמשים והרשאות" bodyClassName="p-0">
          <table className="w-full text-sm"><tbody className="divide-y divide-line">{d.users.map((u) => <tr key={u.id} className={u.isActive ? "" : "opacity-50"}><td className="p-2">{u.fullName}<div className="text-xs text-muted">{u.email}</div></td>{MODULES.map((m) => <td key={m}><StateBadge state={u.effective?.[m]?.state} /></td>)}<td className="p-2">{u.role !== "owner" && u.isActive && <Button size="sm" variant="ghost" onClick={() => setEdit(u)} data-testid={`platform-user-${u.id}`}>הגדרות</Button>}</td></tr>)}</tbody></table>
        </Panel>
        <details className="text-xs"><summary className="cursor-pointer text-muted">היסטוריית שינויי חבילה והרשאות ({d.audit.length})</summary><ul className="mt-1 space-y-0.5">{d.audit.map((a) => <li key={a.id}>{new Date(a.createdAt).toLocaleString("he-IL")} · {a.action}</li>)}</ul></details>
      </div>
      {edit && <UserAccessEditor user={edit} packageModules={d.entitlement.modules} actor={null} endpoint={`/api/platform/businesses/${id}/users/${edit.id}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
      {target && <ChangePreview businessId={id} target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); void load(); }} />}
    </Modal>
  );
}

/** Preview → explicit apply. Seat overflow requires choosing who keeps access; live calls are never cut. */
function ChangePreview({ businessId, target, onClose, onDone }: { businessId: string; target: Target; onClose: () => void; onDone: () => void }) {
  const [imp, setImp] = useState<Impact | null>(null); const [keep, setKeep] = useState<Record<string, string[]>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<{ impact: Impact }>(`/api/platform/businesses/${businessId}/impact`, target).then((r) => setImp(r.impact)).catch((e) => { toast.error((e as Error).message); onClose(); }); }, [businessId, target, onClose]);
  async function apply() { setBusy(true); try { await api.post(`/api/platform/businesses/${businessId}/apply`, { target, keep }); toast.success("השינוי הוחל"); onDone(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  const overflowOk = imp ? Object.entries(imp.seatOverflow).every(([m, o]) => (keep[m]?.length ?? -1) >= 0 && (keep[m]?.length ?? 0) <= o.seats && keep[m] !== undefined) : false;
  const nothing = imp && !imp.modulesRemoved.length && !Object.keys(imp.seatOverflow).length;
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title="השפעת השינוי" footer={<><Button variant="ghost" onClick={onClose}>ביטול</Button><Button onClick={apply} loading={busy} disabled={!imp || !overflowOk} data-testid="platform-apply">אשר והחל</Button></>}>
      {!imp ? <Spinner /> : <div className="space-y-2 text-sm" data-testid="platform-impact">
        {nothing && <p className="text-good">אין משתמשים או פעולות שייפגעו. מודולים שנוספים לא ייפתחו אוטומטית למשתמשים – מנהל העסק יקצה אותם.</p>}
        {imp.modulesRemoved.map((m) => <div key={m} className="rounded-md border border-warn/40 bg-warn/10 p-2"><b>{MODULE_LABEL[m]} יוסר</b> · משתמשים שיאבדו גישה: {imp.usersLosing[m]?.map((u) => u.fullName).join(", ") || "אין"}</div>)}
        {imp.campaigns.length > 0 && <p>קמפיינים שייעצרו (יושהו, לא יימחקו): {imp.campaigns.map((c) => `${c.name} (${c.channel}, ${c.status})`).join(", ")}</p>}
        {imp.journeys.length > 0 && <p>מסעות לקוח ששלבי השליחה שלהם בערוץ שהוסר ידלגו: {imp.journeys.map((j) => j.name).join(", ")}</p>}
        {imp.inboxAutomations > 0 && <p>{imp.inboxAutomations} אוטומציות תיבת וואטסאפ לא יבוצעו.</p>}
        {imp.serviceAgent && <p>נציג השירות ב-AI בוואטסאפ יפסיק לענות.</p>}
        {(imp.dialerSessions > 0 || imp.dialLists > 0) && <p>חייגן: {imp.dialerSessions} סשנים פעילים, {imp.dialLists} קמפיינים. שיחות פעילות לא ינותקו – חיוגים חדשים ייחסמו.</p>}
        {Object.entries(imp.seatOverflow).map(([m, o]) => <div key={m} className="rounded-md border border-bad/40 bg-bad/10 p-2" data-testid={`platform-overflow-${m}`}><b>חריגה ממכסת המושבים ב{MODULE_LABEL[m as ModuleKey]}:</b> {o.holders.length} משתמשים, {o.seats} מושבים. בחרו מי נשאר עם גישה ({keep[m]?.length ?? 0}/{o.seats}):
          <div className="flex flex-wrap gap-2 mt-1">{o.holders.map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" checked={keep[m]?.includes(u.id) ?? false} onChange={(e) => setKeep({ ...keep, [m]: e.target.checked ? [...(keep[m] ?? []), u.id] : (keep[m] ?? []).filter((x) => x !== u.id) })} data-testid={`platform-keep-${m}-${u.id}`} />{u.fullName}</label>)}</div></div>)}
        <p className="text-xs text-muted">הנתונים נשמרים תמיד. פעולות עתידיות שאינן מורשות נבדקות מחדש לפני ביצוע ונעצרות בבטחה, בלי שליחה כפולה.</p>
      </div>}
    </Modal>
  );
}

// ─── packages ────────────────────────────────────────────────────────────────────────────────────────────────────
type Spec = { name: string; description: string; modules: Record<ModuleKey, { included: boolean; seats: string }>; quotas: Record<string, string> };
const emptySpec = (): Spec => ({ name: "", description: "", modules: Object.fromEntries(MODULES.map((m) => [m, { included: false, seats: "" }])) as Spec["modules"], quotas: {} });

function Plans() {
  const [plans, setPlans] = useState<Plan[] | null>(null); const [edit, setEdit] = useState<{ planId?: string; spec: Spec } | null>(null); const [applying, setApplying] = useState<{ plan: Plan; versionId: string } | null>(null);
  const load = useCallback(() => api.get<{ items: Plan[] }>("/api/platform/plans").then((r) => setPlans(r.items)).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  function editPlan(p: Plan) {
    const v = p.versions[0];
    setEdit({ planId: p.id, spec: { name: p.name, description: p.description ?? "", modules: Object.fromEntries(MODULES.map((m) => [m, { included: Boolean(v?.modules[m]?.included), seats: v?.modules[m]?.seats === null || v?.modules[m]?.seats === undefined ? "" : String(v.modules[m].seats) }])) as Spec["modules"], quotas: Object.fromEntries(Object.entries(v?.quotas ?? {}).map(([k, x]) => [k, x === null ? "" : String(x)])) } });
  }
  async function save() {
    if (!edit) return;
    const body = { name: edit.spec.name, description: edit.spec.description || null, modules: Object.fromEntries(MODULES.map((m) => [m, { included: edit.spec.modules[m].included, seats: edit.spec.modules[m].seats === "" ? null : Number(edit.spec.modules[m].seats) }])), quotas: Object.fromEntries(Object.entries(edit.spec.quotas).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)])) };
    try { if (edit.planId) await api.put(`/api/platform/plans/${edit.planId}`, body); else await api.post("/api/platform/plans", body); toast.success(edit.planId ? "נוצרה גרסה חדשה – עסקים קיימים לא השתנו" : "החבילה נוצרה"); setEdit(null); void load(); }
    catch (e) { toast.error((e as Error).message); }
  }
  if (!plans) return <Spinner />;
  return (
    <div className="space-y-3" data-testid="platform-plans">
      <Button size="sm" onClick={() => setEdit({ spec: emptySpec() })} data-testid="platform-new-plan">+ חבילה חדשה</Button>
      {plans.map((p) => <Panel key={p.id} title={`${p.name} · גרסה נוכחית ${p.currentVersion}`} actions={<Button size="sm" variant="secondary" onClick={() => editPlan(p)}>עריכה (גרסה חדשה)</Button>}>
        {p.description && <p className="text-xs text-muted mb-2">{p.description}</p>}
        <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">גרסה</th>{MODULES.map((m) => <th key={m} className="text-start">{MODULE_LABEL[m]}</th>)}<th className="text-start">מכסות</th><th className="text-start">עסקים</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{p.versions.map((v) => <tr key={v.id}><td className="py-1">v{v.version}</td>{MODULES.map((m) => <td key={m}>{v.modules[m]?.included ? `✓ ${v.modules[m].seats === null ? "∞" : v.modules[m].seats}` : "—"}</td>)}<td>{Object.entries(v.quotas ?? {}).map(([k, x]) => `${QUOTA_LABEL[k as keyof typeof QUOTA_LABEL] ?? k}: ${x ?? "∞"}`).join(" · ") || "—"}</td><td>{v.businesses}</td>
            <td>{v.version === p.currentVersion && p.versions.some((o) => o.version !== v.version && o.businesses > 0) && <Button size="sm" variant="ghost" onClick={() => setApplying({ plan: p, versionId: v.id })}>החל על עסקים בגרסאות קודמות</Button>}</td></tr>)}</tbody></table>
      </Panel>)}
      {edit && <Modal open onClose={() => setEdit(null)} width="max-w-2xl" title={edit.planId ? "עריכת חבילה – תיווצר גרסה חדשה" : "חבילה חדשה"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>ביטול</Button><Button onClick={save} disabled={!edit.spec.name.trim()} data-testid="platform-plan-save">שמור</Button></>}>
        <div className="space-y-3 text-sm">
          <Input label="שם" value={edit.spec.name} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, name: e.target.value } })} data-testid="platform-plan-name" />
          <Textarea label="תיאור" rows={2} value={edit.spec.description} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, description: e.target.value } })} />
          {MODULES.map((m) => { const x = edit.spec.modules[m]; const dep = DEPENDENCIES.find((d) => d.module === m); return <div key={m}><div className="flex items-center gap-3"><label className="flex items-center gap-1 w-44"><input type="checkbox" checked={x.included} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, modules: { ...edit.spec.modules, [m]: { ...x, included: e.target.checked } } } })} data-testid={`platform-plan-${m}`} />{MODULE_LABEL[m]}</label>{x.included && <Input aria-label="מושבים" placeholder="מושבים (ריק = ללא הגבלה)" type="number" value={x.seats} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, modules: { ...edit.spec.modules, [m]: { ...x, seats: e.target.value } } } })} className="w-56" />}</div>{x.included && dep && <p className="text-xs text-muted ps-6">{dep.note}</p>}</div>; })}
          <div className="grid md:grid-cols-2 gap-2">{QUOTA_METRICS.map((q) => <Input key={q} label={`${QUOTA_LABEL[q]} (ריק = ללא הגבלה)`} type="number" value={edit.spec.quotas[q] ?? ""} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, quotas: { ...edit.spec.quotas, [q]: e.target.value } } })} />)}</div>
          <p className="text-xs text-muted">מוצגות רק מכסות שהמערכת מודדת ואוכפת. עריכה יוצרת גרסה חדשה – עסקים קיימים נשארים על הגרסה שלהם עד החלה מפורשת.</p>
        </div>
      </Modal>}
      {applying && <ApplyVersion plan={applying.plan} versionId={applying.versionId} onClose={() => { setApplying(null); void load(); }} />}
    </div>
  );
}

function ApplyVersion({ plan, versionId, onClose }: { plan: Plan; versionId: string; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ businessId: string; name: string; impact: Impact; applied: boolean; needsSeatChoice: boolean }> | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<{ businesses: typeof rows }>(`/api/platform/plans/${plan.id}/apply-version`, { versionId, apply: false }).then((r) => setRows(r.businesses)).catch((e) => toast.error((e as Error).message)); }, [plan.id, versionId]);
  async function apply() { setBusy(true); try { const r = await api.post<{ businesses: NonNullable<typeof rows> }>(`/api/platform/plans/${plan.id}/apply-version`, { versionId, apply: true }); setRows(r.businesses); toast.success(`הוחל על ${r.businesses.filter((b) => b.applied).length} עסקים`); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={`החלת הגרסה החדשה של ${plan.name}`} footer={<><Button variant="ghost" onClick={onClose}>סגור</Button><Button onClick={apply} loading={busy} disabled={!rows?.length}>החל על העסקים שאין בהם חריגה</Button></>}>
      {!rows ? <Spinner /> : !rows.length ? <p className="text-sm">כל העסקים כבר בגרסה הזו.</p> : <ul className="text-sm divide-y divide-line">{rows.map((r) => <li key={r.businessId} className="py-2"><b>{r.name}</b> {r.applied ? <Badge tone="good">הוחל</Badge> : r.needsSeatChoice ? <Badge tone="bad">חריגת מושבים – יש להחיל מתוך מסך העסק ולבחור משתמשים</Badge> : <Badge>ממתין</Badge>}
        <div className="text-xs text-muted">{r.impact.modulesRemoved.length ? `יוסרו: ${r.impact.modulesRemoved.map((m) => MODULE_LABEL[m]).join(", ")}` : "ללא הסרת מודולים"}{r.impact.campaigns.length ? ` · ${r.impact.campaigns.length} קמפיינים יושהו` : ""}</div></li>)}</ul>}
    </Modal>
  );
}

// ─── requests / history ──────────────────────────────────────────────────────────────────────────────────────────
function Requests() {
  const [rows, setRows] = useState<Array<{ id: string; action: string; businessName: string | null; createdAt: string; after: { module?: string; note?: string } | null }> | null>(null);
  useEffect(() => { api.get<{ items: NonNullable<typeof rows> }>("/api/platform/requests").then((r) => setRows(r.items)).catch((e) => toast.error((e as Error).message)); }, []);
  if (!rows) return <Spinner />;
  return <Panel bodyClassName="p-0"><table className="w-full text-sm" data-testid="platform-requests"><tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id}><td className="p-2 text-xs text-muted whitespace-nowrap">{new Date(r.createdAt).toLocaleString("he-IL")}</td><td>{r.businessName ?? "פלטפורמה"}</td><td>{r.action === "upgrade_requested" ? <Badge tone="info">בקשת שדרוג</Badge> : r.action}</td><td className="text-xs">{r.after?.module ? MODULE_LABEL[r.after.module as ModuleKey] : ""} {r.after?.note ?? ""}</td></tr>)}</tbody></table></Panel>;
}
