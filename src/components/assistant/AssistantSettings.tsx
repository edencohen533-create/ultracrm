"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

interface Settings { enabled: boolean; paused: boolean; daily: { enabled: boolean; time: string; days: number[] }; weekly: { enabled: boolean; day: number; time: string }; untreatedAlert: { enabled: boolean; minutes: number }; salesGoal: { enabled: boolean; period: "day" | "month"; amount: number }; recipients: string[]; templateId: string | null }
interface Link { id: string; userId: string; user: string | null; role: string | null; phone: string; status: "pending" | "active" | "revoked"; scope: "business" | "own"; verifiedAt: string | null; lastInboundAt: string | null; codeExpiresAt: string | null; windowOpen: boolean; hasPendingReport: boolean }
interface Data { connection: { provider: string; simulated: boolean; phone: string | null; name: string | null } | null; mode: "llm" | "rules"; timezone: string; settings: Settings; canEditSettings: boolean; links: Link[]; templates: Array<{ id: string; name: string; status: string; variables: string[] }>; users: Array<{ id: string; fullName: string; role: string }> }
interface LogRow { id: string; direction: "in" | "out"; text: string; intent: string | null; tools: Array<{ name: string; ok: boolean; ms: number; error?: string }>; status: string; error: string | null; model: string | null; latencyMs: number | null; createdAt: string; user: string | null; phoneLast4: string | null }

const DAYS: Array<[string, string]> = [["א׳", "Sun"], ["ב׳", "Mon"], ["ג׳", "Tue"], ["ד׳", "Wed"], ["ה׳", "Thu"], ["ו׳", "Fri"], ["ש׳", "Sat"]];
const STATUS: Record<Link["status"], [string, "good" | "warn" | "neutral", string]> = { active: ["מאומת", "good", "Verified"], pending: ["ממתין לאימות", "warn", "Pending verification"], revoked: ["בוטל", "neutral", "Revoked"] };
const TPL_STATUS: Record<string, [string, string]> = { APPROVED: ["מאושרת", "Approved"], PENDING: ["ממתינה לאישור", "Pending approval"], REJECTED: ["נדחתה", "Rejected"], DRAFT: ["טיוטה", "Draft"], PAUSED: ["מושהית", "Paused"], DISABLED: ["מושבתת", "Disabled"] };

