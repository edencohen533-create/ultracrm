"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Phone, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";
import { CoachAdmin } from "@/components/coach/CoachAdmin";

type Tab = "business" | "users" | "connections" | "plan" | "automations" | "marketing" | "suppressions" | "general" | "priority" | "safety" | "numbers" | "scripts" | "dnc" | "history" | "coach";
interface Prio { callbackDue: number; priority: number; newLeadPerHour: number; newLeadMaxHours: number; agingPerHour: number; agingMaxHours: number; attemptPenalty: number; ownerMatch: number; sourceWeights: Record<string, number>; interestedBefore: number }
interface Automations { newLeadTaskMinutes: number; followUpTaskOutcomes: string[]; followUpTaskHours: number; followUpMessage: { enabled: boolean; templateId: string | null; outcomes: string[]; variables: Record<string, string> } }
interface Settings { automations: Automations; wrapUpSeconds: number; autoDialCountdownSeconds: number; maxAttempts: number; retryIntervalMinutes: number; busyRetryMinutes: number; technicalFailureRetryMinutes: number; lockTtlSeconds: number; ringTimeoutSeconds: number; recordingEnabled: boolean; recordingAnnouncement: string; recordingRetentionDays: number; amdEnabled: boolean; stickyOwner: boolean; removeFromOtherListsOnSale: boolean; dialingPaused: boolean; allowedCountries: string[]; maxDialsPerMinute: number; dialWindow: { start: string; end: string; days: number[] }; prioritization: Prio; inbound: { preferOwner: boolean; createCallbackTask: boolean; respectDialWindow: boolean } }
interface Tel { provider: string; simulation: boolean; requested: string; telnyx: { configured: boolean; missing: string[] } }

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("business");
  const [me, setMe] = useState<{ user: { role: string }; modules: Record<string, boolean> } | null>(null);
  useEffect(() => { api.get<{ user: { role: string }; modules: Record<string, boolean> }>("/api/auth/me").then(setMe).catch(() => undefined); }, []);
  const isAdmin = me?.user.role === "owner";
  const modules = me?.modules ?? { crm: true, messaging: true, telephony: true };
  const groups: Array<{ title: string; tabs: Array<[Tab, string]>; show: boolean }> = [
    { title: "עסק", tabs: [["business", "פרטי העסק"], ["users", "משתמשים וצוותים"], ["connections", "חיבורים"], ["plan", "חבילה ומכסות"], ["automations", "אוטומציות"], ["marketing", "דיוור"], ["suppressions", "הסרות מדיוור"], ["history", "היסטוריית שינויים"]], show: true },
    { title: "טלפוניה", tabs: [["general", "חייגן"], ["priority", "תעדוף לידים"], ["safety", "בטיחות ושיחות נכנסות"], ["numbers", "מספרים יוצאים"], ["scripts", "תסריטים"], ["dnc", "לא ליצור קשר"], ["coach", "מאמן AI"]], show: modules.telephony },
  ];
  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <h1 className="text-lg font-semibold">הגדרות</h1>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line">
        {groups.filter((g) => g.show).map((g) => (
          <div key={g.title} className="flex items-end gap-1">
            <span className="text-[10px] text-muted/70 pb-3 pe-1">{g.title}</span>
            {g.tabs.map(([k, v]) => <button key={k} onClick={() => setTab(k)} className={cx("h-10 px-3 text-sm border-b-2 -mb-px whitespace-nowrap", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{v}</button>)}
          </div>
        ))}
      </div>
      {tab === "business" && <><BusinessTab isAdmin={isAdmin} /><AccountPanel /></>}
      {tab === "connections" && <ConnectionsTab modules={modules} />}
      {tab === "plan" && <PlanTab isAdmin={isAdmin} />}
      {tab === "automations" && <AutomationsTab isAdmin={isAdmin} messaging={modules.messaging} />}
      {tab === "marketing" && <MarketingTab isAdmin={isAdmin} />}
      {tab === "suppressions" && <SuppressionsTab />}
      {tab === "general" && <GeneralTab isAdmin={isAdmin} />}
      {tab === "priority" && <PriorityTab isAdmin={isAdmin} />}
      {tab === "safety" && <SafetyTab isAdmin={isAdmin} />}
      {tab === "history" && <HistoryTab />}
      {tab === "coach" && <CoachAdmin isAdmin={isAdmin} />}
      {tab === "numbers" && <NumbersTab isAdmin={isAdmin} />}
      {tab === "users" && <UsersTab isAdmin={isAdmin} />}
      {tab === "scripts" && <ScriptsTab />}
      {tab === "dnc" && <DncTab />}
    </div>
  );
}

