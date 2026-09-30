"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, X, Sparkles } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

type Sources = { transcriptLines?: number; lead?: boolean; product?: boolean; whatsapp?: number; outcomes?: number; examples?: number; knowledgeObjections?: number; mock?: boolean; latencyMs?: number; insights?: number; sharedFacts?: number; facts?: Array<{ text: string; source: string }> };
type Msg = { id: string; role: "agent" | "assistant"; text: string; followUp: string | null; why: string | null; basis: string | null; sources: Sources; createdAt: string };

/** Honest one-liner: what really fed this answer (the agent sees when there is no transcript). */
function sourcesLine(s: Sources, t: (he: string, en: string) => string) {
  const parts: string[] = [];
  parts.push(s.transcriptLines ? t(`${s.transcriptLines} שורות תמלול`, `${s.transcriptLines} transcript lines`) : t("ללא תמלול – לפי מה שכתבת", "No transcript – based on what you wrote"));
  if (s.lead) parts.push(t("פרטי הליד", "Lead details")); if (s.product) parts.push(t("המוצר שמעניין", "Product of interest")); if (s.whatsapp) parts.push(t(`${s.whatsapp} הודעות WhatsApp`, `${s.whatsapp} WhatsApp messages`)); if (s.outcomes) parts.push(t(`${s.outcomes} שיחות קודמות`, `${s.outcomes} previous calls`));
  if (s.examples) parts.push(t(`${s.examples} דוגמאות ממכירות שנסגרו`, `${s.examples} examples from closed sales`)); if (s.knowledgeObjections) parts.push(t("ידע עסקי מאושר", "Approved business knowledge"));
  if (s.insights) parts.push(t(`${s.insights} תובנות מכירה מאושרות`, `${s.insights} approved sales insights`)); if (s.sharedFacts) parts.push(t(`${s.sharedFacts} מקורות שירות משותפים`, `${s.sharedFacts} shared service sources`));
  return parts.join(" · ");
}

/**
 * "נתקעתי? שאל את ה-AI" – a small RTL chat docked inside the call screen. The agent describes the moment in their
 * own words and gets one line to say out loud (+ an optional follow-up). Closing with X only hides the panel; the
 * history stays for this call. Never touches the call or the dialer.
 */
export function CoachChat({ callId, disabledReason, mock }: { callId: string; disabledReason?: string | null; mock?: boolean }) {
  const t = useT();
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
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="coach-chat-open" title={disabledReason ?? t("צ׳אט עם המאמן – כתוב מה קורה בשיחה וקבל משפט להגיד עכשיו", "Chat with the coach – describe what's happening in the call and get a line to say now")}><Sparkles size={14} /> {t("נתקעתי? שאל את ה-AI", "Stuck? Ask the AI")}</Button>
      {open && (
        <div className="coach-chat" role="dialog" aria-label={t("נתקעתי? שאל את ה-AI", "Stuck? Ask the AI")} data-testid="coach-chat" dir={t.dir}>
          <header>
            <strong><Sparkles size={14} /> {t("שאל את ה-AI", "Ask the AI")}</strong>
            {mock && <Badge tone="warn">{t("ספק AI מדומה", "Mock AI provider")}</Badge>}
            <button type="button" aria-label={t("סגור צ׳אט", "Close chat")} data-testid="coach-chat-close" onClick={() => setOpen(false)}><X size={16} /></button>
          </header>
          <div className="coach-chat-list" ref={listRef}>
            {!messages.length && !busy && <p className="text-xs text-muted p-2">{t("כתוב במילים שלך מה קורה, למשל: ״היא אומרת שזה יקר ורוצה לחשוב על זה״. תקבל משפט קצר להגיד עכשיו ואפשרות המשך.", "Describe what's happening in your own words, e.g. \"She says it's expensive and wants to think about it\". You'll get a short line to say now and a possible follow-up.")}</p>}
            {messages.map((m) => m.role === "agent" ? (
              <div key={m.id} className="coach-msg agent" data-testid="coach-chat-agent">{m.text}</div>
            ) : (
              <div key={m.id} className="coach-msg assistant" data-testid="coach-chat-answer">
                <div className="coach-say"><span className="label">{t("ניסוח מוצע – תגיד עכשיו", "Suggested wording – say now")}</span><p data-testid="coach-chat-say-now">{m.text}</p><button type="button" aria-label={t("העתק", "Copy")} title={t("העתק", "Copy")} onClick={() => copy(m)}>{copied === m.id ? <Check size={14} /> : <Copy size={14} />}</button></div>
                {m.followUp && <p className="coach-follow"><span className="label">{t("אפשר להמשיך", "Follow-up")}</span>{m.followUp}</p>}
                {m.sources.facts?.length ? <div className="coach-facts" data-testid="coach-chat-facts"><span className="label">{t("עובדות ממקורות מאושרים", "Facts from approved sources")}</span><ul>{m.sources.facts.map((f, i) => <li key={i}>{f.text} <span className="text-muted">· {t("מקור:", "Source:")} {f.source}</span></li>)}</ul></div> : null}
                <div className="coach-meta">
                  <span title={sourcesLine(m.sources, t)}>{sourcesLine(m.sources, t)}</span>
                  {m.why && <button type="button" onClick={() => setShowWhy(showWhy === m.id ? null : m.id)}>{showWhy === m.id ? t("הסתר", "Hide") : t("למה?", "Why?")}</button>}
                </div>
                {showWhy === m.id && m.why && <p className="coach-why">{m.why}{m.basis === "examples" ? t(" · מבוסס על משפטים משיחות שנסגרו – לא ערובה לסגירה.", " · Based on lines from closed calls – not a guarantee of closing.") : ""}</p>}
              </div>
            ))}
            {busy && <div className="coach-msg assistant text-xs text-muted" data-testid="coach-chat-busy">{t("חושב…", "Thinking…")}</div>}
          </div>
          {disabledReason && <p className="text-xs text-bad px-2">{disabledReason}</p>}
          {error && <p className="text-xs text-bad px-2" role="alert">{error}</p>}
          <form className="coach-chat-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("מה קורה בשיחה עכשיו?", "What's happening in the call now?")} aria-label={t("מה קורה בשיחה", "What's happening in the call")} disabled={Boolean(disabledReason)} data-testid="coach-chat-input" className={cx(busy && "opacity-70")} />
            <Button size="sm" type="submit" disabled={!text.trim() || busy || Boolean(disabledReason)} data-testid="coach-chat-send">{t("שלח", "Send")}</Button>
          </form>
        </div>
      )}
    </>
  );
}
