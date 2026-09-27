"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";

interface Settings { enabled: boolean; paused: boolean; daily: { enabled: boolean; time: string; days: number[] }; weekly: { enabled: boolean; day: number; time: string }; untreatedAlert: { enabled: boolean; minutes: number }; salesGoal: { enabled: boolean; period: "day" | "month"; amount: number }; recipients: string[]; templateId: string | null }
interface Link { id: string; userId: string; user: string | null; role: string | null; phone: string; status: "pending" | "active" | "revoked"; scope: "business" | "own"; verifiedAt: string | null; lastInboundAt: string | null; codeExpiresAt: string | null; windowOpen: boolean; hasPendingReport: boolean }
interface Data { connection: { provider: string; simulated: boolean; phone: string | null; name: string | null } | null; mode: "llm" | "rules"; timezone: string; settings: Settings; canEditSettings: boolean; links: Link[]; templates: Array<{ id: string; name: string; status: string; variables: string[] }>; users: Array<{ id: string; fullName: string; role: string }> }
interface LogRow { id: string; direction: "in" | "out"; text: string; intent: string | null; tools: Array<{ name: string; ok: boolean; ms: number; error?: string }>; status: string; error: string | null; model: string | null; latencyMs: number | null; createdAt: string; user: string | null; phoneLast4: string | null }

const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const STATUS: Record<Link["status"], [string, "good" | "warn" | "neutral"]> = { active: ["מאומת", "good"], pending: ["ממתין לאימות", "warn"], revoked: ["בוטל", "neutral"] };
const TPL_STATUS: Record<string, string> = { APPROVED: "מאושרת", PENDING: "ממתינה לאישור", REJECTED: "נדחתה", DRAFT: "טיוטה", PAUSED: "מושהית", DISABLED: "מושבתת" };