/** Settings tab "העוזר האישי בוואטסאפ": connection, activation, verified phones, schedules, test, simulation and log. */
export function AssistantSettings({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const [data, setData] = useState<Data | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const load = useCallback(async () => {
    try { const d = await api.get<Data>("/api/assistant"); setData(d); setS(d.settings); setLog((await api.get<{ items: LogRow[] }>("/api/assistant/log")).items); }
    catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(patch: Partial<Settings>) {
    const prev = s; setSaving(true);
    setS((cur) => cur && { ...cur, ...patch }); // optimistic: toggles flip immediately, rolled back on error
    try { const r = await api.patch<{ settings: Settings }>("/api/assistant", patch); setS(r.settings); setData((d) => d && { ...d, settings: r.settings }); toast.success(t("נשמר", "Saved")); }
    catch (e) { setS(prev); toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!data || !s) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const ro = !data.canEditSettings;
  const active = data.links.filter((l) => l.status === "active");

  return (
    <div className="space-y-4" data-testid="assistant-settings">
      <Panel title={t("העוזר האישי בוואטסאפ", "WhatsApp personal assistant")}>
        <p className="text-sm text-muted mb-3">{t("שאלו בוואטסאפ בעברית חופשית (\"איך הולך היום?\", \"כמה דנה מכרה השבוע?\") וקבלו נתונים אמיתיים מה-CRM. העוזר קורא בלבד – הוא לא משנה לידים, לא מחייג ולא שולח הודעות ללקוחות.", "Ask on WhatsApp in plain language (\"How's today going?\", \"How much did Dana sell this week?\") and get real data from the CRM. The assistant is read-only – it doesn't change leads, place calls or message customers.")}</p>
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border border-line p-3" data-testid="assistant-connection"><div className="text-xs text-muted mb-1">{t("חיבור WhatsApp", "WhatsApp connection")}</div>
            {data.connection ? <><Badge tone={data.connection.simulated ? "warn" : "good"} dot>{data.connection.simulated ? t("מצב דמו (סימולציה) – אין חיבור WhatsApp אמיתי", "Demo mode (simulation) – no real WhatsApp connection") : t("מחובר", "Connected")}</Badge><div className="mt-1 ltr text-start">{data.connection.phone ?? ""}</div></> : <Badge tone="bad" dot>{t("לא מחובר – חברו WhatsApp בלשונית \"חיבורים\"", "Not connected – connect WhatsApp in the \"Connections\" tab")}</Badge>}</div>
          <div className="rounded-lg border border-line p-3"><div className="text-xs text-muted mb-1">{t("מנוע", "Engine")}</div><Badge tone={data.mode === "llm" ? "good" : "neutral"}>{data.mode === "llm" ? t("AI (שפה חופשית)", "AI (natural language)") : t("בסיסי (זיהוי שאלות נפוצות)", "Basic (common question matching)")}</Badge></div>
          <div className="rounded-lg border border-line p-3"><div className="text-xs text-muted mb-1">{t("אזור זמן העסק", "Business time zone")}</div><div className="ltr text-start">{data.timezone}</div></div>
        </div>
        <div className="flex flex-wrap gap-4 mt-4 items-center">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} disabled={ro || saving} onChange={(e) => save({ enabled: e.target.checked })} data-testid="assistant-enabled" /> {t("העוזר פעיל", "Assistant active")}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.paused} disabled={ro || saving} onChange={(e) => save({ paused: e.target.checked })} data-testid="assistant-paused" /> {t("השהה דוחות והתראות", "Pause reports and alerts")}</label>
          {ro && <span className="text-xs text-muted">{t("רק בעל העסק יכול לשנות הגדרות", "Only the business owner can change settings")}</span>}
        </div>
      </Panel>

      <LinksPanel data={data} isOwner={isOwner} reload={load} />

      <Panel title={t("דוחות והתראות יזומים", "Scheduled reports and alerts")}>
        <div className="space-y-4 text-sm">
          <Row label={t("סיכום יומי", "Daily summary")} on={s.daily.enabled} ro={ro} onToggle={(v) => setS({ ...s, daily: { ...s.daily, enabled: v } })} testid="daily">
            <Input type="time" value={s.daily.time} disabled={ro} onChange={(e) => setS({ ...s, daily: { ...s.daily, time: e.target.value } })} className="w-28" ltr aria-label={t("שעת הסיכום היומי", "Daily summary time")} data-testid="assistant-daily-time" />
            <div className="flex gap-1">{DAYS.map(([d, dEn], i) => <button key={i} type="button" disabled={ro} onClick={() => setS({ ...s, daily: { ...s.daily, days: s.daily.days.includes(i) ? s.daily.days.filter((x) => x !== i) : [...s.daily.days, i].sort() } })} className={cx("h-8 w-8 rounded-md border text-xs", s.daily.days.includes(i) ? "border-accent bg-accent text-white" : "border-line text-muted")} aria-pressed={s.daily.days.includes(i)}>{t(d, dEn)}</button>)}</div>
          </Row>
          <Row label={t("סיכום שבועי (7 הימים האחרונים)", "Weekly summary (last 7 days)")} on={s.weekly.enabled} ro={ro} onToggle={(v) => setS({ ...s, weekly: { ...s.weekly, enabled: v } })} testid="weekly">
            <Select value={String(s.weekly.day)} disabled={ro} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, day: Number(e.target.value) } })} className="w-28" aria-label={t("יום הסיכום השבועי", "Weekly summary day")}>{DAYS.map(([d, dEn], i) => <option key={i} value={i}>{t(`יום ${d}`, dEn)}</option>)}</Select>
            <Input type="time" value={s.weekly.time} disabled={ro} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, time: e.target.value } })} className="w-28" ltr aria-label={t("שעת הסיכום השבועי", "Weekly summary time")} />
          </Row>
          <Row label={t("התראה על לידים בלי טיפול", "Alert on untreated leads")} on={s.untreatedAlert.enabled} ro={ro} onToggle={(v) => setS({ ...s, untreatedAlert: { ...s.untreatedAlert, enabled: v } })} testid="untreated">
            <span>{t("אחרי", "After")}</span><Input type="number" min={5} value={String(s.untreatedAlert.minutes)} disabled={ro} onChange={(e) => setS({ ...s, untreatedAlert: { ...s.untreatedAlert, minutes: Math.max(5, Number(e.target.value) || 5) } })} className="w-24" ltr aria-label={t("דקות עד התראה", "Minutes until alert")} data-testid="assistant-untreated-minutes" /><span>{t("דקות", "minutes")}</span>
          </Row>
          <Row label={t("התראת יעד מכירות", "Sales goal alert")} on={s.salesGoal.enabled} ro={ro} onToggle={(v) => setS({ ...s, salesGoal: { ...s.salesGoal, enabled: v } })} testid="goal">
            <Select value={s.salesGoal.period} disabled={ro} onChange={(e) => setS({ ...s, salesGoal: { ...s.salesGoal, period: e.target.value as "day" | "month" } })} className="w-28" aria-label={t("תקופת היעד", "Goal period")}><option value="day">{t("יומי", "Daily")}</option><option value="month">{t("חודשי", "Monthly")}</option></Select>
            <span>₪</span><Input type="number" min={0} value={String(s.salesGoal.amount)} disabled={ro} onChange={(e) => setS({ ...s, salesGoal: { ...s.salesGoal, amount: Math.max(0, Number(e.target.value) || 0) } })} className="w-32" ltr aria-label={t("סכום היעד", "Goal amount")} />
          </Row>
          <div>
            <div className="font-medium mb-1">{t("מי מקבל", "Recipients")}</div>
            {active.length ? <div className="flex flex-wrap gap-3">{active.map((l) => <label key={l.id} className="flex items-center gap-1.5"><input type="checkbox" disabled={ro} checked={s.recipients.includes(l.id)} onChange={(e) => setS({ ...s, recipients: e.target.checked ? [...s.recipients, l.id] : s.recipients.filter((x) => x !== l.id) })} />{l.user} <span className="ltr text-muted">…{l.phone.slice(-4)}</span></label>)}</div> : <p className="text-muted text-xs">{t("אין עדיין מספרים מאומתים.", "No verified numbers yet.")}</p>}
            <p className="text-xs text-muted mt-1">{t("לא סומן אף אחד = כל המספרים המאומתים עם גישה לכל העסק.", "None selected = all verified numbers with business-wide access.")}</p>
          </div>
          <div>
            <Select label={t("תבנית לשליחה מחוץ לחלון 24 השעות", "Template for sending outside the 24-hour window")} value={s.templateId ?? ""} disabled={ro} onChange={(e) => setS({ ...s, templateId: e.target.value || null })} data-testid="assistant-template">
              <option value="">{t("ללא – דוח ימתין עד שתכתבו לעוזר", "None – the report waits until you message the assistant")}</option>
              {data.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} · {TPL_STATUS[tpl.status] ? t(TPL_STATUS[tpl.status][0], TPL_STATUS[tpl.status][1]) : tpl.status}</option>)}
            </Select>
            <p className="text-xs text-muted mt-1">{t("וואטסאפ מאפשר הודעה חופשית רק תוך 24 שעות מההודעה האחרונה שלכם. מחוץ לחלון נשלחת תבנית מאושרת בלבד (עם משתנה אחד לכותרת), והדוח המלא נשלח ברגע שתשיבו. תבנית שאינה מאושרת לא תישלח.", "WhatsApp allows free-form messages only within 24 hours of your last message. Outside that window only an approved template is sent (with one variable for the title), and the full report is sent as soon as you reply. A template that isn't approved will not be sent.")}</p>
            {s.templateId && data.templates.find((tpl) => tpl.id === s.templateId)?.status !== "APPROVED" && <p className="text-xs text-warn mt-1">{t("⚠️ התבנית שנבחרה עדיין לא מאושרת – דוחות מחוץ לחלון לא יישלחו עד לאישור.", "⚠️ The selected template isn't approved yet – reports outside the window won't be sent until it is.")}</p>}
          </div>
          {!ro && <div className="flex justify-end"><Button onClick={() => save({ daily: s.daily, weekly: s.weekly, untreatedAlert: s.untreatedAlert, salesGoal: s.salesGoal, recipients: s.recipients, templateId: s.templateId })} loading={saving} data-testid="assistant-save">{t("שמור דוחות והתראות", "Save reports and alerts")}</Button></div>}
        </div>
      </Panel>

      {data.connection?.simulated !== false && active.length > 0 && <SimulatorPanel links={active} onDone={load} />}

      <Panel title={t("יומן פעילות", "Activity log")} actions={<Button size="sm" variant="ghost" onClick={load}>{t("רענן", "Refresh")}</Button>}>
        {log.length ? <ul className="divide-y divide-line text-sm max-h-[420px] overflow-auto" data-testid="assistant-log">{log.map((r) => (
          <li key={r.id} className="py-2">
            <div className="flex flex-wrap gap-2 items-center text-xs text-muted"><span>{formatDateTime(r.createdAt)}</span><span>{r.direction === "in" ? `⬅️ ${r.user ?? ""} …${r.phoneLast4 ?? ""}` : t("➡️ העוזר", "➡️ Assistant")}</span>{r.intent && <Badge>{r.intent}</Badge>}{r.status !== "ok" && <Badge tone={r.status === "error" || r.status === "failed" ? "bad" : "warn"}>{r.status}</Badge>}{r.model && <span className="ltr">{r.model}</span>}{r.latencyMs !== null && <span className="ltr">{r.latencyMs}ms</span>}</div>
            <div className="whitespace-pre-wrap mt-0.5 line-clamp-4">{r.text}</div>
            {Array.isArray(r.tools) && r.tools.length > 0 && <div className="text-[11px] text-muted mt-0.5 ltr text-start">🔧 {r.tools.map((tool) => `${tool.name}${tool.ok ? "" : " ✗"} ${tool.ms}ms`).join(" · ")}</div>}
            {r.error && <div className="text-[11px] text-bad">{r.error}</div>}
          </li>))}</ul> : <p className="text-sm text-muted">{t("אין פעילות עדיין.", "No activity yet.")}</p>}
      </Panel>
    </div>
  );
}

