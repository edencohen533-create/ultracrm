"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Bell, Clock, GitBranch, ListMinus, ListPlus, Mail, MessageCircle, Plus, Smartphone, Tag, Tags, Trash2, Webhook, X, ArrowUp, ArrowDown } from "lucide-react";
import { api } from "@/lib/client/api";

type Channel = "whatsapp" | "sms" | "email";
type Action = "send" | "task" | "wait" | "condition" | "add_tag" | "remove_tag" | "add_to_list" | "remove_from_list" | "webhook";
export interface JourneyStep { action: Action; channel: Channel; templateId?: string; waitMinutes: number; variables: Record<string, string>; condition: { requireNoReply?: boolean; tagName?: string; notTagName?: string; leadStatus?: string; consent?: string }; taskTitle?: string; taskDueHours?: number; actionTag?: string; listId?: string; webhookUrl?: string }
export interface Journey { id?: string; name: string; isActive: boolean; trigger: string; triggerConfig: Record<string, unknown>; stopOn: string[]; steps: JourneyStep[] }
type Opt = { id: string; name: string; channel?: string };

const TRIGGERS: Record<string, string> = { CONTACT_CREATED: "איש קשר חדש נוצר", TAG_ADDED: "תגית נוספה לאיש קשר", LEAD_STATUS_CHANGED: "סטטוס ליד השתנה", DELIVERY_FAILED: "הודעה שיווקית נכשלה במסירה", SENT_NO_REPLY: "הודעה שיווקית נשלחה ואין תשובה" };
const LEAD_STATUS: Record<string, string> = { new: "חדש", contacted: "נוצר קשר", qualified: "מתאים", unqualified: "לא מתאים", converted: "הומר לעסקה", lost: "אבוד" };
const PALETTE: Array<{ key: string; label: string; Icon: typeof Clock; make: () => JourneyStep }> = [
  { key: "wait", label: "המתנה", Icon: Clock, make: () => ({ action: "wait", channel: "email", waitMinutes: 60, variables: {}, condition: { requireNoReply: false } }) },
  { key: "condition", label: "תנאי", Icon: GitBranch, make: () => ({ action: "condition", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "email", label: "שליחת תבנית דוא״ל", Icon: Mail, make: () => ({ action: "send", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "whatsapp", label: "שליחת הודעת WhatsApp", Icon: MessageCircle, make: () => ({ action: "send", channel: "whatsapp", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "sms", label: "שליחת הודעת SMS", Icon: Smartphone, make: () => ({ action: "send", channel: "sms", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "task", label: "שליחת התראה לנציג", Icon: Bell, make: () => ({ action: "task", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, taskTitle: "לחזור ללקוח", taskDueHours: 24 }) },
  { key: "webhook", label: "שליחת Webhook", Icon: Webhook, make: () => ({ action: "webhook", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, webhookUrl: "https://" }) },
  { key: "add_tag", label: "הוספת תגית", Icon: Tag, make: () => ({ action: "add_tag", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, actionTag: "" }) },
  { key: "remove_tag", label: "הסרת תגית", Icon: Tags, make: () => ({ action: "remove_tag", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, actionTag: "" }) },
  { key: "add_to_list", label: "הוספה לרשימה", Icon: ListPlus, make: () => ({ action: "add_to_list", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false } }) },
  { key: "remove_from_list", label: "הסרה מרשימה", Icon: ListMinus, make: () => ({ action: "remove_from_list", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false } }) },
];
const fmtWait = (m: number) => m >= 1440 && m % 1440 === 0 ? (m === 1440 ? "יום אחד" : `${m / 1440} ימים`) : m >= 60 && m % 60 === 0 ? (m === 60 ? "שעה אחת" : `${m / 60} שעות`) : m === 1 ? "דקה אחת" : `${m} דקות`;
function stepTitle(s: JourneyStep) { return s.action === "send" ? (s.channel === "email" ? "שליחת תבנית דוא״ל" : s.channel === "sms" ? "שליחת הודעת SMS" : "שליחת הודעת WhatsApp") : PALETTE.find((p) => p.key === s.action)?.label ?? s.action; }
function stepIcon(s: JourneyStep) { return (s.action === "send" ? PALETTE.find((p) => p.key === s.channel) : PALETTE.find((p) => p.key === s.action))?.Icon ?? Clock; }

/**
 * Customer-journey builder (Flashy-style canvas): trigger → steps → exit. Linear journeys on top of the existing
 * sequence engine (consent / unsubscribe / frequency re-checked before every send; a reply or conversion can stop it).
 */
export function JourneyBuilder({ initial, templates, tags, lists }: { initial: Journey; templates: Opt[]; tags: string[]; lists: Opt[] }) {
  const router = useRouter();
  const [j, setJ] = useState<Journey>(initial);
  const [adding, setAdding] = useState<number | null>(null);
  const [sel, setSel] = useState<number | "trigger" | "exit" | null>(initial.id ? null : "trigger");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<Journey>) => { setJ((x) => ({ ...x, ...patch })); setDirty(true); };
  const setStep = (i: number, patch: Partial<JourneyStep>) => set({ steps: j.steps.map((s, k) => k === i ? { ...s, ...patch } : s) });
  const insert = (at: number, s: JourneyStep) => { const steps = [...j.steps]; steps.splice(at, 0, s); set({ steps }); setAdding(null); setSel(at); };
  const move = (i: number, to: number) => { if (to < 0 || to >= j.steps.length) return; const steps = [...j.steps]; const [x] = steps.splice(i, 1); steps.splice(to, 0, x); set({ steps }); setSel(to); };
  const remove = (i: number) => { set({ steps: j.steps.filter((_, k) => k !== i) }); setSel(null); };
  async function save(active?: boolean) {
    if (!j.steps.length) { toast.error("יש להוסיף לפחות פעולה אחת"); return; }
    setBusy(true);
    try {
      const body = { ...j, isActive: active ?? j.isActive, steps: j.steps.map((s) => ({ ...s, templateId: s.action === "send" ? s.templateId || undefined : undefined })) };
      const r = j.id ? await api.put<{ id: string }>(`/api/sequences/${j.id}`, body) : await api.post<{ id: string }>("/api/sequences", body);
      setJ((x) => ({ ...x, id: r.id, isActive: body.isActive })); setDirty(false);
      toast.success("האוטומציה נשמרה");
      if (!j.id) router.replace(`/automations/journeys/${r.id}`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const selected = typeof sel === "number" ? j.steps[sel] : null;
  const tpl = (ch: Channel) => templates.filter((t) => t.channel === ch);
  return (
    <div className="jr" data-testid="journey-builder">
      <header className="jr-head">
        <Link href="/automations" className="jr-back">← אוטומציות</Link>
        <input className="jr-name" value={j.name} onChange={(e) => set({ name: e.target.value })} aria-label="שם האוטומציה" data-testid="journey-name" />
        <div className="jr-head-actions">
          <label className="jr-active"><input type="checkbox" checked={j.isActive} onChange={(e) => set({ isActive: e.target.checked })} data-testid="journey-active" /> {j.isActive ? "פעיל" : "לא פעיל"}</label>
          {dirty && <span className="jr-dirty">שינויים לא שמורים</span>}
          <button className="wz-btn primary" onClick={() => save()} disabled={busy} data-testid="journey-save">{busy ? "שומר…" : "שמירת אוטומציה"}</button>
        </div>
      </header>
      <div className="jr-body">
        <div className="jr-canvas">
          <button className={`jr-node trigger ${sel === "trigger" ? "sel" : ""} ${j.trigger ? "set" : ""}`} onClick={() => setSel("trigger")} data-testid="journey-trigger">{j.trigger ? <><strong>טריגר</strong><span>{TRIGGERS[j.trigger]}{j.trigger === "TAG_ADDED" && j.triggerConfig.tagName ? `: ${j.triggerConfig.tagName}` : ""}{j.trigger === "LEAD_STATUS_CHANGED" && j.triggerConfig.leadStatus ? `: ${LEAD_STATUS[String(j.triggerConfig.leadStatus)]}` : ""}</span></> : "הוספת טריגרים"}</button>
          <Connector onAdd={() => setAdding(0)} testid="journey-add-0" />
          {j.steps.map((s, i) => { const I = stepIcon(s); return (
            <div key={i} className="jr-item">
              {s.waitMinutes > 0 && s.action !== "wait" && <div className="jr-wait-chip">המתנה {fmtWait(s.waitMinutes)}</div>}
              <button className={`jr-node step a-${s.action} ${sel === i ? "sel" : ""}`} onClick={() => setSel(i)} data-testid={`journey-step-${i}`}>
                <I size={18} /><strong>{stepTitle(s)}</strong>
                <span>{s.action === "wait" ? fmtWait(s.waitMinutes) : s.action === "send" ? templates.find((t) => t.id === s.templateId)?.name ?? "בחר תבנית" : s.action === "task" ? s.taskTitle : s.action === "add_tag" || s.action === "remove_tag" ? s.actionTag || "בחר תגית" : s.action === "add_to_list" || s.action === "remove_from_list" ? lists.find((l) => l.id === s.listId)?.name ?? "בחר רשימה" : s.action === "webhook" ? s.webhookUrl : conditionText(s)}</span>
              </button>
              <Connector onAdd={() => setAdding(i + 1)} testid={`journey-add-${i + 1}`} />
            </div>); })}
          <button className={`jr-node exit ${sel === "exit" ? "sel" : ""}`} onClick={() => setSel("exit")} data-testid="journey-exit">יציאה</button>
        </div>
        {sel !== null && <aside className="jr-panel" data-testid="journey-panel">
          <header><strong>{sel === "trigger" ? "טריגר" : sel === "exit" ? "תנאי יציאה" : selected ? stepTitle(selected) : ""}</strong><button onClick={() => setSel(null)} aria-label="סגור"><X size={16} /></button></header>
          {sel === "trigger" && <div className="jr-form">
            <label>מה מתחיל את המסע<select value={j.trigger} onChange={(e) => set({ trigger: e.target.value, triggerConfig: {} })} data-testid="journey-trigger-select">{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {j.trigger === "TAG_ADDED" && <label>תגית<input list="jr-tags" value={String(j.triggerConfig.tagName ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, tagName: e.target.value } })} /></label>}
            {j.trigger === "LEAD_STATUS_CHANGED" && <label>לסטטוס<select value={String(j.triggerConfig.leadStatus ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, leadStatus: e.target.value || undefined } })}><option value="">כל שינוי</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
            {(j.trigger === "DELIVERY_FAILED" || j.trigger === "SENT_NO_REPLY") && <label>ערוץ<select value={String(j.triggerConfig.channel ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, channel: e.target.value || undefined } })}><option value="">כל הערוצים</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">אימייל</option></select></label>}
            {j.trigger === "CONTACT_CREATED" && <label>מקור (אופציונלי)<input value={String(j.triggerConfig.contactSource ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, contactSource: e.target.value || undefined } })} placeholder="למשל facebook" /></label>}
            {j.trigger === "SENT_NO_REPLY" && <p className="jr-hint">השלב הראשון חייב להתחיל אחרי המתנה של 30 דקות לפחות.</p>}
          </div>}
          {sel === "exit" && <div className="jr-form">
            <p className="jr-hint">איש קשר יוצא מהמסע בסוף הפעולות, או מוקדם יותר כש:</p>
            {[["reply", "הלקוח השיב להודעה"], ["conversion", "הליד הומר לעסקה"]].map(([k, v]) => <label key={k} className="jr-check"><input type="checkbox" checked={j.stopOn.includes(k)} onChange={(e) => set({ stopOn: e.target.checked ? [...j.stopOn, k] : j.stopOn.filter((x) => x !== k) })} /> {v}</label>)}
            <label className="jr-check"><input type="checkbox" checked disabled /> הלקוח הסיר את עצמו מדיוור (תמיד)</label>
          </div>}
          {selected && typeof sel === "number" && <div className="jr-form">
            {selected.action !== "wait" && <label>המתנה לפני הפעולה<WaitInput value={selected.waitMinutes} onChange={(v) => setStep(sel, { waitMinutes: v })} /></label>}
            {selected.action === "wait" && <label>משך ההמתנה<WaitInput value={selected.waitMinutes} onChange={(v) => setStep(sel, { waitMinutes: Math.max(1, v) })} /></label>}
            {selected.action === "send" && <><label>תבנית<select value={selected.templateId ?? ""} onChange={(e) => setStep(sel, { templateId: e.target.value })} data-testid="journey-template"><option value="">בחר תבנית</option>{tpl(selected.channel).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>{!tpl(selected.channel).length && <p className="jr-hint">אין תבניות מאושרות לערוץ זה. <Link href="/templates">לניהול תבניות</Link></p>}<label className="jr-check"><input type="checkbox" checked={selected.condition.requireNoReply !== false} onChange={(e) => setStep(sel, { condition: { ...selected.condition, requireNoReply: e.target.checked } })} /> לדלג על השליחה אם הלקוח כבר השיב</label></>}
            {selected.action === "task" && <><label>כותרת ההתראה (משימה לנציג האחראי)<input value={selected.taskTitle ?? ""} onChange={(e) => setStep(sel, { taskTitle: e.target.value })} /></label><label>לביצוע תוך (שעות)<input type="number" min={1} max={720} value={selected.taskDueHours ?? 24} onChange={(e) => setStep(sel, { taskDueHours: Number(e.target.value) || 24 })} /></label></>}
            {(selected.action === "add_tag" || selected.action === "remove_tag") && <label>תגית<input list="jr-tags" value={selected.actionTag ?? ""} onChange={(e) => setStep(sel, { actionTag: e.target.value })} data-testid="journey-tag" /></label>}
            {(selected.action === "add_to_list" || selected.action === "remove_from_list") && <label>רשימה<select value={selected.listId ?? ""} onChange={(e) => setStep(sel, { listId: e.target.value })}><option value="">בחר רשימה</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>{!lists.length && <span className="jr-hint">אין רשימות רגילות. <Link href="/audiences">ליצירת רשימה</Link></span>}</label>}
            {selected.action === "webhook" && <><label>כתובת (https)<input dir="ltr" value={selected.webhookUrl ?? ""} onChange={(e) => setStep(sel, { webhookUrl: e.target.value })} /></label><p className="jr-hint">נשלח POST עם JSON: {"{ event, journey, contact }"}. כשל לא עוצר את המסע.</p></>}
            {selected.action === "condition" && <><p className="jr-hint">המסע ממשיך רק אם כל התנאים מתקיימים; אחרת איש הקשר יוצא מהמסע.</p>
              <label className="jr-check"><input type="checkbox" checked={selected.condition.requireNoReply !== false} onChange={(e) => setStep(sel, { condition: { ...selected.condition, requireNoReply: e.target.checked } })} /> הלקוח לא השיב מאז תחילת המסע</label>
              <label>יש לו תגית<input list="jr-tags" value={selected.condition.tagName ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, tagName: e.target.value || undefined } })} /></label>
              <label>אין לו תגית<input list="jr-tags" value={selected.condition.notTagName ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, notTagName: e.target.value || undefined } })} /></label>
              <label>סטטוס הליד<select value={selected.condition.leadStatus ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, leadStatus: e.target.value || undefined } })}><option value="">לא משנה</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="jr-check"><input type="checkbox" checked={selected.condition.consent === "OPTED_IN"} onChange={(e) => setStep(sel, { condition: { ...selected.condition, consent: e.target.checked ? "OPTED_IN" : undefined } })} /> נתן הסכמה לדיוור</label></>}
            <div className="jr-step-tools"><button onClick={() => move(sel, sel - 1)} disabled={sel === 0}><ArrowUp size={14} /> למעלה</button><button onClick={() => move(sel, sel + 1)} disabled={sel === j.steps.length - 1}><ArrowDown size={14} /> למטה</button><button className="danger" onClick={() => remove(sel)} data-testid="journey-step-delete"><Trash2 size={14} /> מחיקה</button></div>
          </div>}
        </aside>}
      </div>
      <datalist id="jr-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
      {adding !== null && <div className="wz-modal" role="dialog" aria-label="הוספת פעולה" onClick={(e) => e.target === e.currentTarget && setAdding(null)}><div className="wz-modal-box jr-palette"><header><strong>הוספת פעולה</strong><button onClick={() => setAdding(null)} aria-label="סגור"><X size={18} /></button></header>
        <div className="jr-palette-grid">{PALETTE.map((p) => <button key={p.key} onClick={() => insert(adding, p.make())} data-testid={`journey-palette-${p.key}`}><p.Icon size={30} strokeWidth={1.5} /><span>{p.label}</span></button>)}</div>
      </div></div>}
    </div>
  );
}

