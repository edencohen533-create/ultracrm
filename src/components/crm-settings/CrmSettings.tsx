"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";
import { agentSettingsSchema, STRATEGIES, type AgentSettings } from "@/lib/agent-settings-schema";

type Data = { limits: { maxAttempts: number; retryIntervalMinutes: number }; target: { id: string; fullName: string }; agents: { id: string; fullName: string }[]; numbers: { id: string; e164: string; label: string | null }[]; settings: AgentSettings; configured: boolean };
const tabs = [{ id: "general", label: "כללי", en: "General" }, { id: "calls", label: "הגדרות שיחה", en: "Call settings" }, { id: "strategy", label: "אסטרטגיית חיוג", en: "Dialing strategy" }] as const;
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="crm-setting-toggle"><input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} /><span className="crm-switch" aria-hidden /><span>{label}</span></label>;
}
export function CrmSettings({ embedded = false, onDirtyChange }: { embedded?: boolean; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const tr = useT();
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [target, setTarget] = useState("");
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("general");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = Boolean(data && draft && JSON.stringify(data.settings) !== JSON.stringify(draft));
  useEffect(() => {
    let active = true;
    api.get<Data>(`/api/crm-settings${target ? `?userId=${encodeURIComponent(target)}` : ""}`).then(d => { if (active) { setData(d); setDraft(d.settings); setError(""); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [target]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change<K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) { setDraft(d => d && ({ ...d, [key]: value })); }
  async function save() {
    if (!draft || !data) return;
    const parsed = agentSettingsSchema.safeParse(draft);
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    setSaving(true);
    try { const settings = await api.put<AgentSettings>("/api/crm-settings", { userId: data.target.id, settings: draft }); setDraft(settings); setData({ ...data, settings, configured: true }); toast.success(tr(`ההגדרות של ${data.target.fullName} נשמרו`, `Settings for ${data.target.fullName} saved`)); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  function schedule(key: "newLead" | "followUp", title: string) {
    if (!draft) return null;
    const rows = draft[key];
    return <section className="crm-retry"><h2>{title}</h2><div className="crm-retry-marker">{tr("0 שיחות", "0 calls")}</div>{rows.map((row, i) => <div key={i} className="crm-retry-stage">
      <div className="crm-retry-range">{tr("בין שיחות:", "Between calls:")} {i ? rows[i - 1].through : 1} – <input aria-label={tr(`${title} עד ניסיון ${i + 1}`, `${title} up to attempt ${i + 1}`)} type="number" min={i ? rows[i - 1].through + 1 : 1} max="50" value={row.through} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, through: Number(e.target.value) } : r))} /></div>
      <div className="crm-retry-delay"><span>{tr("המתנה:", "Wait:")}</span><input type="number" aria-label={tr(`${title} מרווח ${i + 1}`, `${title} interval ${i + 1}`)} min="1" max="168" value={row.delay} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, delay: Number(e.target.value) } : r))} /><select aria-label={tr(`${title} יחידות ${i + 1}`, `${title} units ${i + 1}`)} value={row.unit} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, unit: e.target.value as "hours" | "days" } : r))}><option value="hours">{tr("שעות", "Hours")}</option><option value="days">{tr("ימים", "Days")}</option></select></div>
      <button aria-label={tr(`מחק שלב ${i + 1} ${title}`, `Delete stage ${i + 1} ${title}`)} disabled={rows.length === 1} onClick={() => change(key, rows.filter((_, j) => i !== j))}>×</button>
    </div>)}<button className="crm-add-stage" disabled={rows.length >= 10 || rows.at(-1)!.through >= 50} onClick={() => change(key, [...rows, { through: Math.min(50, rows.at(-1)!.through + 5), delay: 1, unit: "days" }])}>{tr("+ הוספת שלב", "+ Add stage")}</button><div className="crm-retry-marker">{tr(`לאחר ${rows.at(-1)!.through} ניסיונות – הליד יוצא מתור החיוג`, `After ${rows.at(-1)!.through} attempts – the lead leaves the dial queue`)}</div></section>;
  }
  return <div className={embedded ? "crm-settings-embedded" : "crm-settings-page"} dir={tr.dir}><div className="crm-settings-shell">
    <header><div><h1>{embedded ? tr("הגדרות חייגן", "Dialer settings") : tr("הגדרות CRM", "CRM settings")}</h1>{data && <p>{data.target.fullName}</p>}</div>{!embedded && <Link href="/leads" aria-label={tr("סגור הגדרות", "Close settings")} onClick={e => { if (dirty && !window.confirm(tr("לצאת ללא שמירת השינויים?", "Leave without saving changes?"))) e.preventDefault(); }}>×</Link>}</header>
    <div className="crm-settings-agent"><label>{tr("הגדרות עבור", "Settings for")} <select aria-label={tr("הגדרות עבור", "Settings for")} value={data?.target.id ?? ""} disabled={loading || saving} onChange={e => { if (dirty && !window.confirm(tr("להחליף נציג ללא שמירת השינויים?", "Switch agent without saving changes?"))) return; setLoading(true); setTarget(e.target.value); }}>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label><span>{tr("ההגדרות נשמרות בנפרד לכל נציג", "Settings are saved separately for each agent")}</span></div>
    <nav aria-label={tr("לשוניות הגדרות", "Settings tabs")} role="tablist">{tabs.map(t => <button role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} key={t.id} onClick={() => setTab(t.id)}>{tr(t.label, t.en)}</button>)}</nav>
    <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {loading ? <p>{tr("טוען הגדרות…", "Loading settings…")}</p> : error ? <p role="alert">{error}</p> : draft && data && <fieldset disabled={saving}>
        {tab === "general" && <><Toggle label={tr("אפשר לנציג לקבוע פולו־אפים לנציגים אחרים בצוות", "Allow agent to schedule follow-ups for other agents on the team")} checked={draft.assignFollowUps} onChange={v => change("assignFollowUps", v)} /><Toggle label={tr("אפשר לנציג לקחת ידנית פולו־אפים של נציגים אחרים בצוות", "Allow agent to manually take follow-ups from other agents on the team")} checked={draft.takeFollowUps} onChange={v => change("takeFollowUps", v)} />
          <p className="crm-settings-help">{tr("שיוך ולקיחת פולו־אפים זמינים ברשימות משותפות לצוות. הפעולות אינן מעניקות גישה לתיקי לקוחות אחרים.", "Assigning and taking follow-ups is available in team-shared lists. These actions do not grant access to other customer records.")}</p><FollowUps />
          <section className="crm-carousel"><h2>{tr("קרוסלת מספרים (מספר יוצא)", "Number carousel (outbound number)")}</h2><p>{tr("רשימת המספרים:", "Number list:")}</p><div className="crm-number-scroll"><table><thead><tr><th>#</th><th>{tr("סטטוס", "Status")}</th><th>{tr("מספר טלפון", "Phone number")}</th><th>{tr("החלפת מספר", "Replace number")}</th><th /></tr></thead><tbody>{draft.numbers.map((n, i) => { const number = data.numbers.find(x => x.id === n.id); return <tr key={n.id}><td>{i + 1}</td><td><Toggle label={tr(`מספר ${i + 1} פעיל`, `Number ${i + 1} active`)} checked={n.enabled} onChange={v => change("numbers", draft.numbers.map((x, j) => j === i ? { ...x, enabled: v } : x))} /></td><td>{number?.label || tr(`מספר ${i + 1}`, `Number ${i + 1}`)}<small dir="ltr">{number?.e164 || tr("המספר אינו זמין", "Number unavailable")}</small></td><td><select dir="ltr" aria-label={tr(`החלפת מספר ${i + 1}`, `Replace number ${i + 1}`)} value={n.id} onChange={e => change("numbers", draft.numbers.map((x, j) => j === i ? { ...x, id: e.target.value } : x))}>{!number && <option value={n.id}>{tr("בחר מספר חלופי", "Select a replacement number")}</option>}{data.numbers.filter(x => x.id === n.id || !draft.numbers.some(p => p.id === x.id)).map(x => <option key={x.id} value={x.id}>{x.e164}</option>)}</select></td><td><button aria-label={tr(`הסר מספר ${i + 1}`, `Remove number ${i + 1}`)} onClick={() => change("numbers", draft.numbers.filter((_, j) => i !== j))}>×</button></td></tr>; })}</tbody></table></div>
          {!draft.numbers.length && <p className="crm-settings-empty">{tr("ללא קרוסלה אישית – המספר נבחר לפי הגדרות הרשימה והעסק.", "No personal carousel – the number is chosen by the list and business settings.")}</p>}
          <button className="crm-add-number" disabled={!data.numbers.some(x => !draft.numbers.some(n => n.id === x.id))} onClick={() => { const next = data.numbers.find(x => !draft.numbers.some(n => n.id === x.id)); if (next) change("numbers", [...draft.numbers, { id: next.id, enabled: true }]); }}>{tr("＋ הוספת מספר נוסף", "＋ Add another number")}</button>
          <p className="crm-settings-help">{tr("ניתן לבחור מספרים זמינים של העסק. הוספה לקרוסלה אינה רכישת מספר. מספר קבוע שהוגדר ברשימה או נבחר ידנית קודם לקרוסלה האישית.", "You can choose from the business's available numbers. Adding to the carousel does not purchase a number. A fixed number set on the list or chosen manually takes precedence over the personal carousel.")}</p>
          <label className="crm-setting-field">{tr("כל כמה שיחות שלא נענו להחליף מספר?", "Switch number after how many unanswered calls?")}<select value={draft.rotateAfter} onChange={e => change("rotateAfter", Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
          <Toggle label={tr("בחירת מספר אקראי בכל סבב החלפה (כולל שיחה ראשונה)", "Pick a random number on every rotation (including the first call)")} checked={draft.randomRotation} onChange={v => change("randomRotation", v)} />
          <p className="crm-settings-help">{tr("הסבב נפרד לכל נציג ולקוח; ההחלפה מתבצעת לאחר רצף ניסיונות ללא מענה מאותו מספר.", "Rotation is separate for each agent and customer; the switch happens after a run of unanswered attempts from the same number.")}</p></section></>}
        {tab === "calls" && <><label className="crm-setting-field">{tr("מספר ניסיונות חיוג ללא מענה לפני העברה ללא רלוונטי", "Unanswered dial attempts before moving to irrelevant")}<select data-testid="agent-unanswered-limit" value={draft.unansweredToIrrelevant === null || draft.unansweredToIrrelevant === undefined ? "" : String(draft.unansweredToIrrelevant)} onChange={e => change("unansweredToIrrelevant", e.target.value === "" ? null : Number(e.target.value))}><option value="">{tr("לפי הקמפיין / העסק", "Per campaign / business")}</option><option value="0">{tr("כבוי", "Off")}</option>{Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label><label className="crm-setting-field">{tr("מקסימום שיחות אוטומטיות ללא מענה לליד ביום", "Max automatic unanswered calls per lead per day")}<select value={draft.maxDailyUnanswered} onChange={e => change("maxDailyUnanswered", Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>{schedule("newLead", tr("ליד חדש", "New lead"))}{schedule("followUp", "Follow-Up")}<p className="crm-settings-help">{tr(`ברירת המחדל בעסק: עד ${data.limits.maxAttempts} ניסיונות, מרווח ${data.limits.retryIntervalMinutes} דקות. רשימת חיוג יכולה להגדיר מגבלות משלה. מגבלת הניסיונות המחמירה ומרווח ההמתנה הארוך יותר מבין הגדרות הנציג והרשימה חלים בפועל. זמני החזרה נשמרים בתוך שעות החיוג של העסק. מכסה יומית מחושבת לפי אזור הזמן של העסק, גם כשכמה נציגים מטפלים באותו ליד.`, `Business default: up to ${data.limits.maxAttempts} attempts, ${data.limits.retryIntervalMinutes}-minute interval. A dial list can set its own limits. The stricter attempt limit and the longer wait interval between the agent and list settings apply. Retry times are kept within the business dialing hours. The daily quota is calculated in the business time zone, even when several agents handle the same lead.`)}</p></>}
        {tab === "strategy" && <div className="crm-strategies" role="radiogroup" aria-label={tr("אסטרטגיית חיוג", "Dialing strategy")}>{STRATEGIES.map(s => <label key={s.id} className={draft.strategy === s.id ? "selected" : ""}><input type="radio" name="strategy" value={s.id} checked={draft.strategy === s.id} onChange={() => change("strategy", s.id)} /><h2>{s.title}</h2><p>{s.text}</p></label>)}</div>}
      </fieldset>}
    </main><footer><button className="crm-settings-save" disabled={loading || saving || !draft || Boolean(error)} onClick={save}>{saving ? tr("שומר…", "Saving…") : tr("שמירה", "Save")}</button><button disabled={saving || !data || loading} onClick={() => { if (data) setDraft(data.settings); }}>{tr("ביטול שינויים", "Discard changes")}</button></footer>
  </div></div>;
}
function FollowUps() {
  const t = useT();
  const [items, setItems] = useState<{ id: string; name: string; owner: string; due: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() { setBusy(true); try { setItems(await api.get("/api/crm-settings/follow-ups")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function take(id: string) { setBusy(true); try { await api.post("/api/crm-settings/follow-ups", { id }); toast.success(t("הפולו־אפ הועבר אליך", "The follow-up was assigned to you")); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return <div className="crm-follow-ups"><button disabled={busy} onClick={load}>{t("הצג פולו־אפים זמינים עבורי", "Show follow-ups available to me")}</button>{items && !items.length && <p>{t("אין פולו־אפים זמינים ללקיחה", "No follow-ups available to take")}</p>}{items?.map(i => <div key={i.id}><span>{i.name} · {i.owner} {i.due && new Date(i.due).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}</span><button disabled={busy} onClick={() => take(i.id)}>{t("לקיחה לטיפולי", "Take it")}</button></div>)}</div>;
}
