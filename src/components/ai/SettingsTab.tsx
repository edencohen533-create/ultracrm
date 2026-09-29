"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner, Textarea } from "@/components/ui";
import type { Overview } from "./AiAssistant";
import { useT } from "@/components/i18n/LangProvider";

type Policy = "auto" | "approve" | "off";
interface S { name: string; language: "he" | "en"; tone: "friendly" | "formal" | "short"; length: "short" | "normal" | "detailed"; agentsCanChat: boolean; managerIds: string[]; autoRepairs: boolean; actions: Record<"create_task" | "set_follow_up" | "change_lead_status" | "transfer_lead", Policy>; service: { enabled: boolean; credentialIds: string[]; hours: { start: string; end: string; days: number[] }; qualificationQuestions: string[]; handoffTopics: string[]; allowOrderStatus: boolean; maxRepliesPerConversationPerHour: number; dailyReplyLimit: number; offHoursMessage: string }; limits: { dailyChatMessagesPerUser: number } }
interface Data { settings: S; connected: boolean; users: Array<{ id: string; fullName: string; role: string }>; channels: Array<{ id: string; label: string; status: string; active: boolean; simulated: boolean }>; usage: { chatAnswers30d: number; serviceReplies24h: number } }
interface ActionRow { id: string; summary: string; status: string; channel: string; requestedBy: string | null; approvedBy: string | null; createdAt: string; error: string | null }
const ACTIONS: Record<keyof S["actions"], [string, string]> = { create_task: ["פתיחת משימה", "Create a task"], set_follow_up: ["קביעת פולואפ", "Set a follow-up"], change_lead_status: ["שינוי סטטוס ליד", "Change lead status"], transfer_lead: ["העברת ליד לנציג", "Transfer lead to an agent"] };
const DAYS: Array<[string, string]> = [["א׳", "Sun"], ["ב׳", "Mon"], ["ג׳", "Tue"], ["ד׳", "Wed"], ["ה׳", "Thu"], ["ו׳", "Fri"], ["ש׳", "Sat"]];