function conditionText(s: JourneyStep) {
  const c = s.condition; const parts: string[] = [];
  if (c.requireNoReply !== false) parts.push("לא השיב"); if (c.tagName) parts.push(`יש תגית ${c.tagName}`); if (c.notTagName) parts.push(`אין תגית ${c.notTagName}`); if (c.leadStatus) parts.push(`סטטוס ${LEAD_STATUS[c.leadStatus]}`); if (c.consent) parts.push("נתן הסכמה");
  return parts.join(" · ") || "הגדר תנאי";
}
function Connector({ onAdd, testid }: { onAdd: () => void; testid: string }) { return <div className="jr-conn"><span className="jr-line" /><button className="jr-plus" onClick={onAdd} aria-label="הוספת פעולה" data-testid={testid}><Plus size={16} /></button><span className="jr-line" /></div>; }
function WaitInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const unit = value >= 1440 && value % 1440 === 0 ? 1440 : value >= 60 && value % 60 === 0 ? 60 : 1;
  return <div className="jr-wait"><input type="number" min={0} value={value / unit} onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0) * unit))} /><select value={unit} onChange={(e) => onChange(Math.round((value / unit) * Number(e.target.value)))}><option value={1}>דקות</option><option value={60}>שעות</option><option value={1440}>ימים</option></select></div>;
}
