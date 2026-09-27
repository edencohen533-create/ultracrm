"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, Textarea } from "@/components/ui";
import type { Overview } from "./AiAssistant";

type Policy = "auto" | "approve" | "off";
interface S { name: string; language: "he" | "en"; tone: "friendly" | "formal" | "short"; length: "short" | "normal" | "detailed"; agentsCanChat: boolean; managerIds: string[]; autoRepairs: boolean; actions: Record<"create_task" | "set_follow_up" | "change_lead_status" | "transfer_lead", Policy>; service: { enabled: boolean; credentialIds: string[]; hours: { start: string; end: string; days: number[] }; handoffTopics: string[]; allowOrderStatus: boolean; maxRepliesPerConversationPerHour: number; dailyReplyLimit: number; offHoursMessage: string }; limits: { dailyChatMessagesPerUser: number } }
interface Data { settings: S; connected: boolean; users: Array<{ id: string; fullName: string; role: string }>; channels: Array<{ id: string; label: string; status: string; active: boolean; simulated: boolean }>; usage: { chatAnswers30d: number; serviceReplies24h: number } }
interface ActionRow { id: string; summary: string; status: string; channel: string; requestedBy: string | null; approvedBy: string | null; createdAt: string; error: string | null }
const ACTIONS: Record<keyof S["actions"], string> = { create_task: "פתיחת משימה", set_follow_up: "קביעת פולואפ", change_lead_status: "שינוי סטטוס ליד", transfer_lead: "העברת ליד לנציג" };
const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export function SettingsTab({ overview, onSaved }: { overview: Overview; onSaved: () => void }) {
  const [d, setD] = useState<Data | null>(null); const [s, setS] = useState<S | null>(null); const [saving, setSaving] = useState(false); const [log, setLog] = useState<ActionRow[]>([]);
  const load = useCallback(async () => { try { const r = await api.get<Data>("/api/ai/settings"); setD(r); setS(r.settings); setLog((await api.get<{ items: ActionRow[] }>("/api/ai/actions")).items); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!d || !s) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const isOwner = overview.role === "owner";
  async function save() {
    if (s!.service.enabled && !d!.settings.service.enabled && !confirm("להפעיל את נציג השירות מול לקוחות? ודאו שבדקתם אותו ב״בדוק את העוזר״ ובערוץ בדיקה.")) return;
    setSaving(true);
    try { const r = await api.put<{ settings: S }>("/api/ai/settings", s); setS(r.settings); toast.success("ההגדרות נשמרו"); onSaved(); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  const set = (p: Partial<S>) => setS({ ...s, ...p }); const svc = (p: Partial<S["service"]>) => setS({ ...s, service: { ...s.service, ...p } });
  const managers = d.users.filter((u) => u.role !== "agent");
  return (
    <div className="space-y-4" data-testid="ai-settings">
      <Panel title="כללי">
        <div className="grid md:grid-cols-4 gap-3">
          <Input label="שם העוזר" value={s.name} onChange={(e) => set({ name: e.target.value })} />
          <Select label="שפה" value={s.language} onChange={(e) => set({ language: e.target.value as S["language"] })}><option value="he">עברית</option><option value="en">English</option></Select>
          <Select label="טון" value={s.tone} onChange={(e) => set({ tone: e.target.value as S["tone"] })}><option value="friendly">ידידותי</option><option value="formal">רשמי</option><option value="short">תמציתי</option></Select>
          <Select label="אורך תשובות" value={s.length} onChange={(e) => set({ length: e.target.value as S["length"] })}><option value="short">קצר</option><option value="normal">רגיל</option><option value="detailed">מפורט</option></Select>
        </div>
        <div className="mt-3 text-sm flex items-center gap-2">חיבור למודל: {d.connected ? <Badge tone="good">מחובר</Badge> : <Badge tone="warn">נדרש חיבור</Badge>}<span className="text-xs text-muted">המפתח נשמר בשרת בלבד ואינו מוצג כאן.</span></div>
      </Panel>
      <Panel title="מי משתמש בעוזר">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.agentsCanChat} onChange={(e) => set({ agentsCanChat: e.target.checked })} data-testid="ai-agents-can-chat" /> נציגים יכולים להשתמש בעוזר (רק על הלידים, המשימות והעסקאות שלהם)</label>
        <div className="mt-3 text-sm">מנהלי העוזר (ידע, אוטומציות, הגדרות ואישורים){!isOwner && <span className="text-xs text-muted"> – רק הבעלים יכול לשנות</span>}:
          <div className="flex flex-wrap gap-3 mt-1">{managers.map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" disabled={!isOwner || u.role === "owner"} checked={u.role === "owner" || !s.managerIds.length || s.managerIds.includes(u.id)} onChange={(e) => { const all = s.managerIds.length ? s.managerIds : managers.filter((m) => m.role === "manager").map((m) => m.id); set({ managerIds: e.target.checked ? [...new Set([...all, u.id])] : all.filter((x) => x !== u.id) }); }} />{u.fullName}</label>)}</div></div>
      </Panel>
      <Panel title="פעולות מהצ׳אט">
        <table className="text-sm"><tbody>{(Object.keys(ACTIONS) as Array<keyof S["actions"]>).map((k) => <tr key={k}><td className="py-1 pe-4">{ACTIONS[k]}</td><td><Select aria-label={ACTIONS[k]} value={s.actions[k]} onChange={(e) => set({ actions: { ...s.actions, [k]: e.target.value as Policy } })} className="w-52"><option value="auto">לבצע מיד</option><option value="approve">לבצע רק אחרי אישור</option><option value="off">לא לאפשר</option></Select></td></tr>)}</tbody></table>
        <p className="text-xs text-muted mt-2">אוטומציות, החלה על נתונים קיימים, פעולות רחבות או בלתי הפיכות ותיקונים שמשנים התנהגות – תמיד דורשים אישור מפורש עם סיכום השפעה.</p>
        <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={s.autoRepairs} onChange={(e) => set({ autoRepairs: e.target.checked })} /> לאפשר תיקונים מוגבלים והפיכים ללא אישור (שחרור נעילה תקועה, סנכרון פולואפ לתור)</label>
      </Panel>
      <Panel title="נציג שירות ב-WhatsApp (מול לקוחות)">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.service.enabled} onChange={(e) => svc({ enabled: e.target.checked })} data-testid="ai-service-enabled" /> הפעלת מענה אוטומטי ללקוחות {!d.connected && <Badge tone="warn">נדרש חיבור – לא יענה עד שיוגדר מודל</Badge>}</label>
        <div className="mt-2 text-sm">ערוצים:{!d.channels.length && <span className="text-muted"> לא הוגדר ערוץ WhatsApp</span>}<div className="flex flex-wrap gap-3 mt-1"><label className="flex items-center gap-1"><input type="checkbox" checked={s.service.credentialIds.includes("demo")} onChange={(e) => svc({ credentialIds: e.target.checked ? [...s.service.credentialIds, "demo"] : s.service.credentialIds.filter((x) => x !== "demo") })} data-testid="ai-service-demo" />סימולטור הדגמה <Badge tone="info">בדיקה – ללא שליחה אמיתית</Badge></label>{d.channels.map((c) => <label key={c.id} className="flex items-center gap-1"><input type="checkbox" checked={s.service.credentialIds.includes(c.id)} onChange={(e) => svc({ credentialIds: e.target.checked ? [...s.service.credentialIds, c.id] : s.service.credentialIds.filter((x) => x !== c.id) })} />{c.label} <Badge tone={c.status === "connected" ? "good" : "warn"}>{c.simulated ? "סימולציה" : c.status}</Badge></label>)}</div></div>
        <div className="grid md:grid-cols-4 gap-3 mt-3">
          <Input label="שעת התחלה" type="time" value={s.service.hours.start} onChange={(e) => svc({ hours: { ...s.service.hours, start: e.target.value } })} />
          <Input label="שעת סיום" type="time" value={s.service.hours.end} onChange={(e) => svc({ hours: { ...s.service.hours, end: e.target.value } })} />
          <Input label="מקס׳ תשובות לשיחה בשעה" type="number" value={s.service.maxRepliesPerConversationPerHour} onChange={(e) => svc({ maxRepliesPerConversationPerHour: Number(e.target.value) })} />
          <Input label="מקס׳ תשובות ביום" type="number" value={s.service.dailyReplyLimit} onChange={(e) => svc({ dailyReplyLimit: Number(e.target.value) })} />
        </div>
        <div className="flex gap-2 mt-2 text-sm">{DAYS.map((l, i) => <label key={i} className="flex items-center gap-1"><input type="checkbox" checked={s.service.hours.days.includes(i)} onChange={(e) => svc({ hours: { ...s.service.hours, days: e.target.checked ? [...s.service.hours.days, i].sort() : s.service.hours.days.filter((x) => x !== i) } })} />{l}</label>)}</div>
        <Input className="mt-3" label="נושאים שתמיד מועברים לנציג (מופרדים בפסיק)" value={s.service.handoffTopics.join(", ")} onChange={(e) => svc({ handoffTopics: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
        <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={s.service.allowOrderStatus} onChange={(e) => svc({ allowOrderStatus: e.target.checked })} /> מסירת סטטוס הזמנה – רק ללקוח שכותב מהטלפון של ההזמנה ומוסר את מספרה</label>
        <Textarea className="mt-2" label="הודעה מחוץ לשעות (ריק = לא לענות)" rows={2} value={s.service.offHoursMessage} onChange={(e) => svc({ offHoursMessage: e.target.value })} />
        <p className="text-xs text-muted mt-2">העברה לנציג מתבצעת כשהלקוח מבקש, כשאין מידע מאושר מספיק, כשנדרשת פעולה שאינה מותרת, או בנושאים שהוגדרו. תשובת נציג אנושי בשיחה עוצרת את המענה האוטומטי.</p>
      </Panel>
      <Panel title="מגבלות ושימוש">
        <div className="grid md:grid-cols-3 gap-3 items-end"><Input label="הודעות לעוזר למשתמש ביום" type="number" value={s.limits.dailyChatMessagesPerUser} onChange={(e) => set({ limits: { dailyChatMessagesPerUser: Number(e.target.value) } })} />
          <div className="text-sm">תשובות עוזר (30 יום): <b>{d.usage.chatAnswers30d}</b></div><div className="text-sm">תשובות שירות (24 שעות): <b>{d.usage.serviceReplies24h}</b></div></div>
      </Panel>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="ai-settings-save">שמור הגדרות</Button></div>
      <Panel title="יומן פעולות (מי ביקש, מי אישר, מה בוצע)">
        {!log.length ? <p className="text-sm text-muted">אין פעולות</p> : <table className="w-full text-xs" data-testid="ai-action-log"><thead className="text-muted"><tr><th className="text-start">זמן</th><th className="text-start">פעולה</th><th className="text-start">ערוץ</th><th className="text-start">ביקש</th><th className="text-start">אישר</th><th className="text-start">תוצאה</th></tr></thead><tbody className="divide-y divide-line">
          {log.slice(0, 50).map((a) => <tr key={a.id}><td className="py-1 whitespace-nowrap">{new Date(a.createdAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}</td><td>{a.summary}</td><td>{a.channel === "whatsapp_service" ? "שירות לקוחות" : a.channel === "whatsapp" ? "WhatsApp" : "צ׳אט"}</td><td>{a.requestedBy ?? "—"}</td><td>{a.approvedBy ?? "—"}</td><td>{a.status}{a.error ? ` – ${a.error}` : ""}</td></tr>)}
        </tbody></table>}
      </Panel>
    </div>
  );
}