export function SettingsTab({ overview, onSaved }: { overview: Overview; onSaved: () => void }) {
  const t = useT();
  const [d, setD] = useState<Data | null>(null); const [s, setS] = useState<S | null>(null); const [saving, setSaving] = useState(false); const [log, setLog] = useState<ActionRow[]>([]);
  const load = useCallback(async () => { try { const r = await api.get<Data>("/api/ai/settings"); setD(r); setS(r.settings); setLog((await api.get<{ items: ActionRow[] }>("/api/ai/actions")).items); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!d || !s) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const isOwner = overview.role === "owner";
  async function save() {
    if (s!.service.enabled && !d!.settings.service.enabled && !confirm(t("להפעיל את נציג השירות מול לקוחות? ודאו שבדקתם אותו ב״בדוק את העוזר״ ובערוץ בדיקה.", "Turn on the customer-facing service agent? Make sure you tested it in “Test the assistant” and on a test channel."))) return;
    setSaving(true);
    try { const r = await api.put<{ settings: S }>("/api/ai/settings", s); setS(r.settings); toast.success(t("ההגדרות נשמרו", "Settings saved")); onSaved(); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  const set = (p: Partial<S>) => setS({ ...s, ...p }); const svc = (p: Partial<S["service"]>) => setS({ ...s, service: { ...s.service, ...p } });
  const managers = d.users.filter((u) => u.role !== "agent");
  return (
    <div className="space-y-4" data-testid="ai-settings">
      <Panel title={t("כללי", "General")}>
        <div className="grid md:grid-cols-4 gap-3">
          <Input label={t("שם העוזר", "Assistant name")} value={s.name} onChange={(e) => set({ name: e.target.value })} />
          <Select label={t("שפה", "Language")} value={s.language} onChange={(e) => set({ language: e.target.value as S["language"] })}><option value="he">{t("עברית", "Hebrew")}</option><option value="en">English</option></Select>
          <Select label={t("טון", "Tone")} value={s.tone} onChange={(e) => set({ tone: e.target.value as S["tone"] })}><option value="friendly">{t("ידידותי", "Friendly")}</option><option value="formal">{t("רשמי", "Formal")}</option><option value="short">{t("תמציתי", "Concise")}</option></Select>
          <Select label={t("אורך תשובות", "Answer length")} value={s.length} onChange={(e) => set({ length: e.target.value as S["length"] })}><option value="short">{t("קצר", "Short")}</option><option value="normal">{t("רגיל", "Normal")}</option><option value="detailed">{t("מפורט", "Detailed")}</option></Select>
        </div>
        <div className="mt-3 text-sm flex items-center gap-2">{t("חיבור למודל:", "Model connection:")} {d.connected ? <Badge tone="good">{t("מחובר", "Connected")}</Badge> : <Badge tone="warn">{t("נדרש חיבור", "Connection required")}</Badge>}<span className="text-xs text-muted">{t("המפתח נשמר בשרת בלבד ואינו מוצג כאן.", "The key is stored on the server only and is not shown here.")}</span></div>
      </Panel>
      <Panel title={t("מי משתמש בעוזר", "Who uses the assistant")}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.agentsCanChat} onChange={(e) => set({ agentsCanChat: e.target.checked })} data-testid="ai-agents-can-chat" /> {t("נציגים יכולים להשתמש בעוזר (רק על הלידים, המשימות והעסקאות שלהם)", "Agents can use the assistant (only on their own leads, tasks and deals)")}</label>
        <div className="mt-3 text-sm">{t("מנהלי העוזר (ידע, אוטומציות, הגדרות ואישורים)", "Assistant managers (knowledge, automations, settings and approvals)")}{!isOwner && <span className="text-xs text-muted"> – {t("רק הבעלים יכול לשנות", "only the owner can change this")}</span>}:
          <div className="flex flex-wrap gap-3 mt-1">{managers.map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" disabled={!isOwner || u.role === "owner"} checked={u.role === "owner" || !s.managerIds.length || s.managerIds.includes(u.id)} onChange={(e) => { const all = s.managerIds.length ? s.managerIds : managers.filter((m) => m.role === "manager").map((m) => m.id); set({ managerIds: e.target.checked ? [...new Set([...all, u.id])] : all.filter((x) => x !== u.id) }); }} />{u.fullName}</label>)}</div></div>
      </Panel>
      <Panel title={t("פעולות מהצ׳אט", "Actions from chat")}>
        <table className="text-sm"><tbody>{(Object.keys(ACTIONS) as Array<keyof S["actions"]>).map((k) => <tr key={k}><td className="py-1 pe-4">{t(ACTIONS[k][0], ACTIONS[k][1])}</td><td><Select aria-label={t(ACTIONS[k][0], ACTIONS[k][1])} value={s.actions[k]} onChange={(e) => set({ actions: { ...s.actions, [k]: e.target.value as Policy } })} className="w-52"><option value="auto">{t("לבצע מיד", "Run immediately")}</option><option value="approve">{t("לבצע רק אחרי אישור", "Run only after approval")}</option><option value="off">{t("לא לאפשר", "Don't allow")}</option></Select></td></tr>)}</tbody></table>
        <p className="text-xs text-muted mt-2">{t("אוטומציות, החלה על נתונים קיימים, פעולות רחבות או בלתי הפיכות ותיקונים שמשנים התנהגות – תמיד דורשים אישור מפורש עם סיכום השפעה.", "Automations, applying to existing data, broad or irreversible actions, and fixes that change behavior always require explicit approval with an impact summary.")}</p>
        <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={s.autoRepairs} onChange={(e) => set({ autoRepairs: e.target.checked })} /> {t("לאפשר תיקונים מוגבלים והפיכים ללא אישור (שחרור נעילה תקועה, סנכרון פולואפ לתור)", "Allow limited, reversible fixes without approval (releasing a stuck lock, syncing a follow-up to the queue)")}</label>
      </Panel>
      <Panel title={t("נציג שירות ב-WhatsApp (מול לקוחות)", "WhatsApp service agent (customer-facing)")}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.service.enabled} onChange={(e) => svc({ enabled: e.target.checked })} data-testid="ai-service-enabled" /> {t("הפעלת מענה אוטומטי ללקוחות", "Enable automatic replies to customers")} {!d.connected && <Badge tone="warn">{t("נדרש חיבור – לא יענה עד שיוגדר מודל", "Connection required – won't reply until a model is configured")}</Badge>}</label>
        <div className="mt-2 text-sm">{t("ערוצים:", "Channels:")}{!d.channels.length && <span className="text-muted"> {t("לא הוגדר ערוץ WhatsApp", "No WhatsApp channel configured")}</span>}<div className="flex flex-wrap gap-3 mt-1"><label className="flex items-center gap-1"><input type="checkbox" checked={s.service.credentialIds.includes("demo")} onChange={(e) => svc({ credentialIds: e.target.checked ? [...s.service.credentialIds, "demo"] : s.service.credentialIds.filter((x) => x !== "demo") })} data-testid="ai-service-demo" />{t("סימולטור הדגמה", "Demo simulator")} <Badge tone="info">{t("בדיקה – ללא שליחה אמיתית", "Test – no real sending")}</Badge></label>{d.channels.map((c) => <label key={c.id} className="flex items-center gap-1"><input type="checkbox" checked={s.service.credentialIds.includes(c.id)} onChange={(e) => svc({ credentialIds: e.target.checked ? [...s.service.credentialIds, c.id] : s.service.credentialIds.filter((x) => x !== c.id) })} />{c.label} <Badge tone={c.status === "connected" ? "good" : "warn"}>{c.simulated ? t("סימולציה", "Simulation") : c.status}</Badge></label>)}</div></div>
        <div className="grid md:grid-cols-4 gap-3 mt-3">
          <Input label={t("שעת התחלה", "Start time")} type="time" value={s.service.hours.start} onChange={(e) => svc({ hours: { ...s.service.hours, start: e.target.value } })} />
          <Input label={t("שעת סיום", "End time")} type="time" value={s.service.hours.end} onChange={(e) => svc({ hours: { ...s.service.hours, end: e.target.value } })} />
          <Input label={t("מקס׳ תשובות לשיחה בשעה", "Max replies per conversation per hour")} type="number" value={s.service.maxRepliesPerConversationPerHour} onChange={(e) => svc({ maxRepliesPerConversationPerHour: Number(e.target.value) })} />
          <Input label={t("מקס׳ תשובות ביום", "Max replies per day")} type="number" value={s.service.dailyReplyLimit} onChange={(e) => svc({ dailyReplyLimit: Number(e.target.value) })} />
        </div>
        <div className="flex gap-2 mt-2 text-sm">{DAYS.map(([lhe, len], i) => <label key={i} className="flex items-center gap-1"><input type="checkbox" checked={s.service.hours.days.includes(i)} onChange={(e) => svc({ hours: { ...s.service.hours, days: e.target.checked ? [...s.service.hours.days, i].sort() : s.service.hours.days.filter((x) => x !== i) } })} />{t(lhe, len)}</label>)}</div>
        <Textarea className="mt-3" label="שאלות סינון למכירה — שאלה בכל שורה, עד 8" value={s.service.qualificationQuestions.join("\n")} onChange={e=>svc({qualificationQuestions:e.target.value.split("\n")})}/><p className="text-xs text-muted">השאר ריק לביטול הסינון. העוזר שומר תשובות מצוטטות מהלקוח ומעביר לנציג לאחר השלמת השאלות. אין לבקש פרטי כרטיס אשראי או סיסמאות.</p>
        <Input className="mt-3" label={t("נושאים שתמיד מועברים לנציג (מופרדים בפסיק)", "Topics always handed off to an agent (comma-separated)")} value={s.service.handoffTopics.join(", ")} onChange={(e) => svc({ handoffTopics: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
        <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={s.service.allowOrderStatus} onChange={(e) => svc({ allowOrderStatus: e.target.checked })} /> {t("מסירת סטטוס הזמנה – רק ללקוח שכותב מהטלפון של ההזמנה ומוסר את מספרה", "Share order status – only with a customer writing from the order's phone who provides the order number")}</label>
        <Textarea className="mt-2" label={t("הודעה מחוץ לשעות (ריק = לא לענות)", "Off-hours message (empty = don't reply)")} rows={2} value={s.service.offHoursMessage} onChange={(e) => svc({ offHoursMessage: e.target.value })} />
        <p className="text-xs text-muted mt-2">{t("העברה לנציג מתבצעת כשהלקוח מבקש, כשאין מידע מאושר מספיק, כשנדרשת פעולה שאינה מותרת, או בנושאים שהוגדרו. תשובת נציג אנושי בשיחה עוצרת את המענה האוטומטי.", "Handoff to an agent happens when the customer asks, when there isn't enough approved info, when a disallowed action is needed, or for the configured topics. A human agent's reply in the conversation stops automatic replies.")}</p>
      </Panel>
      <Panel title={t("מגבלות ושימוש", "Limits & usage")}>
        <div className="grid md:grid-cols-3 gap-3 items-end"><Input label={t("הודעות לעוזר למשתמש ביום", "Assistant messages per user per day")} type="number" value={s.limits.dailyChatMessagesPerUser} onChange={(e) => set({ limits: { dailyChatMessagesPerUser: Number(e.target.value) } })} />
          <div className="text-sm">{t("תשובות עוזר (30 יום):", "Assistant answers (30 days):")} <b>{d.usage.chatAnswers30d}</b></div><div className="text-sm">{t("תשובות שירות (24 שעות):", "Service replies (24 hours):")} <b>{d.usage.serviceReplies24h}</b></div></div>
      </Panel>
      <div className="flex justify-end"><Button onClick={save} loading={saving} data-testid="ai-settings-save">{t("שמור הגדרות", "Save settings")}</Button></div>
      <Panel title={t("יומן פעולות (מי ביקש, מי אישר, מה בוצע)", "Action log (who requested, who approved, what ran)")}>
        {!log.length ? <p className="text-sm text-muted">{t("אין פעולות", "No actions")}</p> : <table className="w-full text-xs" data-testid="ai-action-log"><thead className="text-muted"><tr><th className="text-start">{t("זמן", "Time")}</th><th className="text-start">{t("פעולה", "Action")}</th><th className="text-start">{t("ערוץ", "Channel")}</th><th className="text-start">{t("ביקש", "Requested by")}</th><th className="text-start">{t("אישר", "Approved by")}</th><th className="text-start">{t("תוצאה", "Result")}</th></tr></thead><tbody className="divide-y divide-line">
          {log.slice(0, 50).map((a) => <tr key={a.id}><td className="py-1 whitespace-nowrap">{new Date(a.createdAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { dateStyle: "short", timeStyle: "short" })}</td><td>{a.summary}</td><td>{a.channel === "whatsapp_service" ? t("שירות לקוחות", "Customer service") : a.channel === "whatsapp" ? "WhatsApp" : t("צ׳אט", "Chat")}</td><td>{a.requestedBy ?? "—"}</td><td>{a.approvedBy ?? "—"}</td><td>{a.status}{a.error ? ` – ${a.error}` : ""}</td></tr>)}
        </tbody></table>}
      </Panel>
    </div>
  );
}
