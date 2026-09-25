"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, X, Sparkles } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, cx } from "@/components/ui";

type Sources = { transcriptLines?: number; lead?: boolean; product?: boolean; whatsapp?: number; outcomes?: number; examples?: number; knowledgeObjections?: number; mock?: boolean; latencyMs?: number };
type Msg = { id: string; role: "agent" | "assistant"; text: string; followUp: string | null; why: string | null; basis: string | null; sources: Sources; createdAt: string };

/** Honest one-liner: what really fed this answer (the agent sees when there is no transcript). */
function sourcesLine(s: Sources) {
  const parts: string[] = [];
  parts.push(s.transcriptLines ? `${s.transcriptLines} שורות תמלול` : "ללא תמלול – לפי מה שכתבת");
  if (s.lead) parts.push("פרטי הליד"); if (s.product) parts.push("המוצר שמעניין"); if (s.whatsapp) parts.push(`${s.whatsapp} הודעות WhatsApp`); if (s.outcomes) parts.push(`${s.outcomes} שיחות קודמות`);
  if (s.examples) parts.push(`${s.examples} דוגמאות ממכירות שנסגרו`); if (s.knowledgeObjections) parts.push("ידע עסקי מאושר");
  return parts.join(" · ");
}

/**
 * "נתקעתי? שאל את ה-AI" – a small RTL chat docked inside the call screen. The agent describes the moment in their
 * own words and gets one line to say out loud (+ an optional follow-up). Closing with X only hides the panel; the
 * history stays for this call. Never touches the call or the dialer.
 */
export function CoachChat({ callId, disabledReason, mock }: { callId: string; disabledReason?: string | null; mock?: boolean }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { try { const r = await api.get<{ messages: Msg[] }>(`/api/coach/calls/${callId}/chat`); setMessages(r.messages); } catch { /* keep what we have */ } }, [callId]);
  useEffect(() => { if (open) { load(); setTimeout(() => inputRef.current?.focus(), 50); } }, [open, load]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, busy]);
  async function send() {
    const q = text.trim(); if (!q || busy) return;
    setBusy(true); setError(null); setText("");
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "agent", text: q, followUp: null, why: null, basis: null, sources: {}, createdAt: new Date().toISOString() }]);
    try { const r = await api.post<{ question: Msg; answer: Msg }>(`/api/coach/calls/${callId}/chat`, { question: q }); setMessages((m) => [...m.filter((x) => !x.id.startsWith("tmp-")), r.question, r.answer]); }
    catch (e) { setError((e as Error).message); setText(q); setMessages((m) => m.filter((x) => !x.id.startsWith("tmp-"))); }
    finally { setBusy(false); inputRef.current?.focus(); }
  }
  async function copy(m: Msg) { try { await navigator.clipboard.writeText(m.text); setCopied(m.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ } }
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="coach-chat-open" title={disabledReason ?? "צ׳אט עם המאמן – כתוב מה קורה בשיחה וקבל משפט להגיד עכשיו"}><Sparkles size={14} /> נתקעתי? שאל את ה-AI</Button>
      {open && (
        <div className="coach-chat" role="dialog" aria-label="נתקעתי? שאל את ה-AI" data-testid="coach-chat" dir="rtl">
          <header>
            <strong><Sparkles size={14} /> שאל את ה-AI</strong>
            {mock && <Badge tone="warn">ספק AI מדומה</Badge>}
            <button type="button" aria-label="סגור צ׳אט" data-testid="coach-chat-close" onClick={() => setOpen(false)}><X size={16} /></button>
          </header>
          <div className="coach-chat-list" ref={listRef}>
            {!messages.length && !busy && <p className="text-xs text-muted p-2">כתוב במילים שלך מה קורה, למשל: ״היא אומרת שזה יקר ורוצה לחשוב על זה״. תקבל משפט קצר להגיד עכשיו ואפשרות המשך.</p>}
            {messages.map((m) => m.role === "agent" ? (
              <div key={m.id} className="coach-msg agent" data-testid="coach-chat-agent">{m.text}</div>
            ) : (
              <div key={m.id} className="coach-msg assistant" data-testid="coach-chat-answer">
                <div className="coach-say"><span className="label">תגיד עכשיו</span><p data-testid="coach-chat-say-now">{m.text}</p><button type="button" aria-label="העתק" title="העתק" onClick={() => copy(m)}>{copied === m.id ? <Check size={14} /> : <Copy size={14} />}</button></div>
                {m.followUp && <p className="coach-follow"><span className="label">אפשר להמשיך</span>{m.followUp}</p>}
                <div className="coach-meta">
                  <span title={sourcesLine(m.sources)}>{sourcesLine(m.sources)}</span>
                  {m.why && <button type="button" onClick={() => setShowWhy(showWhy === m.id ? null : m.id)}>{showWhy === m.id ? "הסתר" : "למה?"}</button>}
                </div>
                {showWhy === m.id && m.why && <p className="coach-why">{m.why}{m.basis === "examples" ? " · מבוסס על משפטים משיחות שנסגרו – לא ערובה לסגירה." : ""}</p>}
              </div>
            ))}
            {busy && <div className="coach-msg assistant text-xs text-muted" data-testid="coach-chat-busy">חושב…</div>}
          </div>
          {disabledReason && <p className="text-xs text-bad px-2">{disabledReason}</p>}
          {error && <p className="text-xs text-bad px-2" role="alert">{error}</p>}
          <form className="coach-chat-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="מה קורה בשיחה עכשיו?" aria-label="מה קורה בשיחה" disabled={Boolean(disabledReason)} data-testid="coach-chat-input" className={cx(busy && "opacity-70")} />
            <Button size="sm" type="submit" disabled={!text.trim() || busy || Boolean(disabledReason)} data-testid="coach-chat-send">שלח</Button>
          </form>
        </div>
      )}
    </>
  );
}