function GeneralTab({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  useEffect(() => { api.get<{ business: { name: string }; settings: Settings }>("/api/settings").then((r) => { setS(r.settings); setName(r.business.name); }).catch((e) => toast.error(e.message)); }, []);
  if (!s) return <Spinner />;
  const num = (k: keyof Settings, label: string, hint?: string) => <Input label={label} hint={hint} type="number" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} disabled={!isAdmin} />;
  const days = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
  async function save() {
    try { await api.patch("/api/settings", { name, settings: s }); toast.success("ההגדרות נשמרו"); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Panel title="הגדרות חייגן" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>{name ? null : null}
      <div className="grid md:grid-cols-3 gap-3">
        {num("autoDialCountdownSeconds", "ספירה לאחור בין שיחות (שנ׳)", "בתותח שיחות, אחרי שמירת תוצאה")}
        {num("wrapUpSeconds", "זמן תיעוד (שנ׳)", "משפיע על הארכת נעילת הליד אחרי שיחה")}
        {num("maxAttempts", "מקס׳ ניסיונות לליד")}
        {num("retryIntervalMinutes", "מרווח לניסיון חוזר – אין מענה (דק׳)")}
        {num("busyRetryMinutes", "מרווח לניסיון חוזר – תפוס (דק׳)")}
        {num("ringTimeoutSeconds", "זמן צלצול מקסימלי (שנ׳)")}
        {num("lockTtlSeconds", "תוקף נעילת ליד (שנ׳)", "מתחדש אוטומטית כל 15 שנ׳ כל עוד הנציג מחובר")}
        {num("technicalFailureRetryMinutes", "כשל טכני – חזרה לתור אחרי (דק׳)", "כשל ספק לפני צלצול: הניסיון לא נספר, אין צורך בתיעוד")}
        {num("recordingRetentionDays", "שמירת הקלטות (ימים, 0 = לתמיד)", "הקלטות ישנות יותר נמחקות אצל הספק בעבודת רקע יומית")}
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.amdEnabled} disabled={!isAdmin} onChange={(e) => setS({ ...s, amdEnabled: e.target.checked })} /> זיהוי תא קולי (Telnyx AMD) – מוצג לנציג כהצעה בלבד, לעולם לא מנתק אוטומטית</label>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.stickyOwner} disabled={!isAdmin} onChange={(e) => setS({ ...s, stickyOwner: e.target.checked })} /> ליד שלא נענה נשאר אצל הנציג שטיפל בו (עד שעה איחור, אחר כך לכולם)</label>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.removeFromOtherListsOnSale} disabled={!isAdmin} onChange={(e) => setS({ ...s, removeFromOtherListsOnSale: e.target.checked })} /> מכירה סוגרת את הליד בכל הרשימות האחרות של העסק</label>
        <div className="md:col-span-3">
          <span className="block text-xs text-muted mb-1">חלון חיוג ברירת מחדל</span>
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" value={s.dialWindow.start} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialWindow: { ...s.dialWindow, start: e.target.value } })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
            <span className="text-muted">עד</span>
            <input type="time" value={s.dialWindow.end} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialWindow: { ...s.dialWindow, end: e.target.value } })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
            <div className="flex gap-1 ms-2">{days.map((d, i) => <button key={i} disabled={!isAdmin} onClick={() => setS({ ...s, dialWindow: { ...s.dialWindow, days: s.dialWindow.days.includes(i) ? s.dialWindow.days.filter((x) => x !== i) : [...s.dialWindow.days, i] } })} className={cx("w-8 h-8 rounded-md text-xs", s.dialWindow.days.includes(i) ? "bg-accent text-white" : "bg-white/6 text-muted")}>{d}</button>)}</div>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.recordingEnabled} disabled={!isAdmin} onChange={(e) => setS({ ...s, recordingEnabled: e.target.checked })} /> הקלטת שיחות (מרגע המענה, דו-ערוצי)</label>
        <Textarea label="מדיניות הודעה למתקשר על הקלטה" rows={2} value={s.recordingAnnouncement} disabled={!isAdmin} onChange={(e) => setS({ ...s, recordingAnnouncement: e.target.value })} className="md:col-span-3" />
      </div>
    </Panel>
  );
}