function Row({ label, on, ro, onToggle, testid, children }: { label: string; on: boolean; ro: boolean; onToggle: (v: boolean) => void; testid: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 w-56 font-medium"><input type="checkbox" checked={on} disabled={ro} onChange={(e) => onToggle(e.target.checked)} data-testid={`assistant-${testid}-enabled`} />{label}</label>
      <div className={cx("flex flex-wrap items-center gap-2", !on && "opacity-50")}>{children}</div>
    </div>
  );
}

function LinksPanel({ data, isOwner, reload }: { data: Data; isOwner: boolean; reload: () => Promise<void> }) {
  const t = useT();
  const [phone, setPhone] = useState("");
  const [userId, setUserId] = useState("");
  const [scope, setScope] = useState<"business" | "own">("business");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ code: string; phone: string; businessNumber: string | null; expires: string | null } | null>(null);
  const targetRole = data.users.find((u) => u.id === userId)?.role;

  async function create() {
    setBusy(true);
    try {
      const r = await api.post<{ link: Link; code: string; businessNumber: string | null }>("/api/assistant/links", { phone, ...(userId ? { userId } : {}), scope });
      setIssued({ code: r.code, phone: r.link.phone, businessNumber: r.businessNumber, expires: r.link.codeExpiresAt }); setPhone(""); await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function newCode(l: Link) {
    try { const r = await api.post<{ link: Link; code: string; businessNumber: string | null }>("/api/assistant/links", { phone: l.phone, userId: l.userId, scope: l.scope }); setIssued({ code: r.code, phone: r.link.phone, businessNumber: r.businessNumber, expires: r.link.codeExpiresAt }); await reload(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function revoke(l: Link) {
    if (!window.confirm(t(`לבטל מיד את הגישה של ${l.phone}?`, `Revoke access for ${l.phone} immediately?`))) return;
    try { await api.delete(`/api/assistant/links/${l.id}`); toast.success(t("הגישה בוטלה", "Access revoked")); await reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function test(l: Link) {
    try {
      const r = await api.post<{ status: string; detail?: string }>(`/api/assistant/links/${l.id}/test`, {});
      if (r.status === "sent") toast.success(t("הודעת בדיקה נשלחה", "Test message sent")); else if (r.status === "template") toast.success(t(`נשלחה תבנית (${r.detail}) – מחוץ לחלון 24 השעות`, `Template sent (${r.detail}) – outside the 24-hour window`)); else toast.error(t(`לא נשלח: ${r.detail ?? r.status}`, `Not sent: ${r.detail ?? r.status}`));
      await reload();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <Panel title={t("מספרים מורשים", "Authorized numbers")}>
      <p className="text-xs text-muted mb-3">{t("רק מספר שאומת מתוך חשבון מחובר מקבל נתונים. אחרי ההוספה יוצג קוד חד-פעמי (תקף 15 דקות) שיש לשלוח", "Only a number verified from a signed-in account receives data. After adding it, a one-time code (valid for 15 minutes) is shown – send it")} <b>{t("מהטלפון הזה", "from that phone")}</b> {t("למספר הוואטסאפ של העסק. הודעה ממספר לא מאומת מטופלת כמו לקוח רגיל.", "to the business WhatsApp number. A message from an unverified number is treated like a regular customer.")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input label={t("מספר טלפון אישי", "Personal phone number")} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" ltr className="w-48" data-testid="assistant-phone" />
        {isOwner && <Select label={t("שייך למשתמש", "Assign to user")} value={userId} onChange={(e) => setUserId(e.target.value)} className="w-48" data-testid="assistant-user"><option value="">{t("אני", "Me")}</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
        {targetRole !== "agent" && <Select label={t("הרשאה", "Access")} value={scope} onChange={(e) => setScope(e.target.value as "business" | "own")} className="w-56" data-testid="assistant-scope"><option value="business">{t("כל מה שהמשתמש רשאי לראות", "Everything the user is allowed to see")}</option><option value="own">{t("רק הנתונים האישיים שלו", "Only their own data")}</option></Select>}
        <Button onClick={create} loading={busy} disabled={phone.trim().length < 6} data-testid="assistant-add">{t("הוסף ושלח קוד", "Add and send code")}</Button>
      </div>
      {targetRole === "agent" && <p className="text-xs text-muted mt-1">{t("נציג רואה רק את הנתונים שלו.", "An agent sees only their own data.")}</p>}
      {issued && <div className="mt-3 rounded-lg border border-accent p-3 text-sm" data-testid="assistant-code-box">
        <div>{t("קוד אימות עבור", "Verification code for")} <span className="ltr">{issued.phone}</span>:</div>
        <div className="text-2xl font-semibold tracking-[0.3em] ltr text-start my-1" data-testid="assistant-code">{issued.code}</div>
        <div className="text-xs text-muted">{t("שלחו את הקוד בוואטסאפ מהטלפון הזה אל מספר העסק", "Send this code on WhatsApp from that phone to the business number")}{issued.businessNumber ? <> <span className="ltr">{issued.businessNumber}</span></> : ""}. {t("הקוד מוצג פעם אחת ותקף עד", "The code is shown once and is valid until")} {issued.expires ? formatDateTime(issued.expires) : t("15 דקות", "15 minutes")}.</div>
      </div>}
      <table className="w-full text-sm mt-4" data-testid="assistant-links"><thead className="text-xs text-muted"><tr><th className="text-start font-medium h-8">{t("משתמש", "User")}</th><th className="text-start font-medium">{t("טלפון", "Phone")}</th><th className="text-start font-medium">{t("הרשאה", "Access")}</th><th className="text-start font-medium">{t("סטטוס", "Status")}</th><th className="text-start font-medium">{t("חלון 24ש׳", "24h window")}</th><th></th></tr></thead>
        <tbody className="divide-y divide-line">{data.links.length ? data.links.map((l) => (
          <tr key={l.id} data-testid={`assistant-link-${l.id}`}><td className="h-10">{l.user}</td><td className="ltr text-start">{l.phone}</td><td>{l.scope === "own" ? t("נתונים אישיים", "Own data") : t("לפי הרשאות המשתמש", "Per user permissions")}</td><td><Badge tone={STATUS[l.status][1]} dot>{t(STATUS[l.status][0], STATUS[l.status][2])}</Badge></td><td className="text-xs">{l.status === "active" ? (l.windowOpen ? t("פתוח", "Open") : t("סגור", "Closed")) : "—"}{l.hasPendingReport ? t(" · דוח ממתין", " · report pending") : ""}</td>
            <td className="text-end whitespace-nowrap">{l.status === "active" && <Button size="sm" variant="ghost" onClick={() => test(l)} data-testid="assistant-test">{t("הודעת בדיקה", "Test message")}</Button>}{l.status !== "active" && <Button size="sm" variant="ghost" onClick={() => newCode(l)}>{t("קוד חדש", "New code")}</Button>}{l.status !== "revoked" && <Button size="sm" variant="ghost" onClick={() => revoke(l)} data-testid="assistant-revoke">{t("בטל גישה", "Revoke access")}</Button>}</td></tr>
        )) : <tr><td colSpan={6} className="py-3 text-muted">{t("עוד לא חוברו מספרים.", "No numbers linked yet.")}</td></tr>}</tbody></table>
    </Panel>
  );
}

function SimulatorPanel({ links, onDone }: { links: Link[]; onDone: () => Promise<void> }) {
  const t = useT();
  const [linkId, setLinkId] = useState(links[0]?.id ?? "");
  const [text, setText] = useState(t("איך הולך היום?", "How's today going?"));
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<Array<{ from: "me" | "bot"; text: string }>>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [chat]);
  async function send() {
    if (!text.trim()) return;
    const q = text.trim(); setBusy(true); setChat((c) => [...c, { from: "me", text: q }]); setText("");
    try { const r = await api.post<{ replies: Array<{ text: string }> }>("/api/assistant/simulate", { linkId, text: q }); setChat((c) => [...c, ...r.replies.map((x) => ({ from: "bot" as const, text: x.text }))]); await onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title={t("סימולציה (מצב דמו)", "Simulation (demo mode)")}>
      <p className="text-xs text-muted mb-2">{t("אין חיבור WhatsApp אמיתי – כאן אפשר לבדוק את העוזר בדיוק כאילו נשלחה הודעה מהטלפון המאומת.", "No real WhatsApp connection – test the assistant here exactly as if a message was sent from the verified phone.")}</p>
      <Select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="w-64 mb-2" aria-label={t("בחר מספר", "Select number")}>{links.map((l) => <option key={l.id} value={l.id}>{l.user} · …{l.phone.slice(-4)}</option>)}</Select>
      <div className="rounded-lg border border-line bg-muted-bg p-3 h-72 overflow-auto space-y-2" data-testid="assistant-sim-chat">
        {chat.map((m, i) => <div key={i} data-testid="assistant-sim-msg" className={cx("max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap", m.from === "me" ? "bg-white border border-line ms-auto" : "bg-[#dcf8c6] text-black")}>{m.text}</div>)}
        <div ref={end} />
      </div>
      <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("כתבו שאלה…", "Type a question…")} className="flex-1" data-testid="assistant-sim-input" />
        <Button type="submit" loading={busy} data-testid="assistant-sim-send">{t("שלח", "Send")}</Button>
      </form>
    </Panel>
  );
}
