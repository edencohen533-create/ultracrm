"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Send, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button, Spinner, Textarea, cx } from "@/components/ui";
import { ActionCard, type AiActionView } from "./ActionCard";
import type { Overview } from "./AiAssistant";

interface Msg { id: string; role: string; text: string; createdAt: string; actions: AiActionView[] }
interface Conv { id: string; title: string; updatedAt: string }

const EXAMPLES_AGENT = ["כמה לידים יש לי היום?", "תפתח לי משימה לחזור לדני מחר ב-10:00", "למה אני לא רואה את הליד של 0501234567?"];
const EXAMPLES_MANAGER = ["איך הולך היום?", "כמה לידים יש לכל נציג היום?", "כל ליד שעובר לסטטוס 'לא ענה' – לשלוח לו וואטסאפ", "למה דני לא קיבל את ההודעה אחרי שינוי הסטטוס?"];

export function ChatTab({ overview }: { overview: Overview }) {
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
  async function send(t = text) {
    const q = t.trim(); if (!q || sending) return;
    setText(""); setSending(true);
    setMsgs((m) => [...m, { id: `tmp${Date.now()}`, role: "user", text: q, createdAt: new Date().toISOString(), actions: [] }]);
    try {
      const r = await api.post<{ conversationId: string; message: Msg }>("/api/ai/chat", { conversationId: cid, text: q });
      if (!cid) { setCid(r.conversationId); void loadConvs(); }
      setMsgs((m) => [...m, r.message]);
    } catch (e) { toast.error((e as Error).message); setMsgs((m) => [...m, { id: `err${Date.now()}`, role: "assistant", text: `⚠️ ${(e as Error).message}`, createdAt: new Date().toISOString(), actions: [] }]); }
    finally { setSending(false); }
  }
  const examples = overview.role === "agent" ? EXAMPLES_AGENT : EXAMPLES_MANAGER;
  return (
    <div className="grid md:grid-cols-[220px_1fr] gap-4 min-h-[60vh]" data-testid="ai-chat">
      <aside className="space-y-2">
        <Button className="w-full" icon={<Plus size={15} />} onClick={() => { setCid(null); setMsgs([]); }} data-testid="ai-new-chat">שיחה חדשה</Button>
        <div className="space-y-0.5 max-h-[60vh] overflow-y-auto" data-testid="ai-history">
          {convs.map((c) => <div key={c.id} className={cx("group flex items-center rounded-md", cid === c.id ? "bg-accent/10" : "hover:bg-panel-2")}>
            <button className="flex-1 text-start px-2 py-1.5 text-sm truncate" onClick={() => open(c.id)} title={c.title}>{c.title}</button>
            <button className="opacity-0 group-hover:opacity-100 px-1.5 text-muted hover:text-bad" aria-label="מחיקת שיחה" onClick={() => remove(c.id)}><Trash2 size={14} /></button>
          </div>)}
          {!convs.length && <p className="text-xs text-muted px-2">אין שיחות קודמות</p>}
        </div>
      </aside>
      <section className="flex flex-col rounded-xl border border-line bg-panel min-h-[60vh]">
        <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="ai-messages">
          {loading && <div className="flex justify-center py-6"><Spinner /></div>}
          {!loading && !msgs.length && <div className="text-center py-10 space-y-3">
            <p className="text-muted text-sm">שאלו על הנתונים שלכם, בקשו פעולה חד-פעמית או אוטומציה מתמשכת. כל פעולה מוצגת ככרטיס עם הסטטוס האמיתי מהשרת.</p>
            <div className="flex flex-wrap justify-center gap-2">{examples.map((e) => <button key={e} className="text-xs rounded-full border border-line px-3 py-1.5 hover:bg-panel-2" onClick={() => send(e)}>{e}</button>)}</div>
          </div>}
          {msgs.map((m) => <div key={m.id} className={cx("flex", m.role === "user" ? "justify-start" : "justify-end")}>
            <div className={cx("max-w-[85%] space-y-2", m.role === "user" ? "" : "w-full md:w-auto")}>
              <div className={cx("rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap", m.role === "user" ? "bg-accent text-white" : "bg-panel-2")} data-testid={m.role === "user" ? "ai-msg-user" : "ai-msg-assistant"}>{m.text}</div>
              {m.actions?.map((a) => <ActionCard key={a.id} action={a} />)}
            </div>
          </div>)}
          {sending && <div className="flex justify-end"><div className="rounded-2xl px-3.5 py-2 bg-panel-2"><Spinner /></div></div>}
          <div ref={end} />
        </div>
        <form className="border-t border-line p-3 flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Textarea aria-label="הודעה לעוזר" rows={2} className="flex-1" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="כתבו לעוזר…" data-testid="ai-input" />
          <Button type="submit" loading={sending} icon={<Send size={15} />} data-testid="ai-send">שלח</Button>
        </form>
      </section>
    </div>
  );
}