function NumbersTab({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Array<{ id: string; e164: string; label: string | null; isDefault: boolean; isActive: boolean }>>([]);
  const [phone, setPhone] = useState(""); const [label, setLabel] = useState("");
  const load = useCallback(() => api.get<typeof items>("/api/phone-numbers").then(setItems).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function add() { try { await api.post("/api/phone-numbers", { phone, label }); setPhone(""); setLabel(""); load(); } catch (e) { toast.error((e as Error).message); } }
  async function patch(id: string, body: object) { try { await api.patch(`/api/phone-numbers/${id}`, body); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="מספרים מורשים לחיוג יוצא">
      <a href="/numbers" className="block underline mb-3 text-sm">לניהול מספרים: מוניטין, רכישה, רוטציה ומדיניות לקמפיין →</a>
      <p className="text-xs text-muted mb-3">רק מספרים ברשימה זו יוצגו ללקוח כמזהה מתקשר. ב-Telnyx המספר חייב להיות משויך לחשבון ול-Call Control App.</p>
      {isAdmin && <div className="flex gap-2 mb-4"><Input placeholder="+972…" value={phone} onChange={(e) => setPhone(e.target.value)} ltr /><Input placeholder="תווית" value={label} onChange={(e) => setLabel(e.target.value)} /><Button onClick={add} disabled={!phone}>הוסף</Button></div>}
      <ul className="divide-y divide-line">
        {items.map((n) => (
          <li key={n.id} className="flex items-center gap-3 py-2 text-sm">
            <Phone value={formatPhone(n.e164)} className="font-medium" /><span className="text-muted">{n.label}</span>
            {n.isDefault && <Badge tone="accent">ברירת מחדל</Badge>}{!n.isActive && <Badge tone="bad">לא פעיל</Badge>}
            {isAdmin && <div className="ms-auto flex gap-2">{!n.isDefault && n.isActive && <Button size="sm" variant="ghost" onClick={() => patch(n.id, { isDefault: true })}>קבע כברירת מחדל</Button>}<Button size="sm" variant="ghost" onClick={() => patch(n.id, { isActive: !n.isActive })}>{n.isActive ? "השבת" : "הפעל"}</Button></div>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function UsersTab({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Array<{ id: string; fullName: string; email: string; role: string; isActive: boolean; team: { name: string } | null }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", role: "agent", teamId: "" });
  const load = useCallback(() => api.get<{ items: typeof items; teams: typeof teams }>("/api/users").then((r) => { setItems(r.items); setTeams(r.teams); }).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function create() { try { await api.post("/api/users", { ...form, password: form.password || undefined, teamId: form.teamId || null }); setOpen(false); setForm({ fullName: "", email: "", password: "", role: "agent", teamId: "" }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function patch(id: string, body: object) { try { await api.patch(`/api/users/${id}`, body); load(); } catch (e) { toast.error((e as Error).message); } }
  const roleLabel: Record<string, string> = { owner: "בעלים", manager: "מנהל", agent: "נציג" };
  const [teamName, setTeamName] = useState("");
  async function createTeam() { try { const r = await fetch("/api/settings/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: teamName }) }); if (!r.ok) throw new Error((await r.json()).error ?? "שגיאה"); setTeamName(""); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="משתמשים" actions={isAdmin && <Button size="sm" onClick={() => setOpen(true)}>+ משתמש</Button>}>
      <p className="text-xs text-muted mb-3">כניסה אחת לכל העסקים: משתמש עם אימייל קיים במערכת מצורף לעסק זה עם הסיסמה הקיימת שלו. תפקידים: בעלים (הכול), מנהל (ניהול צוותים, קמפיינים והגדרות תפעול), נציג.</p>
      <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8 font-medium">שם</th><th className="text-start font-medium">אימייל</th><th className="text-start font-medium">תפקיד</th><th className="text-start font-medium">צוות</th><th></th></tr></thead>
        <tbody className="divide-y divide-line">{items.map((u) => <tr key={u.id}><td className="h-10">{u.fullName}{!u.isActive && <Badge tone="bad" className="ms-2">מושבת</Badge>}</td><td className="ltr text-start text-muted">{u.email}</td><td>{roleLabel[u.role]}</td><td className="text-muted">{u.team?.name ?? "—"}</td><td className="text-end whitespace-nowrap">{isAdmin && <><Select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })} className="inline-block w-28 h-8 text-xs me-2"><option value="agent">נציג</option><option value="manager">מנהל</option><option value="owner">בעלים</option></Select><Select value={u.team ? teams.find((t) => t.name === u.team?.name)?.id ?? "" : ""} onChange={(e) => patch(u.id, { teamId: e.target.value || null })} className="inline-block w-32 h-8 text-xs me-2"><option value="">ללא צוות</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select><Button size="sm" variant="ghost" onClick={() => patch(u.id, { isActive: !u.isActive })}>{u.isActive ? "השבת" : "הפעל"}</Button></>}</td></tr>)}</tbody></table>
      {isAdmin && <div className="flex gap-2 mt-4 items-end"><Input label="צוות חדש" value={teamName} onChange={(e) => setTeamName(e.target.value)} className="max-w-xs" /><Button variant="secondary" onClick={createTeam} disabled={!teamName.trim()}>צור צוות</Button></div>}
      <Modal open={open} onClose={() => setOpen(false)} title="משתמש חדש" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.fullName || !form.email || (form.password.length > 0 && form.password.length < 8)}>צור</Button></>}>
        <div className="space-y-2">
          <Input label="שם מלא" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <Input label="סיסמה (8+ תווים; נדרשת רק לחשבון חדש)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} ltr />
          <Select label="תפקיד" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="agent">נציג</option><option value="manager">מנהל</option><option value="owner">בעלים</option></Select>
          <Select label="צוות" value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}><option value="">ללא</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        </div>
      </Modal>
    </Panel>
  );
}

function ScriptsTab() {
  const [items, setItems] = useState<Array<{ id: string; title: string; body: string; isDefault: boolean }>>([]);
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string; isDefault: boolean } | null>(null);
  const load = useCallback(() => api.get<typeof items>("/api/scripts").then(setItems).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function save() {
    if (!edit) return;
    try { if (edit.id) await api.patch(`/api/scripts/${edit.id}`, edit); else await api.post("/api/scripts", edit); setEdit(null); load(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Panel title="תסריטי שיחה" actions={<Button size="sm" onClick={() => setEdit({ title: "", body: "", isDefault: items.length === 0 })}>+ תסריט</Button>}>
      <ul className="divide-y divide-line">{items.map((s) => <li key={s.id} className="flex items-center gap-3 py-2"><span className="font-medium">{s.title}</span>{s.isDefault && <Badge tone="accent">ברירת מחדל</Badge>}<Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEdit(s)}>עריכה</Button></li>)}</ul>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={edit?.id ? "עריכת תסריט" : "תסריט חדש"} width="max-w-2xl" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>ביטול</Button><Button onClick={save} disabled={!edit?.title}>שמור</Button></>}>
        {edit && <div className="space-y-2"><Input label="כותרת" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /><Textarea label="תוכן" rows={12} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> ברירת מחדל לעסק</label></div>}
      </Modal>
    </Panel>
  );
}

function DncTab() {
  const [items, setItems] = useState<Array<{ id: string; phoneE164: string; reason: string | null; createdAt: string; createdBy: { fullName: string } | null }>>([]);
  const [q, setQ] = useState(""); const [phone, setPhone] = useState(""); const [reason, setReason] = useState("");
  const load = useCallback(() => api.get<{ items: typeof items }>(`/api/dnc${qs({ q })}`).then((r) => setItems(r.items)).catch((e) => toast.error(e.message)), [q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  async function add() { try { await api.post("/api/dnc", { phone, reason }); setPhone(""); setReason(""); load(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(p: string) { try { await api.delete("/api/dnc", { phone: p }); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="רשימת לא ליצור קשר (DNC)">
      <p className="text-xs text-muted mb-3">מספרים ברשימה זו נחסמים בכל רשימות החיוג של העסק, והחסימה נבדקת שוב ברגע החיוג.</p>
      <div className="flex gap-2 mb-3"><Input placeholder="מספר" value={phone} onChange={(e) => setPhone(e.target.value)} ltr /><Input placeholder="סיבה" value={reason} onChange={(e) => setReason(e.target.value)} /><Button onClick={add} disabled={!phone}>חסום</Button></div>
      <Input placeholder="חיפוש" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <ul className="divide-y divide-line">{items.map((d) => <li key={d.id} className="flex items-center gap-3 py-2 text-sm"><Phone value={formatPhone(d.phoneE164)} className="font-medium" /><span className="text-muted">{d.reason}</span><span className="text-muted text-xs ms-auto">{formatDateTime(d.createdAt)} · {d.createdBy?.fullName ?? "מערכת"}</span><Button size="sm" variant="ghost" onClick={() => remove(d.phoneE164)}>הסר</Button></li>)}</ul>
    </Panel>
  );
}

function TelephonyTab() {
  const [t, setT] = useState<Tel | null>(null);
  useEffect(() => { api.get<Tel>("/api/telephony/status").then(setT).catch((e) => toast.error(e.message)); }, []);
  if (!t) return <Spinner />;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Panel title="חיבור טלפוניה (Telnyx)">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm">מצב נוכחי:</span>
        {t.simulation ? <Badge tone="warn">מצב הדמיה – אין שיחות אמיתיות</Badge> : <Badge tone="good">Telnyx פעיל</Badge>}
        {t.requested === "telnyx" && !t.telnyx.configured && <Badge tone="bad">חסרים: {t.telnyx.missing.join(", ")}</Badge>}
      </div>
      <ol className="text-sm space-y-2 list-decimal ps-5 text-text/90">
        <li>ב-Mission Control צור <b>Call Control Application</b> (Voice API) והגדר Webhook URL: <code className="ltr bg-black/40 px-1 rounded text-xs">{origin}/api/webhooks/telnyx</code> (POST). העתק את ה-ID ל-<code className="ltr text-xs">TELNYX_CALL_CONTROL_APP_ID</code>.</li>
        <li>צור <b>SIP Credential Connection</b> (לרישום הדפדפנים ב-WebRTC). העתק את ה-ID ל-<code className="ltr text-xs">TELNYX_CREDENTIAL_CONNECTION_ID</code>. המערכת יוצרת credential לכל נציג אוטומטית.</li>
        <li>שייך <b>Outbound Voice Profile</b> לשני החיבורים, ושייך את מספרי הטלפון של העסק ל-Call Control App.</li>
        <li>העתק את <b>API Key</b> ל-<code className="ltr text-xs">TELNYX_API_KEY</code> ואת <b>Public Key</b> (Keys &amp; Credentials) ל-<code className="ltr text-xs">TELNYX_PUBLIC_KEY</code> לאימות חתימות Webhook.</li>
        <li>הגדר <code className="ltr text-xs">TELEPHONY_PROVIDER=telnyx</code> ופרוס מחדש. הוסף את המספרים היוצאים בלשונית &quot;מספרים יוצאים&quot; בפורמט E.164.</li>
      </ol>
      <p className="text-xs text-muted mt-4">זרימת שיחה: השרת מחייג קודם לדפדפן הנציג (SIP leg), ורק אחרי שהדפדפן עונה מחייג ללקוח ומגשר בין השניים כשהלקוח עונה. מצב &quot;נענה&quot; מגיע אך ורק מאירועי Telnyx החתומים.</p>
    </Panel>
  );
}

function PriorityTab({ isAdmin }: { isAdmin: boolean }) {
  const [p, setP] = useState<Prio | null>(null);
  const [src, setSrc] = useState(""); const [w, setW] = useState("10");
  useEffect(() => { api.get<{ settings: Settings }>("/api/settings").then((r) => setP(r.settings.prioritization)).catch((e) => toast.error(e.message)); }, []);
  if (!p) return <Spinner />;
  const num = (k: keyof Prio, label: string, hint: string) => <Input label={label} hint={hint} type="number" step="0.25" value={String(p[k])} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} disabled={!isAdmin} />;
  async function save() { try { await api.patch("/api/settings", { settings: { prioritization: p } }); toast.success("כללי התעדוף נשמרו"); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="תעדוף לידים (שקוף)" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>
      <p className="text-xs text-muted mb-3">ציון = סכום הגורמים × המשקלים. הליד עם הציון הגבוה ביותר נמסר ראשון, והנציג רואה הסבר קצר (&quot;למה עכשיו&quot;). גורם ההזדקנות מבטיח שלידים בעדיפות נמוכה לא נשארים לנצח.</p>
      <div className="grid md:grid-cols-3 gap-3">
        {num("callbackDue", "חזרה שהגיע מועדה", "בונוס חד-פעמי לליד במצב חזרה")}
        {num("priority", "עדיפות עסקית (לנקודה)", "מוכפל בעדיפות הליד 0–100")}
        {num("newLeadPerHour", "ליד חדש – לשעה מאז הכניסה", "רק ללידים שטרם חויגו")}
        {num("newLeadMaxHours", "תקרת שעות לליד חדש", "")}
        {num("agingPerHour", "הזדקנות – לשעה מאז הניסיון האחרון", "מונע הרעבה של לידים")}
        {num("agingMaxHours", "תקרת שעות הזדקנות", "")}
        {num("attemptPenalty", "קנס לכל ניסיון קודם", "")}
        {num("ownerMatch", "הליד שייך לנציג המושך", "")}
        {num("interestedBefore", "הביע עניין בשיחה קודמת", "")}
      </div>
      <div className="mt-4">
        <span className="block text-xs text-muted mb-1">משקל לפי מקור</span>
        <div className="flex flex-wrap gap-2 mb-2">{Object.entries(p.sourceWeights).map(([k, v]) => <Badge key={k} tone="accent">{k}: {v} {isAdmin && <button onClick={() => { const sw = { ...p.sourceWeights }; delete sw[k]; setP({ ...p, sourceWeights: sw }); }} className="ms-1">×</button>}</Badge>)}</div>
        {isAdmin && <div className="flex gap-2"><Input placeholder="מקור (למשל facebook)" value={src} onChange={(e) => setSrc(e.target.value)} /><Input type="number" value={w} onChange={(e) => setW(e.target.value)} className="w-24" /><Button variant="secondary" onClick={() => { if (src.trim()) { setP({ ...p, sourceWeights: { ...p.sourceWeights, [src.trim()]: Number(w) } }); setSrc(""); } }}>הוסף</Button></div>}
      </div>
    </Panel>
  );
}

function SafetyTab({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [country, setCountry] = useState("");
  useEffect(() => { api.get<{ settings: Settings }>("/api/settings").then((r) => setS(r.settings)).catch((e) => toast.error(e.message)); }, []);
  if (!s) return <Spinner />;
  async function save() { if (!s) return; try { await api.patch("/api/settings", { settings: { dialingPaused: s.dialingPaused, allowedCountries: s.allowedCountries, maxDialsPerMinute: s.maxDialsPerMinute, inbound: s.inbound } }); toast.success("נשמר"); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="בטיחות, מגבלות ושיחות נכנסות" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>
      <div className="space-y-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.dialingPaused} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialingPaused: e.target.checked })} /> <b>עצירת חיוגים חדשים לכל העסק</b> (kill switch – שיחות פעילות לא נותקות)</label>
        <Input label="מגבלת חיוגים לנציג לדקה (0 = ללא)" type="number" value={String(s.maxDialsPerMinute)} disabled={!isAdmin} onChange={(e) => setS({ ...s, maxDialsPerMinute: Number(e.target.value) })} className="w-48" />
        <div>
          <span className="block text-xs text-muted mb-1">מדינות יעד מותרות (ריק = הכול)</span>
          <div className="flex flex-wrap gap-2 mb-2">{s.allowedCountries.map((c) => <Badge key={c} tone="accent">{c} {isAdmin && <button onClick={() => setS({ ...s, allowedCountries: s.allowedCountries.filter((x) => x !== c) })} className="ms-1">×</button>}</Badge>)}</div>
          {isAdmin && <div className="flex gap-2"><Input placeholder="IL" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} className="w-24" ltr /><Button variant="secondary" onClick={() => { if (/^[A-Z]{2}$/.test(country) && !s.allowedCountries.includes(country)) { setS({ ...s, allowedCountries: [...s.allowedCountries, country] }); setCountry(""); } }}>הוסף</Button></div>}
        </div>
        <div className="border-t border-line pt-3 space-y-2">
          <p className="font-medium">שיחות נכנסות</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.preferOwner} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, preferOwner: e.target.checked } })} /> לנתב קודם לנציג האחראי על הלקוח (אם זמין)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.createCallbackTask} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, createCallbackTask: e.target.checked } })} /> ליצור משימת חזרה לשיחה נכנסת שלא נענתה</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.respectDialWindow} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, respectDialWindow: e.target.checked } })} /> מחוץ לשעות הפעילות: לא לנתב לנציגים (נרשם כלא נענה)</label>
          <p className="text-xs text-muted">ללא נציג זמין השיחה מנותקת ונרשמת. תורים, IVR ותא קולי אינם ממומשים (דורשים הגדרת Telnyx Queues / TeXML והחלטת מוצר).</p>
        </div>
      </div>
    </Panel>
  );
}

function HistoryTab() {
  const [items, setItems] = useState<Array<{ id: string; action: string; entityType: string; entityId: string; createdAt: string; payload: Record<string, unknown> | null; actor: { fullName: string } | null }>>([]);
  useEffect(() => { api.get<typeof items>("/api/settings/history").then(setItems).catch((e) => toast.error(e.message)); }, []);
  return (
    <Panel title="היסטוריית שינויים ואוטומציות">
      <ul className="divide-y divide-line text-sm">
        {items.map((i) => (
          <li key={i.id} className="py-2">
            <div className="flex items-center gap-2"><Badge tone={i.entityType === "automation" ? "info" : "neutral"}>{i.action}</Badge><span className="text-muted text-xs">{formatDateTime(i.createdAt)} · {i.actor?.fullName ?? "מערכת"}</span></div>
            {i.payload && <pre className="text-[11px] text-muted mt-1 whitespace-pre-wrap ltr text-left max-h-24 overflow-auto">{JSON.stringify(i.payload, null, 1).slice(0, 600)}</pre>}
          </li>
        ))}
        {items.length === 0 && <li className="py-6 text-center text-muted">אין רשומות</li>}
      </ul>
    </Panel>
  );
}


function AccountPanel() {
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [busy, setBusy] = useState(false);
  async function change() {
    if (next.length < 8) { toast.error("סיסמה חדשה: לפחות 8 תווים"); return; }
    setBusy(true);
    try { await api.post("/api/auth/password", { currentPassword: current, newPassword: next }); toast.success("הסיסמה שונתה. חיבורים אחרים של החשבון נותקו"); setCurrent(""); setNext(""); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title="החשבון שלי – שינוי סיסמה" actions={<Button size="sm" disabled={busy || !current || !next} onClick={change} data-testid="account-change-password">שנה סיסמה</Button>}>
      <p className="text-xs text-muted mb-2">הסיסמה שייכת לחשבון הכניסה שלך בכל העסקים. שינוי מנתק כל חיבור אחר של החשבון.</p>
      <div className="grid md:grid-cols-2 gap-3">
        <Input label="סיסמה נוכחית" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input label="סיסמה חדשה (8+ תווים)" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
    </Panel>
  );
}

function BusinessTab({ isAdmin }: { isAdmin: boolean }) {
  const [b, setB] = useState<{ name: string; timezone: string } | null>(null);
  useEffect(() => { api.get<{ business: { name: string; timezone: string } }>("/api/settings").then((r) => setB(r.business)).catch((e) => toast.error(e.message)); }, []);
  if (!b) return <Spinner />;
  async function save() { if (!b) return; try { await api.patch("/api/settings", { name: b.name, timezone: b.timezone }); toast.success("נשמר"); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="פרטי העסק" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>
      <div className="grid md:grid-cols-2 gap-3">
        <Input label="שם העסק" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} disabled={!isAdmin} />
        <Select label="אזור זמן" value={b.timezone} onChange={(e) => setB({ ...b, timezone: e.target.value })} disabled={!isAdmin}>
          {["Asia/Jerusalem", "Europe/London", "Europe/Berlin", "America/New_York", "UTC"].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
        </Select>
      </div>
      <p className="text-xs text-muted mt-3">אזור הזמן קובע את חלון החיוג, גבולות היום בדוחות ואת הצגת התאריכים. כל התאריכים נשמרים ב-UTC.</p>
    </Panel>
  );
}

function ChannelStatus({ channel }: { channel: "sms" | "email" }) {
  const [c, setC] = useState<{ provider: string; status: string; sendingBlocked: boolean; simulated: boolean; lastConnectionError: string | null; domainStatus?: string | null } | null | undefined>(undefined);
  useEffect(() => { api.get<{ items: Array<{ provider: string; status: string; sendingBlocked: boolean; simulated: boolean; lastConnectionError: string | null; isActive: boolean; domainStatus?: string | null }> }>(`/api/channels/${channel}`).then((r) => setC(r.items.find((x) => x.isActive) ?? null)).catch(() => setC(null)); }, [channel]);
  if (c === undefined) return <Spinner className="w-4 h-4" />;
  if (!c) return <Badge tone="neutral">לא מחובר</Badge>;
  if (c.simulated) return <Badge tone="warn">הדמיה – אין שליחה אמיתית</Badge>;
  if (c.sendingBlocked || c.status === "error") return <Badge tone="bad">שגיאת חיבור</Badge>;
  if (c.status === "connected_not_ready") return <Badge tone="warn">{channel === "email" && c.domainStatus !== "verified" ? "מחובר – דומיין לא מאומת" : "מחובר – לא מוכן"}</Badge>;
  return <Badge tone="good">מחובר</Badge>;
}

function ConnectionsTab({ modules }: { modules: Record<string, boolean> }) {
  const [wa, setWa] = useState<{ provider: string; configured?: boolean; sendingBlocked?: boolean; phoneNumberId?: string | null; lastConnectionError?: string | null } | null>(null);
  const [waDenied, setWaDenied] = useState(false);
  useEffect(() => { fetch("/api/settings/whatsapp").then((r) => { if (r.status === 403) { setWaDenied(true); return null; } return r.ok ? r.json() : null; }).then((d) => setWa(d ?? null)).catch(() => setWaDenied(true)); }, []);
  return (
    <div className="space-y-4">
      <Panel title="ערוצי דיוור">
        <ul className="text-sm space-y-3">
          <li className="flex flex-wrap items-center gap-2">
            <b>WhatsApp (Meta Cloud API)</b>
            {!modules.messaging ? <Badge tone="neutral">המודול כבוי בחבילה</Badge> : waDenied ? <Badge tone="neutral">פרטי החיבור זמינים לבעלים בלבד</Badge> : wa ? (wa.provider === "mock" ? <Badge tone="warn">מצב הדגמה – אין שליחה אמיתית</Badge> : wa.sendingBlocked ? <Badge tone="bad">חסום – בדוק Token</Badge> : <Badge tone="good">מחובר</Badge>) : <Spinner className="w-4 h-4" />}
            {modules.messaging && <a href="/settings/whatsapp" className="text-accent underline hover:underline ms-auto text-xs">ניהול חיבור וואטסאפ →</a>}
          </li>
          <li className="flex flex-wrap items-center gap-2"><b>SMS</b>{modules.messaging ? <ChannelStatus channel="sms" /> : <Badge tone="neutral">המודול כבוי בחבילה</Badge>}{modules.messaging && <a href="/settings/sms" className="text-accent underline hover:underline ms-auto text-xs">ניהול חיבור SMS →</a>}</li>
          <li className="flex flex-wrap items-center gap-2"><b>אימייל</b>{modules.messaging ? <ChannelStatus channel="email" /> : <Badge tone="neutral">המודול כבוי בחבילה</Badge>}{modules.messaging && <a href="/settings/email" className="text-accent underline hover:underline ms-auto text-xs">ניהול חיבור אימייל →</a>}</li>
        </ul>
      </Panel>
      {modules.telephony && <TelephonyTab />}
    </div>
  );
}

function PlanTab({ isAdmin }: { isAdmin: boolean }) {
  interface PlanInfo { planKey: string | null; planName: string | null; planId: string | null; modules: Record<string, boolean>; overrides: Record<string, boolean>; usage: Record<string, { used: number; limit: number | null; label: string }>; plans: Array<{ id: string; key: string; name: string; modules: Record<string, boolean>; quotas: Record<string, number> }> }
  const [p, setP] = useState<PlanInfo | null>(null);
  const load = useCallback(() => api.get<PlanInfo>("/api/settings/plan").then(setP).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!p) return <Spinner />;
  const moduleLabel: Record<string, string> = { crm: "CRM", messaging: "דיוור והודעות", telephony: "טלפוניה וחייגן" };
  async function setPlan(planId: string) { try { await api.patch("/api/settings/plan", { planId }); toast.success("החבילה עודכנה"); load(); } catch (e) { toast.error((e as Error).message); } }
  async function toggleModule(k: string, v: boolean) { try { await api.patch("/api/settings/plan", { modules: { ...p!.overrides, [k]: v } }); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <div className="space-y-4">
      <Panel title="חבילה">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>חבילה נוכחית:</span><Badge tone="accent">{p.planName ?? "ללא חבילה (הכול פתוח)"}</Badge>
          {isAdmin && <Select value={p.planId ?? ""} onChange={(e) => e.target.value && setPlan(e.target.value)} className="w-56"><option value="">בחר חבילה…</option>{p.plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}</Select>}
        </div>
        <p className="text-xs text-muted mt-2">אין סליקה בשלב זה – שיוך חבילה הוא פעולת בעלים/מפעיל ונרשם ב-Audit Log. המודולים והמכסות נאכפים בשרת.</p>
      </Panel>
      <Panel title="מודולים">
        <ul className="text-sm space-y-2">
          {Object.entries(p.modules).map(([k, v]) => <li key={k} className="flex items-center gap-3"><span className="w-40">{moduleLabel[k] ?? k}</span>{v ? <Badge tone="good">פעיל</Badge> : <Badge tone="neutral">כבוי</Badge>}{isAdmin && <Button size="sm" variant="ghost" onClick={() => toggleModule(k, !v)}>{v ? "כבה לעסק זה" : "הפעל לעסק זה"}</Button>}</li>)}
        </ul>
      </Panel>
      <Panel title="שימוש ומכסות (החודש)">
        <ul className="text-sm space-y-2">
          {Object.entries(p.usage).map(([k, u]) => { const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null; return (
            <li key={k}><div className="flex justify-between"><span>{u.label}</span><span className="tabular text-muted">{u.used}{u.limit !== null ? ` / ${u.limit}` : " (ללא הגבלה)"}</span></div>{pct !== null && <div className="h-1.5 bg-white/8 rounded mt-1"><div className={cx("h-1.5 rounded", pct >= 90 ? "bg-bad" : pct >= 70 ? "bg-warn" : "bg-accent")} style={{ width: `${pct}%` }} /></div>}</li>
          ); })}
        </ul>
      </Panel>
    </div>
  );
}

function AutomationsTab({ isAdmin, messaging }: { isAdmin: boolean; messaging: boolean }) {
  const [a, setA] = useState<Automations | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; category: string; status: string }>>([]);
  useEffect(() => {
    api.get<{ settings: Settings }>("/api/settings").then((r) => setA(r.settings.automations)).catch((e) => toast.error(e.message));
    if (messaging) fetch("/api/templates").then((r) => r.ok ? r.json() : { templates: [] }).then((d) => setTemplates((d.templates ?? []).filter((t: { status: string }) => t.status === "APPROVED"))).catch(() => undefined);
  }, [messaging]);
  if (!a) return <Spinner />;
  const outcomes = [["answered_interested", "ענה – מעוניין"], ["answered_not_interested", "ענה – לא מעוניין"], ["callback", "לחזור בהמשך"], ["no_answer", "אין מענה"], ["busy", "תפוס"], ["sale", "בוצעה מכירה"]];
  const toggle = (arr: string[], k: string) => arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k];
  async function save() { if (!a) return; try { await api.patch("/api/settings", { settings: { automations: a } }); toast.success("האוטומציות נשמרו"); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title="אוטומציות בין מודולים" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>
      <div className="space-y-5 text-sm">
        <div>
          <p className="font-medium">ליד חדש → שיוך לנציג + משימת פנייה ראשונית</p>
          <p className="text-xs text-muted mb-2">ליד ללא נציג משויך לנציג עם הכי מעט לידים פתוחים (או לבעלים של איש הקשר). המשימה נוצרת פעם אחת לכל ליד.</p>
          <Input label="המשימה מגיעה לפירעון תוך (דקות)" type="number" className="w-40" value={String(a.newLeadTaskMinutes)} disabled={!isAdmin} onChange={(e) => setA({ ...a, newLeadTaskMinutes: Number(e.target.value) })} />
        </div>
        <div>
          <p className="font-medium">תוצאת שיחה → משימת מעקב</p>
          <div className="flex flex-wrap gap-3 my-2">{outcomes.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" disabled={!isAdmin} checked={a.followUpTaskOutcomes.includes(k)} onChange={() => setA({ ...a, followUpTaskOutcomes: toggle(a.followUpTaskOutcomes, k) })} /> {l}</label>)}</div>
          <Input label="פירעון תוך (שעות)" type="number" className="w-40" value={String(a.followUpTaskHours)} disabled={!isAdmin} onChange={(e) => setA({ ...a, followUpTaskHours: Number(e.target.value) })} />
          <p className="text-xs text-muted mt-1">בנוסף: &quot;מעוניין&quot; מקדם ליד פתוח ל&quot;מתאים&quot;, &quot;לא מעוניין&quot; סוגר אותו, ו&quot;מכירה&quot; יוצרת עסקה סגורה ומסמנת את הליד כהומר.</p>
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-medium">תוצאת שיחה → הודעת המשך ב-WhatsApp</p>
          <p className="text-xs text-muted mb-2">נשלחת רק כאשר קיים ערוץ WhatsApp מחובר, איש הקשר לא הוסר מדיוור, ולתבנית שיווקית – רק עם הסכמה מתועדת. בלי ערוץ מחובר האוטומציה מדלגת ומתעדת זאת.</p>
          {!messaging && <Badge tone="neutral">מודול הדיוור כבוי</Badge>}
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin || !messaging} checked={a.followUpMessage.enabled} onChange={(e) => setA({ ...a, followUpMessage: { ...a.followUpMessage, enabled: e.target.checked } })} /> מופעל</label>
          <Select label="תבנית מאושרת" value={a.followUpMessage.templateId ?? ""} disabled={!isAdmin || !messaging} onChange={(e) => setA({ ...a, followUpMessage: { ...a.followUpMessage, templateId: e.target.value || null } })} className="max-w-sm my-2"><option value="">— בחר תבנית —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}</Select>
          <div className="flex flex-wrap gap-3">{outcomes.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" disabled={!isAdmin || !messaging} checked={a.followUpMessage.outcomes.includes(k)} onChange={() => setA({ ...a, followUpMessage: { ...a.followUpMessage, outcomes: toggle(a.followUpMessage.outcomes, k) } })} /> {l}</label>)}</div>
        </div>
        <p className="text-xs text-muted border-t border-line pt-3">אוטומציות נוספות מובנות: שיחה שהסתיימה / הודעה נכנסת מעדכנות את ציר הפעילות ומקדמות ליד &quot;חדש&quot; ל&quot;נוצר קשר&quot;; בקשת הסרה בכל ערוץ חוסמת דיוור שיווקי בכל הערוצים. כל אירוע מעובד פעם אחת לכל מטפל (טבלת automation_jobs) עם ניסיונות חוזרים במקרה כשל זמני.</p>
      </div>
    </Panel>
  );
}

function MarketingTab({ isAdmin }: { isAdmin: boolean }) {
  const [m, setM] = useState<{ window: { start: string; end: string; days: number[] }; maxPerMinute: number; minHoursBetweenMarketing: number } | null>(null);
  const [ret, setRet] = useState<{ messagesDays: number; auditDays: number }>({ messagesDays: 0, auditDays: 0 });
  const [tz, setTz] = useState("");
  useEffect(() => { api.get<{ business: { timezone?: string }; settings: { marketing: { window: { start: string; end: string; days: number[] }; maxPerMinute: number; minHoursBetweenMarketing: number }; retention?: { messagesDays: number; auditDays: number } } }>("/api/settings").then((r) => { setM(r.settings.marketing); setRet(r.settings.retention ?? { messagesDays: 0, auditDays: 0 }); setTz(r.business.timezone ?? ""); }).catch((e) => toast.error(e.message)); }, []);
  if (!m) return <Spinner />;
  const days = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
  async function save() {
    try { await api.patch("/api/settings", { settings: { marketing: m, retention: ret } }); toast.success("נשמר"); } catch (e) { toast.error((e as Error).message); }
  }
  return (<>
    <Panel title="שמירה ומחיקת מידע" className="mb-4">
      <p className="text-xs text-muted mb-3">מדיניות שמירה לעסק: תוכן הודעות וקבצים מצורפים ישנים נמחקים בעבודת רקע יומית (השיחות, הספירות ויומן הביקורת של המחיקה נשמרים). 0 = לשמור לתמיד. המחיקה אינה הפיכה.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="מחיקת תוכן הודעות ומדיה אחרי (ימים)" type="number" value={String(ret.messagesDays)} onChange={(e) => setRet({ ...ret, messagesDays: Number(e.target.value) })} disabled={!isAdmin} />
        <Input label="מחיקת יומן ביקורת אחרי (ימים)" type="number" value={String(ret.auditDays)} onChange={(e) => setRet({ ...ret, auditDays: Number(e.target.value) })} disabled={!isAdmin} />
      </div>
    </Panel>
    <Panel title="דיוור – חלון שליחה, קצב ותדירות (כל הערוצים)">
      <p className="text-xs text-muted mb-3">קמפיינים שיווקיים ורצפים בכל הערוצים נשלחים רק בתוך חלון השליחה (באזור הזמן של העסק{tz ? `: ${tz}` : ""}). מגבלת התדירות משותפת לכל הערוצים כולל WhatsApp.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="תחילת חלון (HH:MM)" value={m.window.start} onChange={(e) => setM({ ...m, window: { ...m.window, start: e.target.value } })} disabled={!isAdmin} ltr />
        <Input label="סוף חלון (HH:MM)" value={m.window.end} onChange={(e) => setM({ ...m, window: { ...m.window, end: e.target.value } })} disabled={!isAdmin} ltr />
        <div><span className="text-xs text-muted">ימים</span><div className="flex gap-1 mt-1">{days.map((d, i) => <button key={i} type="button" disabled={!isAdmin} onClick={() => setM({ ...m, window: { ...m.window, days: m.window.days.includes(i) ? m.window.days.filter((x) => x !== i) : [...m.window.days, i].sort() } })} className={cx("h-8 w-8 rounded border text-sm", m.window.days.includes(i) ? "bg-accent text-white" : "text-muted")}>{d}</button>)}</div></div>
        <Input label="מקסימום נמענים לדקה (0 = ללא הגבלה)" type="number" value={String(m.maxPerMinute)} onChange={(e) => setM({ ...m, maxPerMinute: Number(e.target.value) })} disabled={!isAdmin} />
        <Input label="שעות מינימום בין הודעות שיווקיות לאותו נמען" type="number" value={String(m.minHoursBetweenMarketing)} onChange={(e) => setM({ ...m, minHoursBetweenMarketing: Number(e.target.value) })} disabled={!isAdmin} hint="נאכף כיום ב-24 שעות בכל הערוצים; ערך גבוה יותר מחמיר את בדיקת הזכאות בסיכום הקמפיין" />
      </div>
      {isAdmin && <Button className="mt-3" onClick={save}>שמור</Button>}
    </Panel>
  </>);
}

function SuppressionsTab() {
  const [items, setItems] = useState<Array<{ id: string; identifier: string; identifierType: string; scope: string; source: string; reason: string | null; createdAt: string; pendingReview: boolean; contact: { id: string; fullName: string } | null; createdBy: { fullName: string } | null }>>([]);
  const [pending, setPending] = useState(0);
  const [bySource, setBySource] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => api.get<{ items: typeof items; pending: number; bySource: Record<string, number> }>(`/api/suppressions${qs({ q, review: onlyReview ? "1" : undefined })}`).then((r) => { setItems(r.items); setPending(r.pending); setBySource(r.bySource); }).catch((e) => toast.error(e.message)), [q, onlyReview]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  async function review(id: string, action: "confirm" | "dismiss") {
    try { await api.post(`/api/suppressions/${id}/review`, { action, note: note[id] ?? "" }); toast.success(action === "confirm" ? "ההסרה אושרה" : "הבקשה נדחתה והדיוור שוחרר"); load(); } catch (e) { toast.error((e as Error).message); }
  }
  const SOURCE: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל", manual: "נציג", import: "ייבוא", phone: "טלפון", api: "API" };
  return (
    <Panel title="הסרות מדיוור (מקור אמת גלובלי)">
      <p className="text-xs text-muted mb-3">כל בקשת הסרה מ-WhatsApp, SMS, אימייל, נציג או ייבוא חוסמת דיוור שיווקי בכל הערוצים לכל הטלפונים והאימיילים של איש הקשר. היקף &quot;לא ליצור קשר&quot; חוסם גם הודעות שירות ושיחות יוצאות. חזרה לדיוור נעשית מכרטיס הלקוח עם תיעוד הסכמה. ייבוא מחדש, החלפת ספק או שולח אינם מבטלים חסימה.</p>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        {Object.entries(bySource).map(([s, n]) => <Badge key={s} tone="neutral">{SOURCE[s] ?? s}: {n}</Badge>)}
        {pending > 0 && <Badge tone="warn">ממתינות לבדיקה: {pending}</Badge>}
        <label className="flex items-center gap-1 ms-auto"><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />רק בקשות לבדיקה</label>
      </div>
      <Input placeholder="חיפוש לפי טלפון / אימייל" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 max-w-sm" />
      <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8 font-medium">מזהה</th><th className="text-start font-medium">איש קשר</th><th className="text-start font-medium">היקף</th><th className="text-start font-medium">מקור</th><th className="text-start font-medium">סיבה</th><th className="text-start font-medium">מועד</th></tr></thead>
        <tbody className="divide-y divide-line">{items.map((s) => <tr key={s.id} className={s.pendingReview ? "bg-amber-500/5" : ""}><td className="h-9"><Phone value={s.identifierType === "phone" ? formatPhone(s.identifier) : s.identifier} /></td><td>{s.contact ? <a href={`/contacts/${s.contact.id}`} className="hover:underline">{s.contact.fullName}</a> : "—"}</td><td>{s.pendingReview ? <Badge tone="warn">ממתין לבדיקה</Badge> : s.scope === "all" ? <Badge tone="bad">לא ליצור קשר</Badge> : <Badge tone="warn">שיווקי</Badge>}</td><td className="text-muted">{SOURCE[s.source] ?? s.source}</td><td className="text-muted max-w-xs"><div className="truncate">{s.reason ?? "—"}</div>{s.pendingReview && <div className="mt-1 flex flex-wrap items-center gap-1"><Input placeholder="נימוק" value={note[s.id] ?? ""} onChange={(e) => setNote({ ...note, [s.id]: e.target.value })} className="h-7 w-40" /><Button size="sm" onClick={() => review(s.id, "confirm")}>אשר הסרה</Button><Button size="sm" variant="ghost" onClick={() => review(s.id, "dismiss")}>לא בקשת הסרה</Button></div>}</td><td className="text-muted text-xs tabular">{formatDateTime(s.createdAt)} · {s.createdBy?.fullName ?? "מערכת"}</td></tr>)}
        {items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted">אין הסרות פעילות</td></tr>}</tbody></table>
    </Panel>
  );
}
