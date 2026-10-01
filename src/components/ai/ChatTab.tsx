"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Send, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button, Spinner, Textarea, cx } from "@/components/ui";
import { ActionCard, type AiActionView } from "./ActionCard";
import type { Overview } from "./AiAssistant";
import { useT } from "@/components/i18n/LangProvider";

interface Msg { id: string; role: string; text: string; createdAt: string; actions: AiActionView[] }
interface Conv { id: string; title: string; updatedAt: string }

const EXAMPLES_AGENT: Array<[string, string]> = [["כמה לידים יש לי היום?", "How many leads do I have today?"], ["תפתח לי משימה לחזור לדני מחר ב-10:00", "Open a task for me to call Danny back tomorrow at 10:00"], ["למה אני לא רואה את הליד של 0501234567?", "Why can’t I see the lead for 0501234567?"]];
const EXAMPLES_MANAGER: Array<[string, string]> = [["איך הולך היום?", "How is today going?"], ["כמה לידים יש לכל נציג היום?", "How many leads does each agent have today?"], ["כל ליד שעובר לסטטוס 'לא ענה' – לשלוח לו וואטסאפ", "Every lead that moves to 'No answer' status – send them a WhatsApp"], ["למה דני לא קיבל את ההודעה אחרי שינוי הסטטוס?", "Why didn’t Danny get the message after the status change?"]];

export function ChatTab({ overview }: { overview: Overview }) {
  const t = useT();
  const [convs, setConvs] = useState<Conv[]>([]); const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]); const [text, setText] = useState(""); const [sending, setSending] = useState(false); const [loading, setLoading] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const loadConvs = useCallback(async () => { try { setConvs((await api.get<{ items: Conv[] }>("/api/ai/conversations")).items); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void loadConvs(); }, [loadConvs]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, sending]);
  async function open(id: string) {
    setLoading(true); setCid(id);
    try { setMsgs((await api.get<{ messages: Msg[] }>(`/api/ai/conversations/${id}`)).messages); } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  }
  async function remove(id: string) {
    try { await api.delete(`/api/ai/conversations/${id}`); if (cid === id) { setCid(null); setMsgs([]); } await loadConvs(); } catch (e) { toast.error((e as Error).message); }
  }
  async function send(input = text) {
    const q = input.trim(); if (!q || sending) return;
    setText(""); setSending(true);
    setMsgs((m) => [...m, { id: `tmp${Date.now()}`, role: "user", text: q, createdAt: new Date().toISOString(), actions: [] }]);
    try {
      const r = await api.post<{ conversationId: string; message: Msg }>("/api/ai/chat", { conversationId: cid, text: q });
      if (!cid) { setCid(r.conversationId); void loadConvs(); }
      setMsgs((m) => [...m, r.message]);
    } catch (e) { toast.error((e as Error).message); setMsgs((m) => [...m, { id: `err${Date.now()}`, role: "assistant", text: `⚠️ ${(e as Error).message}`, createdAt: new Date().toISOString(), actions: [] }]); }
    finally { setSending(false); }
  }
  const examples = (overview.role === "agent" ? EXAMPLES_AGENT : EXAMPLES_MANAGER).map(([he, en]) => t(he, en));
  return (
    <div className="grid min-w-0 md:grid-cols-[220px_minmax(0,1fr)] gap-4 min-h-[60vh]" data-testid="ai-chat">
      <aside className="space-y-2">
        <Button className="w-full" icon={<Plus size={15} />} onClick={() => { setCid(null); setMsgs([]); }} data-testid="ai-new-chat">{t("שיחה חדשה", "New conversation")}</Button>
        <div className="space-y-0.5 max-h-[60vh] overflow-y-auto" data-testid="ai-history">
          {convs.map((c) => <div key={c.id} className={cx("group flex items-center rounded-md", cid === c.id ? "bg-accent/10" : "hover:bg-panel-2")}>
            <button className="flex-1 text-start px-2 py-1.5 text-sm truncate" onClick={() => open(c.id)} title={c.title}>{c.title}</button>
            <button className="opacity-0 group-hover:opacity-100 px-1.5 text-muted hover:text-bad" aria-label={t("מחיקת שיחה", "Delete conversation")} onClick={() => remove(c.id)}><Trash2 size={14} /></button>
          </div>)}
          {!convs.length && <p className="text-xs text-muted px-2">{t("אין שיחות קודמות", "No previous conversations")}</p>}
        </div>
      </aside>
      <section className="flex min-w-0 flex-col rounded-xl border border-line bg-panel min-h-[60vh]">
        <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="ai-messages">
          {loading && <div className="flex justify-center py-6"><Spinner /></div>}
          {!loading && !msgs.length && <div className="text-center py-10 space-y-3">
            <p className="text-muted text-sm">{t("שאלו על הנתונים שלכם, בקשו פעולה חד-פעמית או אוטומציה מתמשכת. כל פעולה מוצגת ככרטיס עם הסטטוס האמיתי מהשרת.", "Ask about your data, request a one-off action or an ongoing automation. Every action is shown as a card with its real status from the server.")}</p>
            <div className="flex flex-wrap justify-center gap-2">{examples.map((e) => <button key={e} className="text-xs rounded-full border border-line px-3 py-1.5 hover:bg-panel-2" onClick={() => send(e)}>{e}</button>)}</div>
          </div>}
          {msgs.map((m) => <div key={m.id} className={cx("flex", m.role === "user" ? "justify-start" : "justify-end")}>
            <div className={cx("min-w-0 space-y-2", m.role === "user" ? "max-w-[85%]" : "w-full")}>
              <div dir="auto" className={cx("rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", m.role === "user" ? "bg-accent text-white" : "bg-panel-2")} data-testid={m.role === "user" ? "ai-msg-user" : "ai-msg-assistant"}>{m.text}</div>
              {m.actions?.map((a) => <ActionCard key={a.id} action={a} />)}
            </div>
          </div>)}
          {sending && <div className="flex justify-end"><div className="rounded-2xl px-3.5 py-2 bg-panel-2"><Spinner /></div></div>}
          <div ref={end} />
        </div>
        <form className="border-t border-line p-3 flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="min-w-0 flex-1"><Textarea aria-label={t("הודעה לעוזר", "Message to the assistant")} rows={3} className="min-h-[4.5rem]" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={t("כתבו לעוזר…", "Write to the assistant…")} data-testid="ai-input" /></div>
          <Button type="submit" loading={sending} icon={<Send size={15} />} data-testid="ai-send">{t("שלח", "Send")}</Button>
        </form>
      </section>
    </div>
  );
}
