"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Bell, Clock, GitBranch, ListMinus, ListPlus, Mail, MessageCircle, Plus, Smartphone, Tag, Tags, Trash2, Webhook, X, ArrowUp, ArrowDown } from "lucide-react";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

type Channel = "whatsapp" | "sms" | "email";
type Action = "send" | "task" | "wait" | "condition" | "add_tag" | "remove_tag" | "add_to_list" | "remove_from_list" | "webhook";
export interface JourneyStep { action: Action; channel: Channel; templateId?: string; waitMinutes: number; variables: Record<string, string>; condition: { requireNoReply?: boolean; tagName?: string; notTagName?: string; leadStatus?: string; consent?: string }; taskTitle?: string; taskDueHours?: number; actionTag?: string; listId?: string; webhookUrl?: string }
export interface Journey { id?: string; name: string; isActive: boolean; trigger: string; triggerConfig: Record<string, unknown>; stopOn: string[]; steps: JourneyStep[] }
type Opt = { id: string; name: string; channel?: string };
type T = (he: string, en: string) => string;

const TRIGGERS: Record<string, [string, string]> = { CART_ABANDONED: ["עגלה ננטשה באתר", "Cart abandoned on the site"], CONTACT_CREATED: ["איש קשר חדש נוצר", "New contact created"], TAG_ADDED: ["תגית נוספה לאיש קשר", "Tag added to contact"], LEAD_STATUS_CHANGED: ["סטטוס ליד השתנה", "Lead status changed"], DELIVERY_FAILED: ["הודעה שיווקית נכשלה במסירה", "Marketing message delivery failed"], SENT_NO_REPLY: ["הודעה שיווקית נשלחה ואין תשובה", "Marketing message sent, no reply"] };
const LEAD_STATUS: Record<string, [string, string]> = { new: ["חדש", "New"], contacted: ["נוצר קשר", "Contacted"], qualified: ["מתאים", "Qualified"], unqualified: ["לא מתאים", "Unqualified"], converted: ["הומר לעסקה", "Converted to deal"], lost: ["אבוד", "Lost"] };
const ls = (t: T, k: string) => (LEAD_STATUS[k] ? t(...LEAD_STATUS[k]) : k);
const PALETTE: Array<{ key: string; label: string; en: string; Icon: typeof Clock; make: (t: T) => JourneyStep }> = [
  { key: "wait", label: "המתנה", en: "Wait", Icon: Clock, make: () => ({ action: "wait", channel: "email", waitMinutes: 60, variables: {}, condition: { requireNoReply: false } }) },
  { key: "condition", label: "תנאי", en: "Condition", Icon: GitBranch, make: () => ({ action: "condition", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "email", label: "שליחת תבנית דוא״ל", en: "Send email template", Icon: Mail, make: () => ({ action: "send", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "whatsapp", label: "שליחת הודעת WhatsApp", en: "Send WhatsApp message", Icon: MessageCircle, make: () => ({ action: "send", channel: "whatsapp", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "sms", label: "שליחת הודעת SMS", en: "Send SMS message", Icon: Smartphone, make: () => ({ action: "send", channel: "sms", waitMinutes: 0, variables: {}, condition: { requireNoReply: true } }) },
  { key: "task", label: "שליחת התראה לנציג", en: "Notify agent", Icon: Bell, make: (t) => ({ action: "task", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, taskTitle: t("לחזור ללקוח", "Call the customer back"), taskDueHours: 24 }) },
  { key: "webhook", label: "שליחת Webhook", en: "Send webhook", Icon: Webhook, make: () => ({ action: "webhook", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, webhookUrl: "https://" }) },
  { key: "add_tag", label: "הוספת תגית", en: "Add tag", Icon: Tag, make: () => ({ action: "add_tag", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, actionTag: "" }) },
  { key: "remove_tag", label: "הסרת תגית", en: "Remove tag", Icon: Tags, make: () => ({ action: "remove_tag", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, actionTag: "" }) },
  { key: "add_to_list", label: "הוספה לרשימה", en: "Add to list", Icon: ListPlus, make: () => ({ action: "add_to_list", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false } }) },
  { key: "remove_from_list", label: "הסרה מרשימה", en: "Remove from list", Icon: ListMinus, make: () => ({ action: "remove_from_list", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false } }) },
];
const fmtWait = (m: number, t: T) => m >= 1440 && m % 1440 === 0 ? (m === 1440 ? t("יום אחד", "1 day") : t(`${m / 1440} ימים`, `${m / 1440} days`)) : m >= 60 && m % 60 === 0 ? (m === 60 ? t("שעה אחת", "1 hour") : t(`${m / 60} שעות`, `${m / 60} hours`)) : m === 1 ? t("דקה אחת", "1 minute") : t(`${m} דקות`, `${m} minutes`);
function stepTitle(s: JourneyStep, t: T) { const p = PALETTE.find((x) => x.key === s.action); return s.action === "send" ? (s.channel === "email" ? t("שליחת תבנית דוא״ל", "Send email template") : s.channel === "sms" ? t("שליחת הודעת SMS", "Send SMS message") : t("שליחת הודעת WhatsApp", "Send WhatsApp message")) : p ? t(p.label, p.en) : s.action; }
function stepIcon(s: JourneyStep) { return (s.action === "send" ? PALETTE.find((p) => p.key === s.channel) : PALETTE.find((p) => p.key === s.action))?.Icon ?? Clock; }

/**
 * Customer-journey builder (Flashy-style canvas): trigger → steps → exit. Linear journeys on top of the existing
 * sequence engine (consent / unsubscribe / frequency re-checked before every send; a reply or conversion can stop it).
 */
export function JourneyBuilder({ initial, templates, tags, lists }: { initial: Journey; templates: Opt[]; tags: string[]; lists: Opt[] }) {
  const router = useRouter();
  const t = useT();
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
    if (!j.steps.length) { toast.error(t("יש להוסיף לפחות פעולה אחת", "Add at least one action")); return; }
    setBusy(true);
    try {
      const body = { ...j, isActive: active ?? j.isActive, steps: j.steps.map((s) => ({ ...s, templateId: s.action === "send" ? s.templateId || undefined : undefined })) };
      const r = j.id ? await api.put<{ id: string }>(`/api/sequences/${j.id}`, body) : await api.post<{ id: string }>("/api/sequences", body);
      setJ((x) => ({ ...x, id: r.id, isActive: body.isActive })); setDirty(false);
      toast.success(t("האוטומציה נשמרה", "Automation saved"));
      if (!j.id) router.replace(`/automations/journeys/${r.id}`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const selected = typeof sel === "number" ? j.steps[sel] : null;
  const tpl = (ch: Channel) => templates.filter((x) => x.channel === ch);
  return (
    <div className="jr" data-testid="journey-builder">
      <header className="jr-head">
        <Link href="/automations" className="jr-back">{t("← אוטומציות", "← Automations")}</Link>
        <input className="jr-name" value={j.name} onChange={(e) => set({ name: e.target.value })} aria-label={t("שם האוטומציה", "Automation name")} data-testid="journey-name" />
        <div className="jr-head-actions">
          <label className="jr-active"><input type="checkbox" checked={j.isActive} onChange={(e) => set({ isActive: e.target.checked })} data-testid="journey-active" /> {j.isActive ? t("פעיל", "Active") : t("לא פעיל", "Inactive")}</label>
          {dirty && <span className="jr-dirty">{t("שינויים לא שמורים", "Unsaved changes")}</span>}
          <button className="wz-btn primary" onClick={() => save()} disabled={busy} data-testid="journey-save">{busy ? t("שומר…", "Saving…") : t("שמירת אוטומציה", "Save automation")}</button>
        </div>
      </header>
      <div className="jr-body">
        <div className="jr-canvas">
          <button className={`jr-node trigger ${sel === "trigger" ? "sel" : ""} ${j.trigger ? "set" : ""}`} onClick={() => setSel("trigger")} data-testid="journey-trigger">{j.trigger ? <><strong>{t("טריגר", "Trigger")}</strong><span>{TRIGGERS[j.trigger] ? t(...TRIGGERS[j.trigger]) : j.trigger}{j.trigger === "TAG_ADDED" && j.triggerConfig.tagName ? `: ${j.triggerConfig.tagName}` : ""}{j.trigger === "LEAD_STATUS_CHANGED" && j.triggerConfig.leadStatus ? `: ${ls(t, String(j.triggerConfig.leadStatus))}` : ""}</span></> : t("הוספת טריגרים", "Add trigger")}</button>
          <Connector onAdd={() => setAdding(0)} testid="journey-add-0" />
          {j.steps.map((s, i) => { const I = stepIcon(s); return (
            <div key={i} className="jr-item">
              {s.waitMinutes > 0 && s.action !== "wait" && <div className="jr-wait-chip">{t("המתנה", "Wait")} {fmtWait(s.waitMinutes, t)}</div>}
              <button className={`jr-node step a-${s.action} ${sel === i ? "sel" : ""}`} onClick={() => setSel(i)} data-testid={`journey-step-${i}`}>
                <I size={18} /><strong>{stepTitle(s, t)}</strong>
                <span>{s.action === "wait" ? fmtWait(s.waitMinutes, t) : s.action === "send" ? templates.find((x) => x.id === s.templateId)?.name ?? t("בחר תבנית", "Choose template") : s.action === "task" ? s.taskTitle : s.action === "add_tag" || s.action === "remove_tag" ? s.actionTag || t("בחר תגית", "Choose tag") : s.action === "add_to_list" || s.action === "remove_from_list" ? lists.find((l) => l.id === s.listId)?.name ?? t("בחר רשימה", "Choose list") : s.action === "webhook" ? s.webhookUrl : conditionText(s, t)}</span>
              </button>
              <Connector onAdd={() => setAdding(i + 1)} testid={`journey-add-${i + 1}`} />
            </div>); })}
          <button className={`jr-node exit ${sel === "exit" ? "sel" : ""}`} onClick={() => setSel("exit")} data-testid="journey-exit">{t("יציאה", "Exit")}</button>
        </div>
        {sel !== null && <aside className="jr-panel" data-testid="journey-panel">
          <header><strong>{sel === "trigger" ? t("טריגר", "Trigger") : sel === "exit" ? t("תנאי יציאה", "Exit conditions") : selected ? stepTitle(selected, t) : ""}</strong><button onClick={() => setSel(null)} aria-label={t("סגור", "Close")}><X size={16} /></button></header>
          {sel === "trigger" && <div className="jr-form">
            <label>{t("מה מתחיל את המסע", "What starts the journey")}<select value={j.trigger} onChange={(e) => set({ trigger: e.target.value, triggerConfig: {} })} data-testid="journey-trigger-select">{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{t(...v)}</option>)}</select></label>
            {j.trigger === "TAG_ADDED" && <label>{t("תגית", "Tag")}<input list="jr-tags" value={String(j.triggerConfig.tagName ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, tagName: e.target.value } })} /></label>}
            {j.trigger === "LEAD_STATUS_CHANGED" && <label>{t("לסטטוס", "To status")}<select value={String(j.triggerConfig.leadStatus ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, leadStatus: e.target.value || undefined } })}><option value="">{t("כל שינוי", "Any change")}</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{t(...v)}</option>)}</select></label>}
            {(j.trigger === "DELIVERY_FAILED" || j.trigger === "SENT_NO_REPLY") && <label>{t("ערוץ", "Channel")}<select value={String(j.triggerConfig.channel ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, channel: e.target.value || undefined } })}><option value="">{t("כל הערוצים", "All channels")}</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">{t("אימייל", "Email")}</option></select></label>}
            {j.trigger === "CONTACT_CREATED" && <label>{t("מקור (אופציונלי)", "Source (optional)")}<input value={String(j.triggerConfig.contactSource ?? "")} onChange={(e) => set({ triggerConfig: { ...j.triggerConfig, contactSource: e.target.value || undefined } })} placeholder={t("למשל facebook", "e.g. facebook")} /></label>}
            {j.trigger === "SENT_NO_REPLY" && <p className="jr-hint">{t("השלב הראשון חייב להתחיל אחרי המתנה של 30 דקות לפחות.", "The first step must start after a wait of at least 30 minutes.")}</p>}
            {j.trigger === "CART_ABANDONED" && <p className="jr-hint">{t("מתחיל כשעגלה עם פרטי לקוח ננטשת בחנות מחוברת", "Starts when a cart with customer details is abandoned in a connected store")} (<Link href="/automations/carts">{t("עגלות נטושות", "Abandoned carts")}</Link>). {t("בהודעות:", "In messages:")} {"{{cart_url}}"}, {"{{cart_total}}"}, {"{{cart_items}}"}; {t("במשתני WhatsApp:", "In WhatsApp variables:")} {"{cart_url}"}. {t("המסע נעצר כשהעגלה נרכשת.", "The journey stops when the cart is purchased.")}</p>}
          </div>}
          {sel === "exit" && <div className="jr-form">
            <p className="jr-hint">{t("איש קשר יוצא מהמסע בסוף הפעולות, או מוקדם יותר כש:", "A contact exits the journey after the last action, or earlier when:")}</p>
            {[["reply", "הלקוח השיב להודעה", "The customer replied to a message"], ["conversion", "הליד הומר לעסקה", "The lead was converted to a deal"]].map(([k, v, en]) => <label key={k} className="jr-check"><input type="checkbox" checked={j.stopOn.includes(k)} onChange={(e) => set({ stopOn: e.target.checked ? [...j.stopOn, k] : j.stopOn.filter((x) => x !== k) })} /> {t(v, en)}</label>)}
            <label className="jr-check"><input type="checkbox" checked disabled /> {t("הלקוח הסיר את עצמו מדיוור (תמיד)", "The customer unsubscribed (always)")}</label>
          </div>}
          {selected && typeof sel === "number" && <div className="jr-form">
            {selected.action !== "wait" && <label>{t("המתנה לפני הפעולה", "Wait before action")}<WaitInput value={selected.waitMinutes} onChange={(v) => setStep(sel, { waitMinutes: v })} /></label>}
            {selected.action === "wait" && <label>{t("משך ההמתנה", "Wait duration")}<WaitInput value={selected.waitMinutes} onChange={(v) => setStep(sel, { waitMinutes: Math.max(1, v) })} /></label>}
            {selected.action === "send" && <><label>{t("תבנית", "Template")}<select value={selected.templateId ?? ""} onChange={(e) => setStep(sel, { templateId: e.target.value })} data-testid="journey-template"><option value="">{t("בחר תבנית", "Choose template")}</option>{tpl(selected.channel).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>{!tpl(selected.channel).length && <p className="jr-hint">{t("אין תבניות מאושרות לערוץ זה.", "No approved templates for this channel.")} <Link href="/templates">{t("לניהול תבניות", "Manage templates")}</Link></p>}<label className="jr-check"><input type="checkbox" checked={selected.condition.requireNoReply !== false} onChange={(e) => setStep(sel, { condition: { ...selected.condition, requireNoReply: e.target.checked } })} /> {t("לדלג על השליחה אם הלקוח כבר השיב", "Skip sending if the customer already replied")}</label></>}
            {selected.action === "task" && <><label>{t("כותרת ההתראה (משימה לנציג האחראי)", "Notification title (task for the assigned agent)")}<input value={selected.taskTitle ?? ""} onChange={(e) => setStep(sel, { taskTitle: e.target.value })} /></label><label>{t("לביצוע תוך (שעות)", "Due within (hours)")}<input type="number" min={1} max={720} value={selected.taskDueHours ?? 24} onChange={(e) => setStep(sel, { taskDueHours: Number(e.target.value) || 24 })} /></label></>}
            {(selected.action === "add_tag" || selected.action === "remove_tag") && <label>{t("תגית", "Tag")}<input list="jr-tags" value={selected.actionTag ?? ""} onChange={(e) => setStep(sel, { actionTag: e.target.value })} data-testid="journey-tag" /></label>}
            {(selected.action === "add_to_list" || selected.action === "remove_from_list") && <label>{t("רשימה", "List")}<select value={selected.listId ?? ""} onChange={(e) => setStep(sel, { listId: e.target.value })}><option value="">{t("בחר רשימה", "Choose list")}</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>{!lists.length && <span className="jr-hint">{t("אין רשימות רגילות.", "No static lists.")} <Link href="/audiences">{t("ליצירת רשימה", "Create a list")}</Link></span>}</label>}
            {selected.action === "webhook" && <><label>{t("כתובת (https)", "URL (https)")}<input dir="ltr" value={selected.webhookUrl ?? ""} onChange={(e) => setStep(sel, { webhookUrl: e.target.value })} /></label><p className="jr-hint">{t("נשלח POST עם JSON:", "Sends a POST with JSON:")} {"{ event, journey, contact }"}. {t("כשל לא עוצר את המסע.", "A failure does not stop the journey.")}</p></>}
            {selected.action === "condition" && <><p className="jr-hint">{t("המסע ממשיך רק אם כל התנאים מתקיימים; אחרת איש הקשר יוצא מהמסע.", "The journey continues only if all conditions are met; otherwise the contact exits the journey.")}</p>
              <label className="jr-check"><input type="checkbox" checked={selected.condition.requireNoReply !== false} onChange={(e) => setStep(sel, { condition: { ...selected.condition, requireNoReply: e.target.checked } })} /> {t("הלקוח לא השיב מאז תחילת המסע", "The customer has not replied since the journey started")}</label>
              <label>{t("יש לו תגית", "Has tag")}<input list="jr-tags" value={selected.condition.tagName ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, tagName: e.target.value || undefined } })} /></label>
              <label>{t("אין לו תגית", "Does not have tag")}<input list="jr-tags" value={selected.condition.notTagName ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, notTagName: e.target.value || undefined } })} /></label>
              <label>{t("סטטוס הליד", "Lead status")}<select value={selected.condition.leadStatus ?? ""} onChange={(e) => setStep(sel, { condition: { ...selected.condition, leadStatus: e.target.value || undefined } })}><option value="">{t("לא משנה", "Any")}</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{t(...v)}</option>)}</select></label>
              <label className="jr-check"><input type="checkbox" checked={selected.condition.consent === "OPTED_IN"} onChange={(e) => setStep(sel, { condition: { ...selected.condition, consent: e.target.checked ? "OPTED_IN" : undefined } })} /> {t("נתן הסכמה לדיוור", "Opted in to marketing")}</label></>}
            <div className="jr-step-tools"><button onClick={() => move(sel, sel - 1)} disabled={sel === 0}><ArrowUp size={14} /> {t("למעלה", "Up")}</button><button onClick={() => move(sel, sel + 1)} disabled={sel === j.steps.length - 1}><ArrowDown size={14} /> {t("למטה", "Down")}</button><button className="danger" onClick={() => remove(sel)} data-testid="journey-step-delete"><Trash2 size={14} /> {t("מחיקה", "Delete")}</button></div>
          </div>}
        </aside>}
      </div>
      <datalist id="jr-tags">{tags.map((tag) => <option key={tag} value={tag} />)}</datalist>
      {adding !== null && <div className="wz-modal" role="dialog" aria-label={t("הוספת פעולה", "Add action")} onClick={(e) => e.target === e.currentTarget && setAdding(null)}><div className="wz-modal-box jr-palette"><header><strong>{t("הוספת פעולה", "Add action")}</strong><button onClick={() => setAdding(null)} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
        <div className="jr-palette-grid">{PALETTE.map((p) => <button key={p.key} onClick={() => insert(adding, p.make(t))} data-testid={`journey-palette-${p.key}`}><p.Icon size={30} strokeWidth={1.5} /><span>{t(p.label, p.en)}</span></button>)}</div>
      </div></div>}
    </div>
  );
}

