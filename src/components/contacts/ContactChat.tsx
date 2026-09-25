"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/inbox/chat-panel";
import type { MessageItem } from "@/types/domain";
import { Spinner } from "@/components/ui";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * The customer's WhatsApp thread inside the lead card / dialer card: finds (or opens) the conversation for the
 * contact and renders the same ChatPanel + composer used by the inbox – one implementation, one conversation.
 * Sending rules are unchanged: free text only inside the 24h window, otherwise an approved template.
 */
export function ContactChat({ contactId, compact = false }: { contactId: string; compact?: boolean }) {
  const [conv, setConv] = useState<{ id: string; composerDisabled: boolean; providerCredential: { label: string | null; displayPhoneNumber: string | null; isActive: boolean } | null } | null>(null);
  const [messages, setMessages] = useState<MessageItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "לא ניתן לפתוח שיחה");
        const id: string = d.conversation.id;
        const [c, m] = await Promise.all([fetch(`/api/conversations/${id}`).then((x) => x.json()), fetch(`/api/conversations/${id}/messages`).then((x) => x.json())]);
        if (!alive) return;
        const lastInboundAt: string | null = c.conversation?.lastInboundAt ?? null;
        setConv({ id, composerDisabled: !lastInboundAt || Date.now() - new Date(lastInboundAt).getTime() > TWENTY_FOUR_HOURS_MS, providerCredential: c.conversation?.providerCredential ?? null });
        setMessages(m.messages ?? []);
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [contactId]);

  if (error) return <p className="p-4 text-xs text-bad">{error}</p>;
  if (!conv || !messages) return <div className="p-4"><Spinner /></div>;
  const senderUnavailable = conv.providerCredential && !conv.providerCredential.isActive ? "המספר השולח נותק – לא ניתן לשלוח משיחה זו" : null;
  return (
    <div className={compact ? "flex flex-col min-h-[320px] h-[50vh]" : "flex flex-col min-h-[420px] h-[60vh]"} data-testid="contact-chat">
      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted border-b border-line">
        <span>WhatsApp · {conv.providerCredential?.label ?? conv.providerCredential?.displayPhoneNumber ?? "הדגמה"}</span>
        <Link href={`/inbox/${conv.id}`} className="text-accent underline">לשיחה המלאה בתיבת ההודעות</Link>
      </div>
      <div className="flex min-h-0 flex-1">
        <ChatPanel key={conv.id} conversationId={conv.id} initialMessages={messages} senderUnavailable={senderUnavailable} composerDisabled={conv.composerDisabled} composerDisabledReason="עברו יותר מ-24 שעות מאז הודעת הלקוח האחרונה — יש לשלוח תבנית מאושרת." />
      </div>
    </div>
  );
}
