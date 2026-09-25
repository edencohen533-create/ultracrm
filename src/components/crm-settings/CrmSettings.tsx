"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { agentSettingsSchema, STRATEGIES, type AgentSettings } from "@/lib/agent-settings-schema";

type Data = { limits: { maxAttempts: number; retryIntervalMinutes: number }; target: { id: string; fullName: string }; agents: { id: string; fullName: string }[]; numbers: { id: string; e164: string; label: string | null }[]; settings: AgentSettings; configured: boolean };
const tabs = [{ id: "general", label: "כללי" }, { id: "calls", label: "הגדרות שיחה" }, { id: "strategy", label: "אסטרטגיית חיוג" }] as const;
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="crm-setting-toggle"><input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} /><span className="crm-switch" aria-hidden /><span>{label}</span></label>;
}
export function CrmSettings({ embedded = false }: { embedded?: boolean } = {}) {
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
    try { const settings = await api.put<AgentSettings>("/api/crm-settings", { userId: data.target.id, settings: draft }); setDraft(settings); setData({ ...data, settings, configured: true }); toast.success(`ההגדרות של ${data.target.fullName} נשמרו`); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  function schedule(key: "newLead" | "followUp", title: string) {
    if (!draft) return null;
    const rows = draft[key];
    return <section className="crm-retry"><h2>{title}</h2><div className="crm-retry-marker">0 שיחות</div>{rows.map((row, i) => <div key={i} className="crm-retry-stage">
      <div className="crm-retry-range">בין שיחות: {i ? rows[i - 1].through : 1} – <input aria-label={`${title} עד ניסיון ${i + 1}`} type="number" min={i ? rows[i - 1].through + 1 : 1} max="50" value={row.through} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, through: Number(e.target.value) } : r))} /></div>
      <div className="crm-retry-delay"><span>המתנה:</span><input type="number" aria-label={`${title} מרווח ${i + 1}`} min="1" max="168" value={row.delay} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, delay: Number(e.target.value) } : r))} /><select aria-label={`${title} יחידות ${i + 1}`} value={row.unit} onChange={e => change(key, rows.map((r, j) => j === i ? { ...r, unit: e.target.value as "hours" | "days" } : r))}><option value="hours">שעות</option><option value="days">ימים</option></select></div>
      <button aria-label={`מחק שלב ${i + 1} ${title}`} disabled={rows.length === 1} onClick={() => change(key, rows.filter((_, j) => i !== j))}>×</button>
    </div>)}<button className="crm-add-stage" disabled={rows.length >= 10 || rows.at(-1)!.through >= 50} onClick={() => change(key, [...rows, { through: Math.min(50, rows.at(-1)!.through + 5), delay: 1, unit: "days" }])}>+ הוספת שלב</button><div className="crm-retry-marker">לאחר {rows.at(-1)!.through} ניסיונות – הליד יוצא מתור החיוג</div></section>;
  }
  return <div className={embedded ? "crm-settings-embedded" : "crm-settings-page"} dir="rtl"><div className="crm-settings-shell">
    <header><div><h1>{embedded ? "הגדרות חייגן" : "הגדרות CRM"}</h1>{data && <p>{data.target.fullName}</p>}</div>{!embedded && <Link href="/leads" aria-label="סגור הגדרות" onClick={e => { if (dirty && !window.confirm("לצאת ללא שמירת השינויים?")) e.preventDefault(); }}>×</Link>}</header>
    <div className="crm-settings-agent"><label>הגדרות עבור <select aria-label="הגדרות עבור" value={data?.target.id ?? ""} disabled={loading || saving} onChange={e => { if (dirty && !window.confirm("להחליף נציג ללא שמירת השינויים?")) return; setLoading(true); setTarget(e.target.value); }}>{data?.agents.map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label><span>ההגדרות נשמרות בנפרד לכל נציג</span></div>
    <nav aria-label="לשוניות הגדרות" role="tablist">{tabs.map(t => <button role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} key={t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</nav>
    <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {loading ? <p>טוען הגדרות…</p> : error ? <p role="alert">{error}</p> : draft && data && <fieldset disabled={saving}>
        {tab === "general" && <><Toggle label="אפשר לנציג לקבוע פולו־אפים לנציגים אחרים בצוות" checked={draft.assignFollowUps} onChange={v => change("assignFollowUps", v)} /><Toggle label="אפשר לנציג לקחת ידנית פולו־אפים של נציגים אחרים בצוות" checked={draft.takeFollowUps} onChange={v => change("takeFollowUps", v)} />
          <p className="crm-settings-help">שיוך ולקיחת פולו־אפים זמינים ברשימות משותפות לצוות. הפעולות אינן מעניקות גישה לתיקי לקוחות אחרים.</p><FollowUps />
          <section className="crm-carousel"><h2>קרוסלת מספרים (מספר יוצא)</h2><p>רשימת המספרים:</p><div className="crm-number-scroll"><table><thead><tr><th>#</th><th>סטטוס</th><th>מספר טלפון</th><th>החלפת מספר</th><th /></tr></thead><tbody>{draft.numbers.map((n, i) => { const number = data.numbers.find(x => x.id === n.id); return <tr key={n.id}><td>{i + 1}</td><td><Toggle label={`מספר ${i + 1} פעיל`} checked={n.enabled} onChange={v => change("numbers", draft.numbers.map((x, j) => j === i ? { ...x, enabled: v } : x))} /></td><td>{number?.label || `מספר ${i + 1}`}<small dir="ltr">{number?.e164 || "המספר אינו זמין"}</small></td><td><select dir="ltr" aria-label={`החלפת מספר ${i + 1}`} value={n.id} onChange={e => change("numbers", draft.numbers.map((x, j) => j === i ? { ...x, id: e.target.value } : x))}>{!number && <option value={n.id}>בחר מספר חלופי</option>}{data.numbers.filter(x => x.id === n.id || !draft.numbers.some(p => p.id === x.id)).map(x => <option key={x.id} value={x.id}>{x.e164}</option>)}</select></td><td><button aria-label={`הסר מספר ${i + 1}`} onClick={() => change("numbers", draft.numbers.filter((_, j) => i !== j))}>×</button></td></tr>; })}</tbody></table></div>
          {!draft.numbers.length && <p className="crm-settings-empty">ללא קרוסלה אישית – המספר נבחר לפי הגדרות הרשימה והעסק.</p>}
          <button className="crm-add-number" disabled={!data.numbers.some(x => !draft.numbers.some(n => n.id === x.id))} onClick={() => { const next = data.numbers.find(x => !draft.numbers.some(n => n.id === x.id)); if (next) change("numbers", [...draft.numbers, { id: next.id, enabled: true }]); }}>＋ הוספת מספר נוסף</button>
          <p className="crm-settings-help">ניתן לבחור מספרים זמינים של העסק. הוספה לקרוסלה אינה רכישת מספר. מספר קבוע שהוגדר ברשימה או נבחר ידנית קודם לקרוסלה האישית.</p>
          <label className="crm-setting-field">כל כמה שיחות שלא נענו להחליף מספר?<select value={draft.rotateAfter} onChange={e => change("rotateAfter", Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
          <Toggle label="בחירת מספר אקראי בכל סבב החלפה (כולל שיחה ראשונה)" checked={draft.randomRotation} onChange={v => change("randomRotation", v)} />
          <p className="crm-settings-help">הסבב נפרד לכל נציג ולקוח; ההחלפה מתבצעת לאחר רצף ניסיונות ללא מענה מאותו מספר.</p></section></>}
        {tab === "calls" && <><label className="crm-setting-field">מקסימום שיחות אוטומטיות ללא מענה לליד ביום<select value={draft.maxDailyUnanswered} onChange={e => change("maxDailyUnanswered", Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>{schedule("newLead", "ליד חדש")}{schedule("followUp", "Follow-Up")}<p className="crm-settings-help">ברירת המחדל בעסק: עד {data.limits.maxAttempts} ניסיונות, מרווח {data.limits.retryIntervalMinutes} דקות. רשימת חיוג יכולה להגדיר מגבלות משלה. מגבלת הניסיונות המחמירה ומרווח ההמתנה הארוך יותר מבין הגדרות הנציג והרשימה חלים בפועל. זמני החזרה נשמרים בתוך שעות החיוג של העסק. מכסה יומית מחושבת לפי אזור הזמן של העסק, גם כשכמה נציגים מטפלים באותו ליד.</p></>}
        {tab === "strategy" && <div className="crm-strategies" role="radiogroup" aria-label="אסטרטגיית חיוג">{STRATEGIES.map(s => <label key={s.id} className={draft.strategy === s.id ? "selected" : ""}><input type="radio" name="strategy" value={s.id} checked={draft.strategy === s.id} onChange={() => change("strategy", s.id)} /><h2>{s.title}</h2><p>{s.text}</p></label>)}</div>}
      </fieldset>}
    </main><footer><button className="crm-settings-save" disabled={loading || saving || !draft || Boolean(error)} onClick={save}>{saving ? "שומר…" : "שמירה"}</button><button disabled={saving || !data || loading} onClick={() => { if (data) setDraft(data.settings); }}>ביטול שינויים</button></footer>
  </div></div>;
}
function FollowUps() {
  const [items, setItems] = useState<{ id: string; name: string; owner: string; due: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() { setBusy(true); try { setItems(await api.get("/api/crm-settings/follow-ups")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function take(id: string) { setBusy(true); try { await api.post("/api/crm-settings/follow-ups", { id }); toast.success("הפולו־אפ הועבר אליך"); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return <div className="crm-follow-ups"><button disabled={busy} onClick={load}>הצג פולו־אפים זמינים עבורי</button>{items && !items.length && <p>אין פולו־אפים זמינים ללקיחה</p>}{items?.map(i => <div key={i.id}><span>{i.name} · {i.owner} {i.due && new Date(i.due).toLocaleString("he-IL")}</span><button disabled={busy} onClick={() => take(i.id)}>לקיחה לטיפולי</button></div>)}</div>;
}