function conditionText(s: JourneyStep, t: T) {
  const c = s.condition; const parts: string[] = [];
  if (c.requireNoReply !== false) parts.push(t("לא השיב", "No reply")); if (c.tagName) parts.push(t(`יש תגית ${c.tagName}`, `Has tag ${c.tagName}`)); if (c.notTagName) parts.push(t(`אין תגית ${c.notTagName}`, `No tag ${c.notTagName}`)); if (c.leadStatus) parts.push(t(`סטטוס ${ls(t, c.leadStatus)}`, `Status ${ls(t, c.leadStatus)}`)); if (c.consent) parts.push(t("נתן הסכמה", "Opted in"));
  return parts.join(" · ") || t("הגדר תנאי", "Set condition");
}
function Connector({ onAdd, testid }: { onAdd: () => void; testid: string }) { const t = useT(); return <div className="jr-conn"><span className="jr-line" /><button className="jr-plus" onClick={onAdd} aria-label={t("הוספת פעולה", "Add action")} data-testid={testid}><Plus size={16} /></button><span className="jr-line" /></div>; }
function WaitInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT();
  const unit = value >= 1440 && value % 1440 === 0 ? 1440 : value >= 60 && value % 60 === 0 ? 60 : 1;
  return <div className="jr-wait"><input type="number" min={0} value={value / unit} onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0) * unit))} /><select value={unit} onChange={(e) => onChange(Math.round((value / unit) * Number(e.target.value)))}><option value={1}>{t("דקות", "Minutes")}</option><option value={60}>{t("שעות", "Hours")}</option><option value={1440}>{t("ימים", "Days")}</option></select></div>;
}
