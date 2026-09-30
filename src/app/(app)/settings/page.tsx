"use client";

import { PaymentSettings } from "@/components/settings/PaymentSettings";
import { AccountDeletion } from "@/components/settings/AccountDeletion";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Phone, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";
import { CoachAdmin } from "@/components/coach/CoachAdmin";
import { AssistantSettings } from "@/components/assistant/AssistantSettings";
import { PermissionsTab } from "@/components/settings/PermissionsTab";
import { ExhaustionPreview } from "@/components/dialer/ExhaustionPreview";
import { PlanOverview } from "@/components/access/PlanOverview";
import { AccessMatrix } from "@/components/access/AccessMatrix";
import { useT } from "@/components/i18n/LangProvider";
import { ProviderRoutingPanel } from "@/components/telephony/ProviderRoutingPanel";

type Tab = "account" | "business" | "users" | "connections" | "plan" | "automations" | "marketing" | "suppressions" | "general" | "priority" | "safety" | "numbers" | "scripts" | "dnc" | "history" | "coach" | "assistant" | "permissions" | "access";
interface Prio { callbackDue: number; priority: number; newLeadPerHour: number; newLeadMaxHours: number; agingPerHour: number; agingMaxHours: number; attemptPenalty: number; ownerMatch: number; sourceWeights: Record<string, number>; interestedBefore: number }
interface Automations { newLeadTaskMinutes: number; followUpTaskOutcomes: string[]; followUpTaskHours: number; followUpMessage: { enabled: boolean; templateId: string | null; outcomes: string[]; variables: Record<string, string> } }
interface Settings { whatsappAvailability: boolean; availableNowTtlMinutes: number; automations: Automations; wrapUpSeconds: number; autoDialCountdownSeconds: number; maxAttempts: number; unansweredToIrrelevant: number; retryIntervalMinutes: number; busyRetryMinutes: number; technicalFailureRetryMinutes: number; lockTtlSeconds: number; ringTimeoutSeconds: number; recordingEnabled: boolean; recordingAnnouncement: string; recordingRetentionDays: number; amdEnabled: boolean; stickyOwner: boolean; removeFromOtherListsOnSale: boolean; dialingPaused: boolean; allowedCountries: string[]; contactCooldownMinutes: number; maxDialsPerMinute: number; dialWindow: { start: string; end: string; days: number[] }; prioritization: Prio; inbound: { preferOwner: boolean; createCallbackTask: boolean; respectDialWindow: boolean } }
interface Tel { provider: string; simulation: boolean; requested: string; telnyx: { configured: boolean; missing: string[] } }

export default function SettingsPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("business");
  const [me, setMe] = useState<{ user: { role: string }; modules: Record<string, boolean> } | null>(null);
  useEffect(() => { api.get<{ user: { role: string }; modules: Record<string, boolean> }>("/api/auth/me").then(setMe).catch(() => undefined); }, []);
  useEffect(() => { const t = new URLSearchParams(window.location.search).get("tab"); if (t) setTab(t as Tab); }, []);
  const isAdmin = me?.user.role === "owner";
  // Server modules are crm/telephony/whatsapp/sms/email; `messaging` here means the WhatsApp module.
  const modules: Record<string, boolean> = me ? { ...me.modules, messaging: me.modules.whatsapp ?? me.modules.messaging ?? false } : { crm: true, messaging: true, telephony: true };
  const groups: Array<{ title: string; tabs: Array<[Tab, string]>; show: boolean }> = [
    { title: t("עסק", "Business"), tabs: [["business", t("פרטי העסק", "Business details")], ["users", t("משתמשים וצוותים", "Users & Teams")], ["access", t("מודולים והרשאות", "Modules & permissions")], ["permissions", t("הרשאות נתונים", "Data permissions")], ["connections", t("חיבורים", "Connections")], ["plan", t("חבילה ומכסות", "Plan & quotas")], ["automations", t("אוטומציות", "Automations")], ["marketing", t("דיוור", "Marketing")], ["assistant", t("העוזר האישי בוואטסאפ", "WhatsApp personal assistant")], ["account", t("חשבון ומחיקה", "Account & deletion")], ["suppressions", t("הסרות מדיוור", "Unsubscribes")], ["history", t("היסטוריית שינויים", "Change history")]], show: true },
    { title: t("טלפוניה", "Telephony"), tabs: [["general", t("חייגן", "Dialer")], ["priority", t("תעדוף לידים", "Lead prioritization")], ["safety", t("בטיחות ושיחות נכנסות", "Safety & inbound calls")], ["numbers", t("מספרים יוצאים", "Outbound numbers")], ["scripts", t("תסריטים", "Scripts")], ["dnc", t("לא ליצור קשר", "Do not contact")], ["coach", t("מאמן AI", "AI coach")]], show: modules.telephony },
  ];
  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <h1 className="text-lg font-semibold">{t("הגדרות", "Settings")}</h1>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line">
        {groups.filter((g) => g.show).map((g) => (
          <div key={g.title} className="flex flex-wrap items-end gap-1">
            <span className="text-[10px] text-muted/70 pb-3 pe-1">{g.title}</span>
            {g.tabs.map(([k, v]) => <button key={k} onClick={() => setTab(k)} className={cx("h-10 px-3 text-sm border-b-2 -mb-px whitespace-nowrap", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{v}</button>)}
          </div>
        ))}
      </div>
      {tab === "business" && <><BusinessTab isAdmin={isAdmin} /><AccountPanel /></>}
      {tab === "account" && <AccountDeletion isOwner={isAdmin} />}
      {tab === "connections" && <ConnectionsTab modules={modules} />}
      {tab === "plan" && <PlanOverview />}
      {tab === "access" && <AccessMatrix />}
      {tab === "automations" && <AutomationsTab isAdmin={isAdmin} messaging={modules.messaging} />}
      {tab === "marketing" && <MarketingTab isAdmin={isAdmin} />}
      {tab === "suppressions" && <SuppressionsTab />}
      {tab === "general" && <GeneralTab isAdmin={isAdmin} />}
      {tab === "priority" && <PriorityTab isAdmin={isAdmin} />}
      {tab === "safety" && <SafetyTab isAdmin={isAdmin} />}
      {tab === "history" && <HistoryTab />}
      {tab === "coach" && <CoachAdmin isAdmin={isAdmin} />}
      {tab === "assistant" && <AssistantSettings isOwner={isAdmin} />}
      {tab === "permissions" && <PermissionsTab isOwner={isAdmin} />}
      {tab === "numbers" && <NumbersTab isAdmin={isAdmin} />}
      {tab === "users" && <UsersTab isAdmin={isAdmin} />}
      {tab === "scripts" && <ScriptsTab />}
      {tab === "dnc" && <DncTab />}
    </div>
  );
}

function GeneralTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  useEffect(() => { api.get<{ business: { name: string }; settings: Settings }>("/api/settings").then((r) => { setS(r.settings); setName(r.business.name); }).catch((e) => toast.error(e.message)); }, []);
  if (!s) return <Spinner />;
  const num = (k: keyof Settings, label: string, hint?: string) => <Input label={label} hint={hint} type="number" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} disabled={!isAdmin} />;
  const days = t.lang === "en" ? ["S", "M", "T", "W", "T", "F", "S"] : ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
  async function save() {
    try { await api.patch("/api/settings", { name, settings: s }); toast.success(t("ההגדרות נשמרו", "Settings saved")); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Panel title={t("הגדרות חייגן", "Dialer settings")} actions={isAdmin && <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>}>{name ? null : null}
      <div className="grid md:grid-cols-3 gap-3">
        {num("autoDialCountdownSeconds", t("ספירה לאחור בין שיחות (שנ׳)", "Countdown between calls (sec)"), t("בתותח שיחות, אחרי שמירת תוצאה", "In power dialer, after saving the outcome"))}
        {num("wrapUpSeconds", t("זמן תיעוד (שנ׳)", "Wrap-up time (sec)"), t("משפיע על הארכת נעילת הליד אחרי שיחה", "Affects extending the lead lock after a call"))}
        {num("maxAttempts", t("מקס׳ ניסיונות לליד", "Max attempts per lead"))}
        {num("unansweredToIrrelevant", t("מספר ניסיונות חיוג ללא מענה לפני העברה ללא רלוונטי", "Unanswered dial attempts before moving to irrelevant"), t("0 = כבוי. נספרים רק חיוגים שיצאו בפועל; ליד שנענה או שיש לו פולואפ עתידי לא יועבר. קמפיין או נציג יכולים לדרוס", "0 = off. Only dials actually placed are counted; a lead that answered or has a future follow-up will not be moved. A campaign or agent can override"))}
        {num("retryIntervalMinutes", t("מרווח לניסיון חוזר – אין מענה (דק׳)", "Retry interval – no answer (min)"))}
        {num("busyRetryMinutes", t("מרווח לניסיון חוזר – תפוס (דק׳)", "Retry interval – busy (min)"))}
        {num("ringTimeoutSeconds", t("זמן צלצול מקסימלי (שנ׳)", "Max ring time (sec)"))}
        {num("lockTtlSeconds", t("תוקף נעילת ליד (שנ׳)", "Lead lock TTL (sec)"), t("מתחדש אוטומטית כל 15 שנ׳ כל עוד הנציג מחובר", "Renews automatically every 15 sec while the agent is connected"))}
        {num("technicalFailureRetryMinutes", t("כשל טכני – חזרה לתור אחרי (דק׳)", "Technical failure – back to queue after (min)"), t("כשל ספק לפני צלצול: הניסיון לא נספר, אין צורך בתיעוד", "Provider failure before ringing: the attempt is not counted, no wrap-up needed"))}
        {num("recordingRetentionDays", t("שמירת הקלטות (ימים, 0 = לתמיד)", "Recording retention (days, 0 = forever)"), t("הקלטות ישנות יותר נמחקות אצל הספק בעבודת רקע יומית", "Older recordings are deleted at the provider by a daily background job"))}
        {num("availableNowTtlMinutes", t("תוקף ״זמינה עכשיו״ מוואטסאפ (דק׳)", "WhatsApp \"available now\" TTL (min)"), t("אחרי הזמן הזה העדיפות מוסרת והנציג מקבל התראה שלא טופל", "After this time the priority is removed and the agent is notified it was not handled"))}
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.whatsappAvailability} disabled={!isAdmin} onChange={(e) => setS({ ...s, whatsappAvailability: e.target.checked })} data-testid="setting-wa-availability" /> {t("לקוח שעונה בוואטסאפ ״אני זמינה עכשיו״ עובר לראש התור של הנציג המשויך (״מחר בעשר״ → פולואפ; לא ברור → לבדיקת הנציג)", "A customer who replies on WhatsApp \"I'm available now\" moves to the top of the assigned agent's queue (\"tomorrow at ten\" → follow-up; unclear → agent review)")}</label>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.amdEnabled} disabled={!isAdmin} onChange={(e) => setS({ ...s, amdEnabled: e.target.checked })} /> {t("זיהוי תא קולי (Telnyx AMD) – מוצג לנציג כהצעה בלבד, לעולם לא מנתק אוטומטית", "Voicemail detection (Telnyx AMD) – shown to the agent as a suggestion only, never hangs up automatically")}</label>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.stickyOwner} disabled={!isAdmin} onChange={(e) => setS({ ...s, stickyOwner: e.target.checked })} /> {t("ליד שלא נענה נשאר אצל הנציג שטיפל בו (עד שעה איחור, אחר כך לכולם)", "An unanswered lead stays with the agent who handled it (up to one hour late, then to everyone)")}</label>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.removeFromOtherListsOnSale} disabled={!isAdmin} onChange={(e) => setS({ ...s, removeFromOtherListsOnSale: e.target.checked })} /> {t("מכירה סוגרת את הליד בכל הרשימות האחרות של העסק", "A sale closes the lead in all other lists of the business")}</label>
        <div className="md:col-span-3">
          <span className="block text-xs text-muted mb-1">{t("חלון חיוג ברירת מחדל", "Default dialing window")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" value={s.dialWindow.start} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialWindow: { ...s.dialWindow, start: e.target.value } })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
            <span className="text-muted">{t("עד", "to")}</span>
            <input type="time" value={s.dialWindow.end} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialWindow: { ...s.dialWindow, end: e.target.value } })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
            <div className="flex gap-1 ms-2">{days.map((d, i) => <button key={i} disabled={!isAdmin} onClick={() => setS({ ...s, dialWindow: { ...s.dialWindow, days: s.dialWindow.days.includes(i) ? s.dialWindow.days.filter((x) => x !== i) : [...s.dialWindow.days, i] } })} className={cx("w-8 h-8 rounded-md text-xs", s.dialWindow.days.includes(i) ? "bg-accent text-white" : "bg-white/6 text-muted")}>{d}</button>)}</div>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={s.recordingEnabled} disabled={!isAdmin} onChange={(e) => setS({ ...s, recordingEnabled: e.target.checked })} /> {t("הקלטת שיחות (מרגע המענה, דו-ערוצי)", "Call recording (from answer, dual-channel)")}</label>
        {isAdmin && <div className="md:col-span-3"><ExhaustionPreview /></div>}
        <Textarea label={t("מדיניות הודעה למתקשר על הקלטה", "Recording announcement policy for callers")} rows={2} value={s.recordingAnnouncement} disabled={!isAdmin} onChange={(e) => setS({ ...s, recordingAnnouncement: e.target.value })} className="md:col-span-3" />
      </div>
    </Panel>
  );
}

function NumbersTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; e164: string; label: string | null; isDefault: boolean; isActive: boolean }>>([]);
  const [phone, setPhone] = useState(""); const [label, setLabel] = useState("");
  const load = useCallback(() => api.get<typeof items>("/api/phone-numbers").then(setItems).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function add() { try { await api.post("/api/phone-numbers", { phone, label }); setPhone(""); setLabel(""); load(); } catch (e) { toast.error((e as Error).message); } }
  async function patch(id: string, body: object) { try { await api.patch(`/api/phone-numbers/${id}`, body); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("מספרים מורשים לחיוג יוצא", "Numbers authorized for outbound dialing")}>
      <a href="/numbers" className="block underline mb-3 text-sm">{t("לניהול מספרים: מוניטין, רכישה, רוטציה ומדיניות לקמפיין →", "Manage numbers: reputation, purchase, rotation and campaign policy →")}</a>
      <p className="text-xs text-muted mb-3">{t("רק מספרים ברשימה זו יוצגו ללקוח כמזהה מתקשר. ב-Telnyx המספר חייב להיות משויך לחשבון ול-Call Control App.", "Only numbers in this list will be shown to customers as caller ID. In Telnyx the number must be assigned to the account and to the Call Control App.")}</p>
      {isAdmin && <div className="flex gap-2 mb-4"><Input placeholder="+972…" value={phone} onChange={(e) => setPhone(e.target.value)} ltr /><Input placeholder={t("תווית", "Label")} value={label} onChange={(e) => setLabel(e.target.value)} /><Button onClick={add} disabled={!phone}>{t("הוסף", "Add")}</Button></div>}
      <ul className="divide-y divide-line">
        {items.map((n) => (
          <li key={n.id} className="flex items-center gap-3 py-2 text-sm">
            <Phone value={formatPhone(n.e164)} className="font-medium" /><span className="text-muted">{n.label}</span>
            {n.isDefault && <Badge tone="accent">{t("ברירת מחדל", "Default")}</Badge>}{!n.isActive && <Badge tone="bad">{t("לא פעיל", "Inactive")}</Badge>}
            {isAdmin && <div className="ms-auto flex gap-2">{!n.isDefault && n.isActive && <Button size="sm" variant="ghost" onClick={() => patch(n.id, { isDefault: true })}>{t("קבע כברירת מחדל", "Set as default")}</Button>}<Button size="sm" variant="ghost" onClick={() => patch(n.id, { isActive: !n.isActive })}>{n.isActive ? t("השבת", "Disable") : t("הפעל", "Enable")}</Button></div>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function UsersTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; fullName: string; email: string; role: string; isActive: boolean; invitedAt: string | null; inviteExpiresAt: string | null; team: { name: string } | null }>>([]);
  const [invite, setInvite] = useState<{ name: string; url: string; expiresAt: string } | null>(null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", role: "agent", teamId: "" });
  const load = useCallback(() => api.get<{ items: typeof items; teams: typeof teams }>("/api/users").then((r) => { setItems(r.items); setTeams(r.teams); }).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function create() { try { const r = await api.post<{ fullName: string; inviteUrl: string; inviteExpiresAt: string }>("/api/users", { ...form, teamId: form.teamId || null }); setOpen(false); setForm({ fullName: "", email: "", role: "agent", teamId: "" }); setInvite({ name: r.fullName, url: r.inviteUrl, expiresAt: r.inviteExpiresAt }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function reissue(id: string, name: string) { try { const r = await api.post<{ inviteUrl: string; inviteExpiresAt: string }>(`/api/users/${id}/invite`); setInvite({ name, url: r.inviteUrl, expiresAt: r.inviteExpiresAt }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function patch(id: string, body: object) { try { await api.patch(`/api/users/${id}`, body); load(); } catch (e) { toast.error((e as Error).message); } }
  const roleLabel: Record<string, string> = { owner: t("בעלים", "Owner"), manager: t("מנהל", "Manager"), agent: t("נציג", "Agent") };
  const [teamName, setTeamName] = useState("");
  async function createTeam() { try { const r = await fetch("/api/settings/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: teamName }) }); if (!r.ok) throw new Error((await r.json()).error ?? t("שגיאה", "Error")); setTeamName(""); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("משתמשים", "Users")} actions={isAdmin && <Button size="sm" onClick={() => setOpen(true)}>{t("+ משתמש", "+ User")}</Button>}>
      <p className="text-xs text-muted mb-3">{t("משתמשים מצטרפים בקישור הזמנה חד-פעמי ומגדירים סיסמה בעצמם; מי שכבר יש לו חשבון מאשר עם הסיסמה שלו (כניסה אחת לכל העסקים). תפקידים: בעלים (הכול), מנהל (ניהול צוותים, קמפיינים והגדרות תפעול), נציג.", "Users join with a one-time invite link and set their own password; someone who already has an account confirms with their password (one sign-in for every business). Roles: Owner (everything), Manager (manages teams, campaigns and operational settings), Agent.")}</p>
      <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8 font-medium">{t("שם", "Name")}</th><th className="text-start font-medium">{t("אימייל", "Email")}</th><th className="text-start font-medium">{t("תפקיד", "Role")}</th><th className="text-start font-medium">{t("צוות", "Team")}</th><th></th></tr></thead>
        <tbody className="divide-y divide-line">{items.map((u) => <tr key={u.id}><td className="h-10">{u.fullName}{!u.isActive && (u.invitedAt ? <><Badge tone="warn" className="ms-2">{t("הזמנה ממתינה", "Invite pending")}</Badge>{isAdmin && <button type="button" className="ms-2 text-xs text-accent underline" onClick={() => reissue(u.id, u.fullName)}>{t("קישור חדש", "New link")}</button>}</> : <Badge tone="bad" className="ms-2">{t("מושבת", "Disabled")}</Badge>)}</td><td className="ltr text-start text-muted">{u.email}</td><td>{roleLabel[u.role]}</td><td className="text-muted">{u.team?.name ?? "—"}</td><td className="text-end whitespace-nowrap">{isAdmin && <><Select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })} className="inline-block w-28 h-8 text-xs me-2"><option value="agent">{t("נציג", "Agent")}</option><option value="manager">{t("מנהל", "Manager")}</option><option value="owner">{t("בעלים", "Owner")}</option></Select><Select value={u.team ? teams.find((t) => t.name === u.team?.name)?.id ?? "" : ""} onChange={(e) => patch(u.id, { teamId: e.target.value || null })} className="inline-block w-32 h-8 text-xs me-2"><option value="">{t("ללא צוות", "No team")}</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select><Button size="sm" variant="ghost" onClick={() => patch(u.id, { isActive: !u.isActive })}>{u.isActive ? t("השבת", "Disable") : t("הפעל", "Enable")}</Button></>}</td></tr>)}</tbody></table>
      {isAdmin && <div className="flex gap-2 mt-4 items-end"><Input label={t("צוות חדש", "New team")} value={teamName} onChange={(e) => setTeamName(e.target.value)} className="max-w-xs" /><Button variant="secondary" onClick={createTeam} disabled={!teamName.trim()}>{t("צור צוות", "Create team")}</Button></div>}
      <Modal open={Boolean(invite)} onClose={() => setInvite(null)} title={t("קישור הזמנה", "Invite link")} footer={<Button onClick={() => setInvite(null)}>{t("סגור", "Close")}</Button>}>
        {invite && <div className="space-y-2 text-sm">
          <p>{t(`העבר את הקישור ל${invite.name} (וואטסאפ / אימייל). הקישור מוצג רק עכשיו; אפשר ליצור קישור חדש מרשימת המשתמשים.`, `Send this link to ${invite.name} (WhatsApp / email). It is shown only now; you can create a new one from the user list.`)}</p>
          <div className="flex gap-2 items-center"><code className="ltr text-xs break-all flex-1 bg-panel-2 rounded p-2" data-testid="invite-url">{invite.url}</code><Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(invite.url); toast.success(t("הועתק", "Copied")); }}>{t("העתק", "Copy")}</Button></div>
          <p className="text-xs text-muted">{t("בתוקף עד", "Valid until")} {new Date(invite.expiresAt).toLocaleString()}</p>
        </div>}
      </Modal>
      <Modal open={open} onClose={() => setOpen(false)} title={t("משתמש חדש", "New user")} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={create} disabled={!form.fullName || !form.email}>{t("צור הזמנה", "Create invite")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("שם מלא", "Full name")} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <Input label={t("אימייל", "Email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <p className="text-xs text-muted">{t("המשתמש יקבל קישור הזמנה חד-פעמי (תקף 7 ימים) שתעביר לו. הוא יגדיר בעצמו את הסיסמה – או יאשר עם הסיסמה של החשבון הקיים שלו.", "The user gets a one-time invite link (valid 7 days) for you to hand over. They set their own password – or confirm with their existing account's password.")}</p>
          <Select label={t("תפקיד", "Role")} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="agent">{t("נציג", "Agent")}</option><option value="manager">{t("מנהל", "Manager")}</option><option value="owner">{t("בעלים", "Owner")}</option></Select>
          <Select label={t("צוות", "Team")} value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}><option value="">{t("ללא", "None")}</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        </div>
      </Modal>
    </Panel>
  );
}

function ScriptsTab() {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; title: string; body: string; isDefault: boolean }>>([]);
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string; isDefault: boolean } | null>(null);
  const load = useCallback(() => api.get<typeof items>("/api/scripts").then(setItems).catch((e) => toast.error(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function save() {
    if (!edit) return;
    try { if (edit.id) await api.patch(`/api/scripts/${edit.id}`, edit); else await api.post("/api/scripts", edit); setEdit(null); load(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Panel title={t("תסריטי שיחה", "Call scripts")} actions={<Button size="sm" onClick={() => setEdit({ title: "", body: "", isDefault: items.length === 0 })}>{t("+ תסריט", "+ Script")}</Button>}>
      <ul className="divide-y divide-line">{items.map((s) => <li key={s.id} className="flex items-center gap-3 py-2"><span className="font-medium">{s.title}</span>{s.isDefault && <Badge tone="accent">{t("ברירת מחדל", "Default")}</Badge>}<Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEdit(s)}>{t("עריכה", "Edit")}</Button></li>)}</ul>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={edit?.id ? t("עריכת תסריט", "Edit script") : t("תסריט חדש", "New script")} width="max-w-2xl" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{t("ביטול", "Cancel")}</Button><Button onClick={save} disabled={!edit?.title}>{t("שמור", "Save")}</Button></>}>
        {edit && <div className="space-y-2"><Input label={t("כותרת", "Title")} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /><Textarea label={t("תוכן", "Content")} rows={12} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> {t("ברירת מחדל לעסק", "Business default")}</label></div>}
      </Modal>
    </Panel>
  );
}

function DncTab() {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; phoneE164: string; reason: string | null; createdAt: string; createdBy: { fullName: string } | null }>>([]);
  const [q, setQ] = useState(""); const [phone, setPhone] = useState(""); const [reason, setReason] = useState("");
  const load = useCallback(() => api.get<{ items: typeof items }>(`/api/dnc${qs({ q })}`).then((r) => setItems(r.items)).catch((e) => toast.error(e.message)), [q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  async function add() { try { await api.post("/api/dnc", { phone, reason }); setPhone(""); setReason(""); load(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(p: string) { try { await api.delete("/api/dnc", { phone: p }); load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("רשימת לא ליצור קשר (DNC)", "Do-not-contact list (DNC)")}>
      <p className="text-xs text-muted mb-3">{t("מספרים ברשימה זו נחסמים בכל רשימות החיוג של העסק, והחסימה נבדקת שוב ברגע החיוג.", "Numbers on this list are blocked in all of the business's dial lists, and the block is re-checked at dial time.")}</p>
      <div className="flex gap-2 mb-3"><Input placeholder={t("מספר", "Number")} value={phone} onChange={(e) => setPhone(e.target.value)} ltr /><Input placeholder={t("סיבה", "Reason")} value={reason} onChange={(e) => setReason(e.target.value)} /><Button onClick={add} disabled={!phone}>{t("חסום", "Block")}</Button></div>
      <Input placeholder={t("חיפוש", "Search")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <ul className="divide-y divide-line">{items.map((d) => <li key={d.id} className="flex items-center gap-3 py-2 text-sm"><Phone value={formatPhone(d.phoneE164)} className="font-medium" /><span className="text-muted">{d.reason}</span><span className="text-muted text-xs ms-auto">{formatDateTime(d.createdAt)} · {d.createdBy?.fullName ?? t("מערכת", "System")}</span><Button size="sm" variant="ghost" onClick={() => remove(d.phoneE164)}>{t("הסר", "Remove")}</Button></li>)}</ul>
    </Panel>
  );
}

function TelephonyTab() {
  const tr = useT();
  const [t, setT] = useState<Tel | null>(null);
  useEffect(() => { api.get<Tel>("/api/telephony/status").then(setT).catch((e) => toast.error(e.message)); }, []);
  if (!t) return <Spinner />;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Panel title={tr("חיבור טלפוניה (Telnyx)", "Telephony connection (Telnyx)")}>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm">{tr("מצב נוכחי:", "Current mode:")}</span>
        {t.simulation ? <Badge tone="warn">{tr("מצב הדמיה – אין שיחות אמיתיות", "Simulation mode – no real calls")}</Badge> : <Badge tone="good">{tr("Telnyx פעיל", "Telnyx active")}</Badge>}
        {t.requested === "telnyx" && !t.telnyx.configured && <Badge tone="bad">{tr("חסרים:", "Missing:")} {t.telnyx.missing.join(", ")}</Badge>}
      </div>
      <ol className="text-sm space-y-2 list-decimal ps-5 text-text/90">
        <li>{tr("ב-Mission Control צור", "In Mission Control, create a")} <b>Call Control Application</b> {tr("(Voice API) והגדר Webhook URL:", "(Voice API) and set the Webhook URL:")} <code className="ltr bg-black/40 px-1 rounded text-xs">{origin}/api/webhooks/telnyx</code> {tr("(POST). העתק את ה-ID ל-", "(POST). Copy the ID to ")}<code className="ltr text-xs">TELNYX_CALL_CONTROL_APP_ID</code>.</li>
        <li>{tr("צור", "Create a")} <b>SIP Credential Connection</b> {tr("(לרישום הדפדפנים ב-WebRTC). העתק את ה-ID ל-", "(for registering browsers over WebRTC). Copy the ID to ")}<code className="ltr text-xs">TELNYX_CREDENTIAL_CONNECTION_ID</code>. {tr("המערכת יוצרת credential לכל נציג אוטומטית.", "The system creates a credential for each agent automatically.")}</li>
        <li>{tr("שייך", "Assign an")} <b>Outbound Voice Profile</b> {tr("לשני החיבורים, ושייך את מספרי הטלפון של העסק ל-Call Control App.", "to both connections, and assign the business phone numbers to the Call Control App.")}</li>
        <li>{tr("העתק את", "Copy the")} <b>API Key</b> {tr("ל-", "to ")}<code className="ltr text-xs">TELNYX_API_KEY</code> {tr("ואת", "and the")} <b>Public Key</b> (Keys &amp; Credentials) {tr("ל-", "to ")}<code className="ltr text-xs">TELNYX_PUBLIC_KEY</code> {tr("לאימות חתימות Webhook.", "to verify Webhook signatures.")}</li>
        <li>{tr("הגדר", "Set")} <code className="ltr text-xs">TELEPHONY_PROVIDER=telnyx</code> {tr("ופרוס מחדש. הוסף את המספרים היוצאים בלשונית \"מספרים יוצאים\" בפורמט E.164.", "and redeploy. Add the outbound numbers in the \"Outbound numbers\" tab in E.164 format.")}</li>
      </ol>
      <p className="text-xs text-muted mt-4">{tr("זרימת שיחה: השרת מחייג קודם לדפדפן הנציג (SIP leg), ורק אחרי שהדפדפן עונה מחייג ללקוח ומגשר בין השניים כשהלקוח עונה. מצב \"נענה\" מגיע אך ורק מאירועי Telnyx החתומים.", "Call flow: the server first dials the agent's browser (SIP leg), and only after the browser answers does it dial the customer and bridge the two when the customer answers. The \"answered\" state comes only from signed Telnyx events.")}</p>
    </Panel>
  );
}

function PriorityTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [p, setP] = useState<Prio | null>(null);
  const [src, setSrc] = useState(""); const [w, setW] = useState("10");
  useEffect(() => { api.get<{ settings: Settings }>("/api/settings").then((r) => setP(r.settings.prioritization)).catch((e) => toast.error(e.message)); }, []);
  if (!p) return <Spinner />;
  const num = (k: keyof Prio, label: string, hint: string) => <Input label={label} hint={hint} type="number" step="0.25" value={String(p[k])} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} disabled={!isAdmin} />;
  async function save() { try { await api.patch("/api/settings", { settings: { prioritization: p } }); toast.success(t("כללי התעדוף נשמרו", "Prioritization rules saved")); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("תעדוף לידים (שקוף)", "Lead prioritization (transparent)")} actions={isAdmin && <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>}>
      <p className="text-xs text-muted mb-3">{t("ציון = סכום הגורמים × המשקלים. הליד עם הציון הגבוה ביותר נמסר ראשון, והנציג רואה הסבר קצר (\"למה עכשיו\"). גורם ההזדקנות מבטיח שלידים בעדיפות נמוכה לא נשארים לנצח.", "Score = sum of factors × weights. The lead with the highest score is delivered first, and the agent sees a short explanation (\"why now\"). The aging factor ensures low-priority leads are not left forever.")}</p>
      <div className="grid md:grid-cols-3 gap-3">
        {num("callbackDue", t("חזרה שהגיע מועדה", "Callback due"), t("בונוס חד-פעמי לליד במצב חזרה", "One-time bonus for a lead in callback status"))}
        {num("priority", t("עדיפות עסקית (לנקודה)", "Business priority (per point)"), t("מוכפל בעדיפות הליד 0–100", "Multiplied by the lead priority 0–100"))}
        {num("newLeadPerHour", t("ליד חדש – לשעה מאז הכניסה", "New lead – per hour since arrival"), t("רק ללידים שטרם חויגו", "Only for leads not yet dialed"))}
        {num("newLeadMaxHours", t("תקרת שעות לליד חדש", "Max hours for new lead"), "")}
        {num("agingPerHour", t("הזדקנות – לשעה מאז הניסיון האחרון", "Aging – per hour since last attempt"), t("מונע הרעבה של לידים", "Prevents lead starvation"))}
        {num("agingMaxHours", t("תקרת שעות הזדקנות", "Max aging hours"), "")}
        {num("attemptPenalty", t("קנס לכל ניסיון קודם", "Penalty per previous attempt"), "")}
        {num("ownerMatch", t("הליד שייך לנציג המושך", "Lead belongs to the pulling agent"), "")}
        {num("interestedBefore", t("הביע עניין בשיחה קודמת", "Showed interest in a previous call"), "")}
      </div>
      <div className="mt-4">
        <span className="block text-xs text-muted mb-1">{t("משקל לפי מקור", "Weight by source")}</span>
        <div className="flex flex-wrap gap-2 mb-2">{Object.entries(p.sourceWeights).map(([k, v]) => <Badge key={k} tone="accent">{k}: {v} {isAdmin && <button onClick={() => { const sw = { ...p.sourceWeights }; delete sw[k]; setP({ ...p, sourceWeights: sw }); }} className="ms-1">×</button>}</Badge>)}</div>
        {isAdmin && <div className="flex gap-2"><Input placeholder={t("מקור (למשל facebook)", "Source (e.g. facebook)")} value={src} onChange={(e) => setSrc(e.target.value)} /><Input type="number" value={w} onChange={(e) => setW(e.target.value)} className="w-24" /><Button variant="secondary" onClick={() => { if (src.trim()) { setP({ ...p, sourceWeights: { ...p.sourceWeights, [src.trim()]: Number(w) } }); setSrc(""); } }}>{t("הוסף", "Add")}</Button></div>}
      </div>
    </Panel>
  );
}

function SafetyTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [country, setCountry] = useState("");
  useEffect(() => { api.get<{ settings: Settings }>("/api/settings").then((r) => setS(r.settings)).catch((e) => toast.error(e.message)); }, []);
  if (!s) return <Spinner />;
  async function save() { if (!s) return; try { await api.patch("/api/settings", { settings: { dialingPaused: s.dialingPaused, allowedCountries: s.allowedCountries, maxDialsPerMinute: s.maxDialsPerMinute, contactCooldownMinutes: s.contactCooldownMinutes, inbound: s.inbound } }); toast.success(t("נשמר", "Saved")); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("בטיחות, מגבלות ושיחות נכנסות", "Safety, limits and inbound calls")} actions={isAdmin && <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>}>
      <div className="space-y-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.dialingPaused} disabled={!isAdmin} onChange={(e) => setS({ ...s, dialingPaused: e.target.checked })} /> <b>{t("עצירת חיוגים חדשים לכל העסק", "Stop new dials for the entire business")}</b> {t("(kill switch – שיחות פעילות לא נותקות)", "(kill switch – active calls are not disconnected)")}</label>
        <Input label={t("מגבלת חיוגים לנציג לדקה (0 = ללא)", "Dials per agent per minute limit (0 = none)")} type="number" value={String(s.maxDialsPerMinute)} disabled={!isAdmin} onChange={(e) => setS({ ...s, maxDialsPerMinute: Number(e.target.value) })} className="w-48" />
        <Input label={t("חיוג אוטומטי ממתין אחרי שנציג אחר דיבר עם הלקוח (דקות, 0 = כבוי)", "Auto-dial waits after another agent spoke with the person (minutes, 0 = off)")} type="number" value={String(s.contactCooldownMinutes)} disabled={!isAdmin} onChange={(e) => setS({ ...s, contactCooldownMinutes: Number(e.target.value) })} className="w-full sm:w-80" />
        <div>
          <span className="block text-xs text-muted mb-1">{t("מדינות יעד מותרות (ריק = הכול)", "Allowed destination countries (empty = all)")}</span>
          <div className="flex flex-wrap gap-2 mb-2">{s.allowedCountries.map((c) => <Badge key={c} tone="accent">{c} {isAdmin && <button onClick={() => setS({ ...s, allowedCountries: s.allowedCountries.filter((x) => x !== c) })} className="ms-1">×</button>}</Badge>)}</div>
          {isAdmin && <div className="flex gap-2"><Input placeholder="IL" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} className="w-24" ltr /><Button variant="secondary" onClick={() => { if (/^[A-Z]{2}$/.test(country) && !s.allowedCountries.includes(country)) { setS({ ...s, allowedCountries: [...s.allowedCountries, country] }); setCountry(""); } }}>{t("הוסף", "Add")}</Button></div>}
        </div>
        <div className="border-t border-line pt-3 space-y-2">
          <p className="font-medium">{t("שיחות נכנסות", "Inbound calls")}</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.preferOwner} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, preferOwner: e.target.checked } })} /> {t("לנתב קודם לנציג האחראי על הלקוח (אם זמין)", "Route first to the customer's owner agent (if available)")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.createCallbackTask} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, createCallbackTask: e.target.checked } })} /> {t("ליצור משימת חזרה לשיחה נכנסת שלא נענתה", "Create a callback task for an unanswered inbound call")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.inbound.respectDialWindow} disabled={!isAdmin} onChange={(e) => setS({ ...s, inbound: { ...s.inbound, respectDialWindow: e.target.checked } })} /> {t("מחוץ לשעות הפעילות: לא לנתב לנציגים (נרשם כלא נענה)", "Outside business hours: do not route to agents (logged as unanswered)")}</label>
          <p className="text-xs text-muted">{t("ללא נציג זמין השיחה מנותקת ונרשמת. תורים, IVR ותא קולי אינם ממומשים (דורשים הגדרת Telnyx Queues / TeXML והחלטת מוצר).", "With no agent available the call is disconnected and logged. Queues, IVR and voicemail are not implemented (they require Telnyx Queues / TeXML setup and a product decision).")}</p>
        </div>
      </div>
    </Panel>
  );
}

function HistoryTab() {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; action: string; entityType: string; entityId: string; createdAt: string; payload: Record<string, unknown> | null; actor: { fullName: string } | null }>>([]);
  useEffect(() => { api.get<typeof items>("/api/settings/history").then(setItems).catch((e) => toast.error(e.message)); }, []);
  return (
    <Panel title={t("היסטוריית שינויים ואוטומציות", "Change and automation history")}>
      <ul className="divide-y divide-line text-sm">
        {items.map((i) => (
          <li key={i.id} className="py-2">
            <div className="flex items-center gap-2"><Badge tone={i.entityType === "automation" ? "info" : "neutral"}>{i.action}</Badge><span className="text-muted text-xs">{formatDateTime(i.createdAt)} · {i.actor?.fullName ?? t("מערכת", "System")}</span></div>
            {i.payload && <pre className="text-[11px] text-muted mt-1 whitespace-pre-wrap ltr text-left max-h-24 overflow-auto">{JSON.stringify(i.payload, null, 1).slice(0, 600)}</pre>}
          </li>
        ))}
        {items.length === 0 && <li className="py-6 text-center text-muted">{t("אין רשומות", "No records")}</li>}
      </ul>
    </Panel>
  );
}


function AccountPanel() {
  const t = useT();
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [busy, setBusy] = useState(false);
  async function change() {
    if (next.length < 8) { toast.error(t("סיסמה חדשה: לפחות 8 תווים", "New password: at least 8 characters")); return; }
    setBusy(true);
    try { await api.post("/api/auth/password", { currentPassword: current, newPassword: next }); toast.success(t("הסיסמה שונתה. חיבורים אחרים של החשבון נותקו", "Password changed. Other sessions of this account were signed out")); setCurrent(""); setNext(""); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title={t("החשבון שלי – שינוי סיסמה", "My account – change password")} actions={<Button size="sm" disabled={busy || !current || !next} onClick={change} data-testid="account-change-password">{t("שנה סיסמה", "Change password")}</Button>}>
      <p className="text-xs text-muted mb-2">{t("הסיסמה שייכת לחשבון הכניסה שלך בכל העסקים. שינוי מנתק כל חיבור אחר של החשבון.", "The password belongs to your sign-in account across all businesses. Changing it signs out every other session of the account.")}</p>
      <div className="grid md:grid-cols-2 gap-3">
        <Input label={t("סיסמה נוכחית", "Current password")} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input label={t("סיסמה חדשה (8+ תווים)", "New password (8+ characters)")} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
    </Panel>
  );
}

function BusinessTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [b, setB] = useState<{ name: string; timezone: string } | null>(null);
  useEffect(() => { api.get<{ business: { name: string; timezone: string } }>("/api/settings").then((r) => setB(r.business)).catch((e) => toast.error(e.message)); }, []);
  if (!b) return <Spinner />;
  async function save() { if (!b) return; try { await api.patch("/api/settings", { name: b.name, timezone: b.timezone }); toast.success(t("נשמר", "Saved")); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("פרטי העסק", "Business details")} actions={isAdmin && <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>}>
      <div className="grid md:grid-cols-2 gap-3">
        <Input label={t("שם העסק", "Business name")} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} disabled={!isAdmin} />
        <Select label={t("אזור זמן", "Time zone")} value={b.timezone} onChange={(e) => setB({ ...b, timezone: e.target.value })} disabled={!isAdmin}>
          {["Asia/Jerusalem", "Europe/London", "Europe/Berlin", "America/New_York", "UTC"].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
        </Select>
      </div>
      <p className="text-xs text-muted mt-3">{t("אזור הזמן קובע את חלון החיוג, גבולות היום בדוחות ואת הצגת התאריכים. כל התאריכים נשמרים ב-UTC.", "The time zone determines the dialing window, day boundaries in reports and how dates are displayed. All dates are stored in UTC.")}</p>
    </Panel>
  );
}

function ChannelStatus({ channel }: { channel: "sms" | "email" }) {
  const t = useT();
  const [c, setC] = useState<{ provider: string; status: string; sendingBlocked: boolean; simulated: boolean; lastConnectionError: string | null; domainStatus?: string | null } | null | undefined>(undefined);
  useEffect(() => { api.get<{ items: Array<{ provider: string; status: string; sendingBlocked: boolean; simulated: boolean; lastConnectionError: string | null; isActive: boolean; domainStatus?: string | null }> }>(`/api/channels/${channel}`).then((r) => setC(r.items.find((x) => x.isActive) ?? null)).catch(() => setC(null)); }, [channel]);
  if (c === undefined) return <Spinner className="w-4 h-4" />;
  if (!c) return <Badge tone="neutral">{t("לא מחובר", "Not connected")}</Badge>;
  if (c.simulated) return <Badge tone="warn">{t("הדמיה – אין שליחה אמיתית", "Simulation – no real sending")}</Badge>;
  if (c.sendingBlocked || c.status === "error") return <Badge tone="bad">{t("שגיאת חיבור", "Connection error")}</Badge>;
  if (c.status === "connected_not_ready") return <Badge tone="warn">{channel === "email" && c.domainStatus !== "verified" ? t("מחובר – דומיין לא מאומת", "Connected – domain not verified") : t("מחובר – לא מוכן", "Connected – not ready")}</Badge>;
  return <Badge tone="good">{t("מחובר", "Connected")}</Badge>;
}

function ConnectionsTab({ modules }: { modules: Record<string, boolean> }) {
  const t = useT();
  const [wa, setWa] = useState<{ provider: string; configured?: boolean; sendingBlocked?: boolean; phoneNumberId?: string | null; lastConnectionError?: string | null } | null>(null);
  const [waDenied, setWaDenied] = useState(false);
  useEffect(() => { fetch("/api/settings/whatsapp").then((r) => { if (r.status === 403) { setWaDenied(true); return null; } return r.ok ? r.json() : null; }).then((d) => setWa(d ?? null)).catch(() => setWaDenied(true)); }, []);
  return (
    <div className="space-y-4">
      <Panel title={t("ערוצי דיוור", "Messaging channels")}>
        <ul className="text-sm space-y-3">
          <li className="flex flex-wrap items-center gap-2">
            <b>WhatsApp (Meta Cloud API)</b>
            {!modules.messaging ? <Badge tone="neutral">{t("המודול כבוי בחבילה", "Module disabled in plan")}</Badge> : waDenied ? <Badge tone="neutral">{t("פרטי החיבור זמינים לבעלים בלבד", "Connection details are available to the owner only")}</Badge> : wa ? (wa.provider === "mock" ? <Badge tone="warn">{t("מצב הדגמה – אין שליחה אמיתית", "Demo mode – no real sending")}</Badge> : wa.sendingBlocked ? <Badge tone="bad">{t("חסום – בדוק Token", "Blocked – check Token")}</Badge> : <Badge tone="good">{t("מחובר", "Connected")}</Badge>) : <Spinner className="w-4 h-4" />}
            {modules.messaging && <a href="/settings/whatsapp" className="text-accent underline hover:underline ms-auto text-xs">{t("ניהול חיבור וואטסאפ →", "Manage WhatsApp connection →")}</a>}
          </li>
          <li className="flex flex-wrap items-center gap-2"><b>SMS</b>{(modules.sms ?? modules.messaging) ? <ChannelStatus channel="sms" /> : <Badge tone="neutral">{t("המודול כבוי בחבילה", "Module disabled in plan")}</Badge>}{modules.messaging && <a href="/settings/sms" className="text-accent underline hover:underline ms-auto text-xs">{t("ניהול חיבור SMS →", "Manage SMS connection →")}</a>}</li>
          <li className="flex flex-wrap items-center gap-2"><b>{t("אימייל", "Email")}</b>{(modules.email ?? modules.messaging) ? <ChannelStatus channel="email" /> : <Badge tone="neutral">{t("המודול כבוי בחבילה", "Module disabled in plan")}</Badge>}{modules.messaging && <a href="/settings/email" className="text-accent underline hover:underline ms-auto text-xs">{t("ניהול חיבור אימייל →", "Manage email connection →")}</a>}</li>
        </ul>
      </Panel>
      <PaymentSettings />
      {modules.telephony && <TelephonyTab />}
      {modules.telephony && <ProviderRoutingPanel />}
    </div>
  );
}


function AutomationsTab({ isAdmin, messaging }: { isAdmin: boolean; messaging: boolean }) {
  const t = useT();
  const [a, setA] = useState<Automations | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; category: string; status: string }>>([]);
  useEffect(() => {
    api.get<{ settings: Settings }>("/api/settings").then((r) => setA(r.settings.automations)).catch((e) => toast.error(e.message));
    if (messaging) fetch("/api/templates").then((r) => r.ok ? r.json() : { templates: [] }).then((d) => setTemplates((d.templates ?? []).filter((t: { status: string }) => t.status === "APPROVED"))).catch(() => undefined);
  }, [messaging]);
  if (!a) return <Spinner />;
  const outcomes = [["answered_interested", t("ענה – מעוניין", "Answered – interested")], ["answered_not_interested", t("ענה – לא מעוניין", "Answered – not interested")], ["callback", t("לחזור בהמשך", "Call back later")], ["no_answer", t("אין מענה", "No answer")], ["busy", t("תפוס", "Busy")], ["sale", t("בוצעה מכירה", "Sale made")]];
  const toggle = (arr: string[], k: string) => arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k];
  async function save() { if (!a) return; try { await api.patch("/api/settings", { settings: { automations: a } }); toast.success(t("האוטומציות נשמרו", "Automations saved")); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Panel title={t("אוטומציות בין מודולים", "Cross-module automations")} actions={isAdmin && <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>}>
      <div className="space-y-5 text-sm">
        <div>
          <p className="font-medium">{t("ליד חדש → שיוך לנציג + משימת פנייה ראשונית", "New lead → assign to agent + first-contact task")}</p>
          <p className="text-xs text-muted mb-2">{t("ליד ללא נציג משויך לנציג עם הכי מעט לידים פתוחים (או לבעלים של איש הקשר). המשימה נוצרת פעם אחת לכל ליד.", "A lead without an agent is assigned to the agent with the fewest open leads (or to the contact's owner). The task is created once per lead.")}</p>
          <Input label={t("המשימה מגיעה לפירעון תוך (דקות)", "Task due within (minutes)")} type="number" className="w-40" value={String(a.newLeadTaskMinutes)} disabled={!isAdmin} onChange={(e) => setA({ ...a, newLeadTaskMinutes: Number(e.target.value) })} />
        </div>
        <div>
          <p className="font-medium">{t("תוצאת שיחה → משימת מעקב", "Call outcome → follow-up task")}</p>
          <div className="flex flex-wrap gap-3 my-2">{outcomes.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" disabled={!isAdmin} checked={a.followUpTaskOutcomes.includes(k)} onChange={() => setA({ ...a, followUpTaskOutcomes: toggle(a.followUpTaskOutcomes, k) })} /> {l}</label>)}</div>
          <Input label={t("פירעון תוך (שעות)", "Due within (hours)")} type="number" className="w-40" value={String(a.followUpTaskHours)} disabled={!isAdmin} onChange={(e) => setA({ ...a, followUpTaskHours: Number(e.target.value) })} />
          <p className="text-xs text-muted mt-1">{t("בנוסף: \"מעוניין\" מקדם ליד פתוח ל\"מתאים\", \"לא מעוניין\" סוגר אותו, ו\"מכירה\" יוצרת עסקה סגורה ומסמנת את הליד כהומר.", "In addition: \"Interested\" advances an open lead to \"Qualified\", \"Not interested\" closes it, and \"Sale\" creates a closed deal and marks the lead as converted.")}</p>
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-medium">{t("תוצאת שיחה → הודעת המשך ב-WhatsApp", "Call outcome → WhatsApp follow-up message")}</p>
          <p className="text-xs text-muted mb-2">{t("נשלחת רק כאשר קיים ערוץ WhatsApp מחובר, איש הקשר לא הוסר מדיוור, ולתבנית שיווקית – רק עם הסכמה מתועדת. בלי ערוץ מחובר האוטומציה מדלגת ומתעדת זאת.", "Sent only when a WhatsApp channel is connected and the contact has not unsubscribed, and for a marketing template – only with recorded consent. Without a connected channel the automation skips and logs it.")}</p>
          {!messaging && <Badge tone="neutral">{t("מודול הדיוור כבוי", "Messaging module disabled")}</Badge>}
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin || !messaging} checked={a.followUpMessage.enabled} onChange={(e) => setA({ ...a, followUpMessage: { ...a.followUpMessage, enabled: e.target.checked } })} /> {t("מופעל", "Enabled")}</label>
          <Select label={t("תבנית מאושרת", "Approved template")} value={a.followUpMessage.templateId ?? ""} disabled={!isAdmin || !messaging} onChange={(e) => setA({ ...a, followUpMessage: { ...a.followUpMessage, templateId: e.target.value || null } })} className="max-w-sm my-2"><option value="">{t("— בחר תבנית —", "— Select template —")}</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}</Select>
          <div className="flex flex-wrap gap-3">{outcomes.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" disabled={!isAdmin || !messaging} checked={a.followUpMessage.outcomes.includes(k)} onChange={() => setA({ ...a, followUpMessage: { ...a.followUpMessage, outcomes: toggle(a.followUpMessage.outcomes, k) } })} /> {l}</label>)}</div>
        </div>
        <p className="text-xs text-muted border-t border-line pt-3">{t("אוטומציות נוספות מובנות: שיחה שהסתיימה / הודעה נכנסת מעדכנות את ציר הפעילות ומקדמות ליד \"חדש\" ל\"נוצר קשר\"; בקשת הסרה בכל ערוץ חוסמת דיוור שיווקי בכל הערוצים. כל אירוע מעובד פעם אחת לכל מטפל (טבלת automation_jobs) עם ניסיונות חוזרים במקרה כשל זמני.", "Additional built-in automations: an ended call / inbound message updates the activity timeline and advances a \"New\" lead to \"Contacted\"; an unsubscribe request on any channel blocks marketing on all channels. Each event is processed once per handler (automation_jobs table) with retries on temporary failure.")}</p>
      </div>
    </Panel>
  );
}

function MarketingTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [m, setM] = useState<{ window: { start: string; end: string; days: number[] }; maxPerMinute: number; minHoursBetweenMarketing: number } | null>(null);
  const [ret, setRet] = useState<{ messagesDays: number; auditDays: number }>({ messagesDays: 0, auditDays: 0 });
  const [tz, setTz] = useState("");
  useEffect(() => { api.get<{ business: { timezone?: string }; settings: { marketing: { window: { start: string; end: string; days: number[] }; maxPerMinute: number; minHoursBetweenMarketing: number }; retention?: { messagesDays: number; auditDays: number } } }>("/api/settings").then((r) => { setM(r.settings.marketing); setRet(r.settings.retention ?? { messagesDays: 0, auditDays: 0 }); setTz(r.business.timezone ?? ""); }).catch((e) => toast.error(e.message)); }, []);
  if (!m) return <Spinner />;
  const days = t.lang === "en" ? ["S", "M", "T", "W", "T", "F", "S"] : ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
  async function save() {
    try { await api.patch("/api/settings", { settings: { marketing: m, retention: ret } }); toast.success(t("נשמר", "Saved")); } catch (e) { toast.error((e as Error).message); }
  }
  return (<>
    <Panel title={t("שמירה ומחיקת מידע", "Data retention and deletion")} className="mb-4">
      <p className="text-xs text-muted mb-3">{t("מדיניות שמירה לעסק: תוכן הודעות וקבצים מצורפים ישנים נמחקים בעבודת רקע יומית (השיחות, הספירות ויומן הביקורת של המחיקה נשמרים). 0 = לשמור לתמיד. המחיקה אינה הפיכה.", "Business retention policy: old message content and attachments are deleted by a daily background job (conversations, counts and the deletion audit log are kept). 0 = keep forever. Deletion is irreversible.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label={t("מחיקת תוכן הודעות ומדיה אחרי (ימים)", "Delete message content and media after (days)")} type="number" value={String(ret.messagesDays)} onChange={(e) => setRet({ ...ret, messagesDays: Number(e.target.value) })} disabled={!isAdmin} />
        <Input label={t("מחיקת יומן ביקורת אחרי (ימים)", "Delete audit log after (days)")} type="number" value={String(ret.auditDays)} onChange={(e) => setRet({ ...ret, auditDays: Number(e.target.value) })} disabled={!isAdmin} />
      </div>
    </Panel>
    <Panel title={t("דיוור – חלון שליחה, קצב ותדירות (כל הערוצים)", "Marketing – sending window, rate and frequency (all channels)")}>
      <p className="text-xs text-muted mb-3">{t(`קמפיינים שיווקיים ורצפים בכל הערוצים נשלחים רק בתוך חלון השליחה (באזור הזמן של העסק${tz ? `: ${tz}` : ""}). מגבלת התדירות משותפת לכל הערוצים כולל WhatsApp.`, `Marketing campaigns and sequences on all channels are sent only within the sending window (in the business time zone${tz ? `: ${tz}` : ""}). The frequency cap is shared across all channels including WhatsApp.`)}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label={t("תחילת חלון (HH:MM)", "Window start (HH:MM)")} value={m.window.start} onChange={(e) => setM({ ...m, window: { ...m.window, start: e.target.value } })} disabled={!isAdmin} ltr />
        <Input label={t("סוף חלון (HH:MM)", "Window end (HH:MM)")} value={m.window.end} onChange={(e) => setM({ ...m, window: { ...m.window, end: e.target.value } })} disabled={!isAdmin} ltr />
        <div><span className="text-xs text-muted">{t("ימים", "Days")}</span><div className="flex gap-1 mt-1">{days.map((d, i) => <button key={i} type="button" disabled={!isAdmin} onClick={() => setM({ ...m, window: { ...m.window, days: m.window.days.includes(i) ? m.window.days.filter((x) => x !== i) : [...m.window.days, i].sort() } })} className={cx("h-8 w-8 rounded border text-sm", m.window.days.includes(i) ? "bg-accent text-white" : "text-muted")}>{d}</button>)}</div></div>
        <Input label={t("מקסימום נמענים לדקה (0 = ללא הגבלה)", "Max recipients per minute (0 = unlimited)")} type="number" value={String(m.maxPerMinute)} onChange={(e) => setM({ ...m, maxPerMinute: Number(e.target.value) })} disabled={!isAdmin} />
        <Input label={t("שעות מינימום בין הודעות שיווקיות לאותו נמען", "Minimum hours between marketing messages to the same recipient")} type="number" value={String(m.minHoursBetweenMarketing)} onChange={(e) => setM({ ...m, minHoursBetweenMarketing: Number(e.target.value) })} disabled={!isAdmin} hint={t("נאכף כיום ב-24 שעות בכל הערוצים; ערך גבוה יותר מחמיר את בדיקת הזכאות בסיכום הקמפיין", "Currently enforced at 24 hours on all channels; a higher value tightens the eligibility check in the campaign summary")} />
      </div>
      {isAdmin && <Button className="mt-3" onClick={save}>{t("שמור", "Save")}</Button>}
    </Panel>
  </>);
}

function SuppressionsTab() {
  const t = useT();
  const [items, setItems] = useState<Array<{ id: string; identifier: string; identifierType: string; scope: string; source: string; reason: string | null; createdAt: string; pendingReview: boolean; contact: { id: string; fullName: string } | null; createdBy: { fullName: string } | null }>>([]);
  const [pending, setPending] = useState(0);
  const [bySource, setBySource] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => api.get<{ items: typeof items; pending: number; bySource: Record<string, number> }>(`/api/suppressions${qs({ q, review: onlyReview ? "1" : undefined })}`).then((r) => { setItems(r.items); setPending(r.pending); setBySource(r.bySource); }).catch((e) => toast.error(e.message)), [q, onlyReview]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  async function review(id: string, action: "confirm" | "dismiss") {
    try { await api.post(`/api/suppressions/${id}/review`, { action, note: note[id] ?? "" }); toast.success(action === "confirm" ? t("ההסרה אושרה", "Unsubscribe confirmed") : t("הבקשה נדחתה והדיוור שוחרר", "Request dismissed and messaging released")); load(); } catch (e) { toast.error((e as Error).message); }
  }
  const SOURCE: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: t("אימייל", "Email"), manual: t("נציג", "Agent"), import: t("ייבוא", "Import"), phone: t("טלפון", "Phone"), api: "API" };
  return (
    <Panel title={t("הסרות מדיוור (מקור אמת גלובלי)", "Unsubscribes (global source of truth)")}>
      <p className="text-xs text-muted mb-3">{t("כל בקשת הסרה מ-WhatsApp, SMS, אימייל, נציג או ייבוא חוסמת דיוור שיווקי בכל הערוצים לכל הטלפונים והאימיילים של איש הקשר. היקף \"לא ליצור קשר\" חוסם גם הודעות שירות ושיחות יוצאות. חזרה לדיוור נעשית מכרטיס הלקוח עם תיעוד הסכמה. ייבוא מחדש, החלפת ספק או שולח אינם מבטלים חסימה.", "Any unsubscribe request from WhatsApp, SMS, email, an agent or an import blocks marketing on all channels for all of the contact's phones and emails. The \"Do not contact\" scope also blocks service messages and outbound calls. Re-subscribing is done from the customer card with recorded consent. Re-importing, or switching provider or sender, does not lift a block.")}</p>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        {Object.entries(bySource).map(([s, n]) => <Badge key={s} tone="neutral">{SOURCE[s] ?? s}: {n}</Badge>)}
        {pending > 0 && <Badge tone="warn">{t("ממתינות לבדיקה:", "Pending review:")} {pending}</Badge>}
        <label className="flex items-center gap-1 ms-auto"><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />{t("רק בקשות לבדיקה", "Only requests for review")}</label>
      </div>
      <Input placeholder={t("חיפוש לפי טלפון / אימייל", "Search by phone / email")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 max-w-sm" />
      <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8 font-medium">{t("מזהה", "Identifier")}</th><th className="text-start font-medium">{t("איש קשר", "Contact")}</th><th className="text-start font-medium">{t("היקף", "Scope")}</th><th className="text-start font-medium">{t("מקור", "Source")}</th><th className="text-start font-medium">{t("סיבה", "Reason")}</th><th className="text-start font-medium">{t("מועד", "Date")}</th></tr></thead>
        <tbody className="divide-y divide-line">{items.map((s) => <tr key={s.id} className={s.pendingReview ? "bg-amber-500/5" : ""}><td className="h-9"><Phone value={s.identifierType === "phone" ? formatPhone(s.identifier) : s.identifier} /></td><td>{s.contact ? <a href={`/contacts/${s.contact.id}`} className="hover:underline">{s.contact.fullName}</a> : "—"}</td><td>{s.pendingReview ? <Badge tone="warn">{t("ממתין לבדיקה", "Pending review")}</Badge> : s.scope === "all" ? <Badge tone="bad">{t("לא ליצור קשר", "Do not contact")}</Badge> : <Badge tone="warn">{t("שיווקי", "Marketing")}</Badge>}</td><td className="text-muted">{SOURCE[s.source] ?? s.source}</td><td className="text-muted max-w-xs"><div className="truncate">{s.reason ?? "—"}</div>{s.pendingReview && <div className="mt-1 flex flex-wrap items-center gap-1"><Input placeholder={t("נימוק", "Reason")} value={note[s.id] ?? ""} onChange={(e) => setNote({ ...note, [s.id]: e.target.value })} className="h-7 w-40" /><Button size="sm" onClick={() => review(s.id, "confirm")}>{t("אשר הסרה", "Confirm unsubscribe")}</Button><Button size="sm" variant="ghost" onClick={() => review(s.id, "dismiss")}>{t("לא בקשת הסרה", "Not an unsubscribe request")}</Button></div>}</td><td className="text-muted text-xs tabular">{formatDateTime(s.createdAt)} · {s.createdBy?.fullName ?? t("מערכת", "System")}</td></tr>)}
        {items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted">{t("אין הסרות פעילות", "No active unsubscribes")}</td></tr>}</tbody></table>
    </Panel>
  );
}