/** Settings tab "העוזר האישי בוואטסאפ": connection, activation, verified phones, schedules, test, simulation and log. */
export function AssistantSettings({ isOwner }: { isOwner: boolean }) {
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
    try { const r = await api.patch<{ settings: Settings }>("/api/assistant", patch); setS(r.settings); setData((d) => d && { ...d, settings: r.settings }); toast.success("נשמר"); }
    catch (e) { setS(prev); toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!data || !s) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const ro = !data.canEditSettings;
  const active = data.links.filter((l) => l.status === "active");

  return (
    <div className="space-y-4" data-testid="assistant-settings">
      <Panel title="העוזר האישי בוואטסאפ">
        <p className="text-sm text-muted mb-3">שאלו בוואטסאפ בעברית חופשית (&quot;איך הולך היום?&quot;, &quot;כמה דנה מכרה השבוע?&quot;) וקבלו נתונים אמיתיים מה-CRM. העוזר קורא בלבד – הוא לא משנה לידים, לא מחייג ולא שולח הודעות ללקוחות.</p>
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border border-line p-3" data-testid="assistant-connection"><div className="text-xs text-muted mb-1">חיבור WhatsApp</div>
            {data.connection ? <><Badge tone={data.connection.simulated ? "warn" : "good"} dot>{data.connection.simulated ? "מצב דמו (סימולציה) – אין חיבור WhatsApp אמיתי" : "מחובר"}</Badge><div className="mt-1 ltr text-start">{data.connection.phone ?? ""}</div></> : <Badge tone="bad" dot>לא מחובר – חברו WhatsApp בלשונית &quot;חיבורים&quot;</Badge>}</div>
          <div className="rounded-lg border border-line p-3"><div className="text-xs text-muted mb-1">מנוע</div><Badge tone={data.mode === "llm" ? "good" : "neutral"}>{data.mode === "llm" ? "AI (שפה חופשית)" : "בסיסי (זיהוי שאלות נפוצות)"}</Badge></div>
          <div className="rounded-lg border border-line p-3"><div className="text-xs text-muted mb-1">אזור זמן העסק</div><div className="ltr text-start">{data.timezone}</div></div>
        </div>
        <div className="flex flex-wrap gap-4 mt-4 items-center">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} disabled={ro || saving} onChange={(e) => save({ enabled: e.target.checked })} data-testid="assistant-enabled" /> העוזר פעיל</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.paused} disabled={ro || saving} onChange={(e) => save({ paused: e.target.checked })} data-testid="assistant-paused" /> השהה דוחות והתראות</label>
          {ro && <span className="text-xs text-muted">רק בעל העסק יכול לשנות הגדרות</span>}
        </div>
      </Panel>

      <LinksPanel data={data} isOwner={isOwner} reload={load} />

      <Panel title="דוחות והתראות יזומים">
        <div className="space-y-4 text-sm">
          <Row label="סיכום יומי" on={s.daily.enabled} ro={ro} onToggle={(v) => setS({ ...s, daily: { ...s.daily, enabled: v } })} testid="daily">
            <Input type="time" value={s.daily.time} disabled={ro} onChange={(e) => setS({ ...s, daily: { ...s.daily, time: e.target.value } })} className="w-28" ltr aria-label="שעת הסיכום היומי" data-testid="assistant-daily-time" />
            <div className="flex gap-1">{DAYS.map((d, i) => <button key={i} type="button" disabled={ro} onClick={() => setS({ ...s, daily: { ...s.daily, days: s.daily.days.includes(i) ? s.daily.days.filter((x) => x !== i) : [...s.daily.days, i].sort() } })} className={cx("h-8 w-8 rounded-md border text-xs", s.daily.days.includes(i) ? "border-accent bg-accent text-white" : "border-line text-muted")} aria-pressed={s.daily.days.includes(i)}>{d}</button>)}</div>
          </Row>
          <Row label="סיכום שבועי (7 הימים האחרונים)" on={s.weekly.enabled} ro={ro} onToggle={(v) => setS({ ...s, weekly: { ...s.weekly, enabled: v } })} testid="weekly">
            <Select value={String(s.weekly.day)} disabled={ro} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, day: Number(e.target.value) } })} className="w-28" aria-label="יום הסיכום השבועי">{DAYS.map((d, i) => <option key={i} value={i}>יום {d}</option>)}</Select>
            <Input type="time" value={s.weekly.time} disabled={ro} onChange={(e) => setS({ ...s, weekly: { ...s.weekly, time: e.target.value } })} className="w-28" ltr aria-label="שעת הסיכום השבועי" />
          </Row>
          <Row label="התראה על לידים בלי טיפול" on={s.untreatedAlert.enabled} ro={ro} onToggle={(v) => setS({ ...s, untreatedAlert: { ...s.untreatedAlert, enabled: v } })} testid="untreated">
            <span>אחרי</span><Input type="number" min={5} value={String(s.untreatedAlert.minutes)} disabled={ro} onChange={(e) => setS({ ...s, untreatedAlert: { ...s.untreatedAlert, minutes: Math.max(5, Number(e.target.value) || 5) } })} className="w-24" ltr aria-label="דקות עד התראה" data-testid="assistant-untreated-minutes" /><span>דקות</span>
          </Row>
          <Row label="התראת יעד מכירות" on={s.salesGoal.enabled} ro={ro} onToggle={(v) => setS({ ...s, salesGoal: { ...s.salesGoal, enabled: v } })} testid="goal">
            <Select value={s.salesGoal.period} disabled={ro} onChange={(e) => setS({ ...s, salesGoal: { ...s.salesGoal, period: e.target.value as "day" | "month" } })} className="w-28" aria-label="תקופת היעד"><option value="day">יומי</option><option value="month">חודשי</option></Select>
            <span>₪</span><Input type="number" min={0} value={String(s.salesGoal.amount)} disabled={ro} onChange={(e) => setS({ ...s, salesGoal: { ...s.salesGoal, amount: Math.max(0, Number(e.target.value) || 0) } })} className="w-32" ltr aria-label="סכום היעד" />
          </Row>
          <div>
            <div className="font-medium mb-1">מי מקבל</div>
            {active.length ? <div className="flex flex-wrap gap-3">{active.map((l) => <label key={l.id} className="flex items-center gap-1.5"><input type="checkbox" disabled={ro} checked={s.recipients.includes(l.id)} onChange={(e) => setS({ ...s, recipients: e.target.checked ? [...s.recipients, l.id] : s.recipients.filter((x) => x !== l.id) })} />{l.user} <span className="ltr text-muted">…{l.phone.slice(-4)}</span></label>)}</div> : <p className="text-muted text-xs">אין עדיין מספרים מאומתים.</p>}
            <p className="text-xs text-muted mt-1">לא סומן אף אחד = כל המספרים המאומתים עם גישה לכל העסק.</p>
          </div>
          <div>
            <Select label="תבנית לשליחה מחוץ לחלון 24 השעות" value={s.templateId ?? ""} disabled={ro} onChange={(e) => setS({ ...s, templateId: e.target.value || null })} data-testid="assistant-template">
              <option value="">ללא – דוח ימתין עד שתכתבו לעוזר</option>
              {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {TPL_STATUS[t.status] ?? t.status}</option>)}
            </Select>
            <p className="text-xs text-muted mt-1">וואטסאפ מאפשר הודעה חופשית רק תוך 24 שעות מההודעה האחרונה שלכם. מחוץ לחלון נשלחת תבנית מאושרת בלבד (עם משתנה אחד לכותרת), והדוח המלא נשלח ברגע שתשיבו. תבנית שאינה מאושרת לא תישלח.</p>
            {s.templateId && data.templates.find((t) => t.id === s.templateId)?.status !== "APPROVED" && <p className="text-xs text-warn mt-1">⚠️ התבנית שנבחרה עדיין לא מאושרת – דוחות מחוץ לחלון לא יישלחו עד לאישור.</p>}
          </div>
          {!ro && <div className="flex justify-end"><Button onClick={() => save({ daily: s.daily, weekly: s.weekly, untreatedAlert: s.untreatedAlert, salesGoal: s.salesGoal, recipients: s.recipients, templateId: s.templateId })} loading={saving} data-testid="assistant-save">שמור דוחות והתראות</Button></div>}
        </div>
      </Panel>

      {data.connection?.simulated !== false && active.length > 0 && <SimulatorPanel links={active} onDone={load} />}

      <Panel title="יומן פעילות" actions={<Button size="sm" variant="ghost" onClick={load}>רענן</Button>}>
        {log.length ? <ul className="divide-y divide-line text-sm max-h-[420px] overflow-auto" data-testid="assistant-log">{log.map((r) => (
          <li key={r.id} className="py-2">
            <div className="flex flex-wrap gap-2 items-center text-xs text-muted"><span>{formatDateTime(r.createdAt)}</span><span>{r.direction === "in" ? `⬅️ ${r.user ?? ""} …${r.phoneLast4 ?? ""}` : "➡️ העוזר"}</span>{r.intent && <Badge>{r.intent}</Badge>}{r.status !== "ok" && <Badge tone={r.status === "error" || r.status === "failed" ? "bad" : "warn"}>{r.status}</Badge>}{r.model && <span className="ltr">{r.model}</span>}{r.latencyMs !== null && <span className="ltr">{r.latencyMs}ms</span>}</div>
            <div className="whitespace-pre-wrap mt-0.5 line-clamp-4">{r.text}</div>
            {Array.isArray(r.tools) && r.tools.length > 0 && <div className="text-[11px] text-muted mt-0.5 ltr text-start">🔧 {r.tools.map((t) => `${t.name}${t.ok ? "" : " ✗"} ${t.ms}ms`).join(" · ")}</div>}
            {r.error && <div className="text-[11px] text-bad">{r.error}</div>}
          </li>))}</ul> : <p className="text-sm text-muted">אין פעילות עדיין.</p>}
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
    if (!window.confirm(`לבטל מיד את הגישה של ${l.phone}?`)) return;
    try { await api.delete(`/api/assistant/links/${l.id}`); toast.success("הגישה בוטלה"); await reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function test(l: Link) {
    try {
      const r = await api.post<{ status: string; detail?: string }>(`/api/assistant/links/${l.id}/test`, {});
      if (r.status === "sent") toast.success("הודעת בדיקה נשלחה"); else if (r.status === "template") toast.success(`נשלחה תבנית (${r.detail}) – מחוץ לחלון 24 השעות`); else toast.error(`לא נשלח: ${r.detail ?? r.status}`);
      await reload();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <Panel title="מספרים מורשים">
      <p className="text-xs text-muted mb-3">רק מספר שאומת מתוך חשבון מחובר מקבל נתונים. אחרי ההוספה יוצג קוד חד-פעמי (תקף 15 דקות) שיש לשלוח <b>מהטלפון הזה</b> למספר הוואטסאפ של העסק. הודעה ממספר לא מאומת מטופלת כמו לקוח רגיל.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input label="מספר טלפון אישי" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" ltr className="w-48" data-testid="assistant-phone" />
        {isOwner && <Select label="שייך למשתמש" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-48" data-testid="assistant-user"><option value="">אני</option>{data.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
        {targetRole !== "agent" && <Select label="הרשאה" value={scope} onChange={(e) => setScope(e.target.value as "business" | "own")} className="w-56" data-testid="assistant-scope"><option value="business">כל מה שהמשתמש רשאי לראות</option><option value="own">רק הנתונים האישיים שלו</option></Select>}
        <Button onClick={create} loading={busy} disabled={phone.trim().length < 6} data-testid="assistant-add">הוסף ושלח קוד</Button>
      </div>
      {targetRole === "agent" && <p className="text-xs text-muted mt-1">נציג רואה רק את הנתונים שלו.</p>}
      {issued && <div className="mt-3 rounded-lg border border-accent p-3 text-sm" data-testid="assistant-code-box">
        <div>קוד אימות עבור <span className="ltr">{issued.phone}</span>:</div>
        <div className="text-2xl font-semibold tracking-[0.3em] ltr text-start my-1" data-testid="assistant-code">{issued.code}</div>
        <div className="text-xs text-muted">שלחו את הקוד בוואטסאפ מהטלפון הזה אל מספר העסק{issued.businessNumber ? <> <span className="ltr">{issued.businessNumber}</span></> : ""}. הקוד מוצג פעם אחת ותקף עד {issued.expires ? formatDateTime(issued.expires) : "15 דקות"}.</div>
      </div>}
      <table className="w-full text-sm mt-4" data-testid="assistant-links"><thead className="text-xs text-muted"><tr><th className="text-start font-medium h-8">משתמש</th><th className="text-start font-medium">טלפון</th><th className="text-start font-medium">הרשאה</th><th className="text-start font-medium">סטטוס</th><th className="text-start font-medium">חלון 24ש׳</th><th></th></tr></thead>
        <tbody className="divide-y divide-line">{data.links.length ? data.links.map((l) => (
          <tr key={l.id} data-testid={`assistant-link-${l.id}`}><td className="h-10">{l.user}</td><td className="ltr text-start">{l.phone}</td><td>{l.scope === "own" ? "נתונים אישיים" : "לפי הרשאות המשתמש"}</td><td><Badge tone={STATUS[l.status][1]} dot>{STATUS[l.status][0]}</Badge></td><td className="text-xs">{l.status === "active" ? (l.windowOpen ? "פתוח" : "סגור") : "—"}{l.hasPendingReport ? " · דוח ממתין" : ""}</td>
            <td className="text-end whitespace-nowrap">{l.status === "active" && <Button size="sm" variant="ghost" onClick={() => test(l)} data-testid="assistant-test">הודעת בדיקה</Button>}{l.status !== "active" && <Button size="sm" variant="ghost" onClick={() => newCode(l)}>קוד חדש</Button>}{l.status !== "revoked" && <Button size="sm" variant="ghost" onClick={() => revoke(l)} data-testid="assistant-revoke">בטל גישה</Button>}</td></tr>
        )) : <tr><td colSpan={6} className="py-3 text-muted">עוד לא חוברו מספרים.</td></tr>}</tbody></table>
    </Panel>
  );
}

function SimulatorPanel({ links, onDone }: { links: Link[]; onDone: () => Promise<void> }) {
  const [linkId, setLinkId] = useState(links[0]?.id ?? "");
  const [text, setText] = useState("איך הולך היום?");
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
    <Panel title="סימולציה (מצב דמו)">
      <p className="text-xs text-muted mb-2">אין חיבור WhatsApp אמיתי – כאן אפשר לבדוק את העוזר בדיוק כאילו נשלחה הודעה מהטלפון המאומת.</p>
      <Select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="w-64 mb-2" aria-label="בחר מספר">{links.map((l) => <option key={l.id} value={l.id}>{l.user} · …{l.phone.slice(-4)}</option>)}</Select>
      <div className="rounded-lg border border-line bg-muted-bg p-3 h-72 overflow-auto space-y-2" data-testid="assistant-sim-chat">
        {chat.map((m, i) => <div key={i} data-testid="assistant-sim-msg" className={cx("max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap", m.from === "me" ? "bg-white border border-line ms-auto" : "bg-[#dcf8c6] text-black")}>{m.text}</div>)}
        <div ref={end} />
      </div>
      <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="כתבו שאלה…" className="flex-1" data-testid="assistant-sim-input" />
        <Button type="submit" loading={busy} data-testid="assistant-sim-send">שלח</Button>
      </form>
    </Panel>
  );
}
