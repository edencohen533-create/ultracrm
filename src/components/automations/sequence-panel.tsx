"use client";

/** Cross-channel follow-up sequences (e.g. WhatsApp delivery failed → wait → SMS). */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CHANNEL_LABELS } from "@/lib/campaigns";

interface TemplateOpt { id: string; name: string; channel: string }
interface Step { action: "send" | "task"; channel: "whatsapp" | "sms" | "email"; templateId: string; waitMinutes: number; variables: Record<string, string>; condition: { requireNoReply: boolean; tagName?: string; notTagName?: string; leadStatus?: string; customKey?: string; customValue?: string }; taskTitle?: string; taskDueHours?: number }
export interface SequenceRow { id: string; name: string; isActive: boolean; trigger: string; triggerConfig: { channel?: string; tagName?: string; marketingOnly?: boolean; leadStatus?: string; contactSource?: string }; stopOn: string[]; steps: Array<{ position: number; action?: string; channel: string; templateId: string; waitMinutes: number; variables?: Record<string, string>; condition?: Step["condition"]; template: { name: string } }>; _count: { runs: number } }

const TRIGGER: Record<string, string> = { DELIVERY_FAILED: "הודעה שיווקית נכשלה במסירה", SENT_NO_REPLY: "הודעה שיווקית נשלחה ואין תשובה", TAG_ADDED: "תגית נוספה לאיש קשר", CONTACT_CREATED: "איש קשר חדש נוצר (ליד חדש)", LEAD_STATUS_CHANGED: "סטטוס ליד השתנה" };
const LEAD_STATUS: Record<string, string> = { new: "ליד חדש", contacted: "נוצר קשר", qualified: "ליד מתאים", unqualified: "לא רלוונטי", converted: "הומר לעסקה" };
const EMPTY: Step = { action: "send", channel: "sms", templateId: "", waitMinutes: 60, variables: {}, condition: { requireNoReply: true } };

