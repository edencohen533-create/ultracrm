"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Phone, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";

type Tab = "general" | "priority" | "safety" | "numbers" | "users" | "scripts" | "dnc" | "telephony" | "history";
interface Prio { callbackDue: number; priority: number; newLeadPerHour: number; newLeadMaxHours: number; agingPerHour: number; agingMaxHours: number; attemptPenalty: number; ownerMatch: number; sourceWeights: Record<string, number>; interestedBefore: number }
interface Settings { wrapUpSeconds: number; autoDialCountdownSeconds: number; maxAttempts: number; retryIntervalMinutes: number; busyRetryMinutes: number; technicalFailureRetryMinutes: number; lockTtlSeconds: number; ringTimeoutSeconds: number; recordingEnabled: boolean; recordingAnnouncement: string; recordingRetentionDays: number; amdEnabled: boolean; stickyOwner: boolean; removeFromOtherListsOnSale: boolean; dialingPaused: boolean; allowedCountries: string[]; maxDialsPerMinute: number; dialWindow: { start: string; end: string; days: number[] }; prioritization: Prio; inbound: { preferOwner: boolean; createCallbackTask: boolean; respectDialWindow: boolean } }
interface Tel { provider: string; simulation: boolean; requested: string; telnyx: { configured: boolean; missing: string[] } }

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("general");
  const [me, setMe] = useState<{ role: string } | null>(null);
  useEffect(() => { api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined); }, []);
  const isAdmin = me?.role === "admin";
  const tabs: Array<[Tab, string]> = [["general", "חייגן"], ["priority", "תעדוף לידים"], ["safety", "בטיחות ושיחות נכנסות"], ["numbers", "מספרים יוצאים"], ["users", "משתמשים"], ["scripts", "תסריטים"], ["dnc", "לא ליצור קשר"], ["telephony", "טלפוניה"], ["history", "היסטוריית שינויים"]];
  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <h1 className="text-lg font-semibold">הגדרות</h1>
      <div className="flex gap-1 border-b border-line">
        {tabs.map(([k, v]) => <button key={k} onClick={() => setTab(k)} className={cx("h-10 px-4 text-sm border-b-2 -mb-px", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{v}</button>)}
      </div>
      {tab === "general" && <GeneralTab isAdmin={isAdmin} />}
      {tab === "priority" && <PriorityTab isAdmin={isAdmin} />}
      {tab === "safety" && <SafetyTab isAdmin={isAdmin} />}
      {tab === "history" && <HistoryTab />}
      {tab === "numbers" && <NumbersTab isAdmin={isAdmin} />}
      {tab === "users" && <UsersTab isAdmin={isAdmin} />}
      {tab === "scripts" && <ScriptsTab />}
      {tab === "dnc" && <DncTab />}
      {tab === "telephony" && <TelephonyTab />}
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
    <Panel title="הגדרות חייגן" actions={isAdmin && <Button size="sm" onClick={save}>שמור</Button>}>
      <div className="grid md:grid-cols-3 gap-3">
        <Input label="שם העסק" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} className="md:col-span-3" />
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
  async function create() { try { await api.post("/api/users", { ...form, teamId: form.teamId || null }); setOpen(false); setForm({ fullName: "", email: "", password: "", role: "agent", teamId: "" }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function patch(id: string, body: object) { try { await api.patch(`/api/users/${id}`, body); load(); } catch (e) { toast.error((e as Error).message); } }
  const roleLabel: Record<string, string> = { admin: "מנהל מערכת", manager: "מנהל מוקד", agent: "נציג" };
  return (
    <Panel title="משתמשים" actions={isAdmin && <Button size="sm" onClick={() => setOpen(true)}>+ משתמש</Button>}>
      <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8 font-medium">שם</th><th className="text-start font-medium">אימייל</th><th className="text-start font-medium">תפקיד</th><th className="text-start font-medium">צוות</th><th></th></tr></thead>
        <tbody className="divide-y divide-line">{items.map((u) => <tr key={u.id}><td className="h-10">{u.fullName}{!u.isActive && <Badge tone="bad" className="ms-2">מושבת</Badge>}</td><td className="ltr text-start text-muted">{u.email}</td><td>{roleLabel[u.role]}</td><td className="text-muted">{u.team?.name ?? "—"}</td><td className="text-end">{isAdmin && <Button size="sm" variant="ghost" onClick={() => patch(u.id, { isActive: !u.isActive })}>{u.isActive ? "השבת" : "הפעל"}</Button>}</td></tr>)}</tbody></table>
      <Modal open={open} onClose={() => setOpen(false)} title="משתמש חדש" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.fullName || !form.email || form.password.length < 6}>צור</Button></>}>
        <div className="space-y-2">
          <Input label="שם מלא" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <Input label="סיסמה (6+ תווים)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} ltr />
          <Select label="תפקיד" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="agent">נציג</option><option value="manager">מנהל מוקד</option><option value="admin">מנהל מערכת</option></Select>
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