export function SequencePanel({ sequences, templates, tags }: { sequences: SequenceRow[]; templates: TemplateOpt[]; tags: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("DELIVERY_FAILED");
  const [triggerChannel, setTriggerChannel] = useState("");
  const [tagName, setTagName] = useState("");
  const [leadStatus, setLeadStatus] = useState("");
  const [stopOn, setStopOn] = useState<string[]>(["reply", "conversion", "unsubscribe"]);
  const [steps, setSteps] = useState<Step[]>([{ ...EMPTY }]);
  const [busy, setBusy] = useState(false);
  const reset = () => { setEditing(null); setName(""); setTrigger("DELIVERY_FAILED"); setTriggerChannel(""); setTagName(""); setStopOn(["reply", "conversion", "unsubscribe"]); setSteps([{ ...EMPTY }]); };
  async function save() {
    setBusy(true);
    try {
      const body = { name, isActive: true, trigger, triggerConfig: { ...(triggerChannel ? { channel: triggerChannel } : {}), ...(tagName ? (trigger === "CONTACT_CREATED" ? { contactSource: tagName } : { tagName }) : {}), ...(leadStatus ? { leadStatus } : {}), marketingOnly: true }, stopOn, steps: steps.map((s) => ({ ...s, templateId: s.action === "task" ? undefined : s.templateId })) };
      if (editing) await api.put(`/api/sequences/${editing}`, body); else await api.post("/api/sequences", body);
      toast.success("הרצף נשמר"); setOpen(false); reset(); router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function toggle(s: SequenceRow) {
    try { await api.put(`/api/sequences/${s.id}`, { name: s.name, isActive: !s.isActive, trigger: s.trigger, triggerConfig: s.triggerConfig, stopOn: s.stopOn, steps: s.steps.map((st) => ({ action: st.action ?? "send", channel: st.channel, templateId: st.action === "task" ? undefined : st.templateId, waitMinutes: st.waitMinutes, variables: Object.fromEntries(Object.entries(st.variables ?? {}).filter(([k]) => !k.startsWith("__"))), condition: { requireNoReply: true, ...(st.condition ?? {}) }, taskTitle: st.variables?.__taskTitle, taskDueHours: st.variables?.__taskDueHours ? Number(st.variables.__taskDueHours) : undefined })) }); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }
  async function remove(s: SequenceRow) {
    if (!confirm(`למחוק את הרצף "${s.name}"? ריצות פעילות ייעצרו.`)) return;
    try { await api.delete(`/api/sequences/${s.id}`); router.refresh(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <section className="mt-8 space-y-3" data-testid="sequences">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-base font-semibold">רצפים בין ערוצים</h2><p className="text-xs text-muted-foreground">למשל: WhatsApp נכשל במסירה → המתנה → SMS. כל שלב נבדק מחדש מול הסכמה, הסרה גלובלית ומגבלת תדירות; תשובה, המרה או הסרה עוצרות את הרצף. מעבר ערוץ על בסיס &quot;אימייל לא נפתח&quot; אינו נתמך בכוונה.</p></div>
        <Button size="sm" onClick={() => { reset(); setOpen(true); }}>רצף חדש</Button>
      </div>
      {open && (
        <div className="rounded-xl border p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>שם</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label>טריגר</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={trigger} onChange={(e) => setTrigger(e.target.value)}>{Object.entries(TRIGGER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            {trigger === "TAG_ADDED" ? <div><Label>תגית</Label><Input list="seq-tags" value={tagName} onChange={(e) => setTagName(e.target.value)} /><datalist id="seq-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist></div>
              : trigger === "LEAD_STATUS_CHANGED" ? <div><Label>סטטוס יעד</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)}><option value="">כל סטטוס</option>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              : trigger === "CONTACT_CREATED" ? <div><Label>מקור (אופציונלי)</Label><Input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="למשל whatsapp / csv" /></div>
              : <div><Label>ערוץ מקור (אופציונלי)</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={triggerChannel} onChange={(e) => setTriggerChannel(e.target.value)}><option value="">כל ערוץ</option>{Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>}
          </div>
          <div className="flex flex-wrap gap-3 text-sm">{[["reply", "תשובת לקוח"], ["conversion", "המרה (עסקה נסגרה)"]].map(([k, v]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={stopOn.includes(k)} onChange={(e) => setStopOn(e.target.checked ? [...stopOn, k] : stopOn.filter((x) => x !== k))} />עצור ב-{v}</label>)}<span className="text-muted-foreground">הסרה תמיד עוצרת.</span></div>
          <div className="space-y-2">
            {steps.map((st, i) => (
              <div key={i} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-5 items-end">
                <div><Label>שלב {i + 1} – סוג</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={st.action} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, action: e.target.value as Step["action"] } : x))}><option value="send">שליחת הודעה</option><option value="task">משימת מעקב לנציג</option></select></div>
                {st.action === "task" ? <div className="sm:col-span-2"><Label>כותרת משימה</Label><Input value={st.taskTitle ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, taskTitle: e.target.value } : x))} placeholder="להתקשר ללקוח" /></div> : <>
                <div><Label>ערוץ</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={st.channel} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, channel: e.target.value as Step["channel"], templateId: "" } : x))}>{Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div><Label>תבנית</Label><select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={st.templateId} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, templateId: e.target.value } : x))}><option value="">בחר</option>{templates.filter((t) => t.channel === st.channel).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div></>}
                <div><Label>המתנה (דקות)</Label><Input type="number" min={0} value={st.waitMinutes} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, waitMinutes: Number(e.target.value) } : x))} /></div>
                <div className="flex gap-1"><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={st.condition.requireNoReply} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, requireNoReply: e.target.checked } } : x))} />רק אם אין תשובה</label>{steps.length > 1 && <Button variant="ghost" size="sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>הסר</Button>}</div>
                <details className="sm:col-span-5 text-xs"><summary className="cursor-pointer text-muted-foreground">תנאים נוספים לשלב (הסתעפות לפי נתוני לקוח)</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-4">
                    <div><Label className="text-xs">רק עם תגית</Label><Input list="seq-tags" value={st.condition.tagName ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, tagName: e.target.value || undefined } } : x))} /></div>
                    <div><Label className="text-xs">רק ללא תגית</Label><Input list="seq-tags" value={st.condition.notTagName ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, notTagName: e.target.value || undefined } } : x))} /></div>
                    <div><Label className="text-xs">רק בסטטוס ליד</Label><select className="mt-1 w-full rounded-md border bg-background p-1 text-xs" value={st.condition.leadStatus ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, leadStatus: e.target.value || undefined } } : x))}><option value="">ללא תנאי</option>{Object.entries({ ...LEAD_STATUS, none: "ללא ליד" }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                    <div className="flex gap-1"><Input placeholder="שדה מותאם" value={st.condition.customKey ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, customKey: e.target.value || undefined } } : x))} /><Input placeholder="= ערך" value={st.condition.customValue ?? ""} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, condition: { ...x.condition, customValue: e.target.value || undefined } } : x))} /></div>
                  </div>
                </details>
              </div>
            ))}
            {steps.length < 6 && <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { ...EMPTY }])}>+ שלב</Button>}
          </div>
          <div className="flex gap-2"><Button onClick={save} disabled={busy || !name.trim() || steps.some((s) => (s.action === "task" ? !(s.taskTitle ?? "").trim() : !s.templateId))}>שמור רצף</Button><Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>ביטול</Button></div>
        </div>
      )}
      {sequences.length === 0 ? <p className="text-sm text-muted-foreground">אין רצפים עדיין.</p> : (
        <ul className="space-y-2">{sequences.map((s) => (
          <li key={s.id} className="rounded-xl border p-3 text-sm" data-testid={`sequence-${s.id}`}>
            <div className="flex flex-wrap items-center gap-2"><b>{s.name}</b><span className="rounded-full border px-2 text-xs">{s.isActive ? "פעיל" : "כבוי"}</span><span className="text-muted-foreground">{TRIGGER[s.trigger]}{s.triggerConfig.channel ? ` · ${CHANNEL_LABELS[s.triggerConfig.channel]}` : ""}{s.triggerConfig.tagName ? ` · ${s.triggerConfig.tagName}` : ""} · {s._count.runs} ריצות</span>
              <span className="ms-auto flex gap-1"><Button variant="ghost" size="sm" onClick={() => toggle(s)}>{s.isActive ? "כבה" : "הפעל"}</Button><Button variant="ghost" size="sm" onClick={() => { setEditing(s.id); setName(s.name); setTrigger(s.trigger); setTriggerChannel(s.triggerConfig.channel ?? ""); setTagName(s.triggerConfig.tagName ?? ""); setStopOn(s.stopOn); setLeadStatus(s.triggerConfig.leadStatus ?? ""); if (s.triggerConfig.contactSource) setTagName(s.triggerConfig.contactSource); setSteps(s.steps.map((st) => ({ action: (st.action as Step["action"]) ?? "send", channel: st.channel as Step["channel"], templateId: st.templateId, waitMinutes: st.waitMinutes, variables: Object.fromEntries(Object.entries(st.variables ?? {}).filter(([k]) => !k.startsWith("__"))), condition: { requireNoReply: true, ...(st.condition ?? {}) }, taskTitle: st.variables?.__taskTitle, taskDueHours: st.variables?.__taskDueHours ? Number(st.variables.__taskDueHours) : undefined }))); setOpen(true); }}>עריכה</Button><Button variant="ghost" size="sm" onClick={() => remove(s)}>מחק</Button></span></div>
            <ol className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">{s.steps.map((st) => <li key={st.position} className="rounded bg-muted px-2 py-0.5">{st.position + 1}. המתנה {st.waitMinutes} דק׳ → {st.action === "task" ? `משימה: ${st.variables?.__taskTitle ?? ""}` : `${CHANNEL_LABELS[st.channel]}: ${st.template.name}`}</li>)}</ol>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
