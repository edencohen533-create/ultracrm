"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isSameDay } from "date-fns";
import { MessageBubble } from "./message-bubble";
import { DateSeparator } from "./date-separator";
import { MessageComposer } from "./message-composer";
import { useRealtimeChannel } from "@/lib/realtime/use-realtime-channel";
import { conversationChannel } from "@/lib/realtime/channels";
import type { MessageItem } from "@/types/domain";

export function ChatPanel({
  conversationId,
  initialMessages,
  composerDisabled,
  composerDisabledReason,
  senderUnavailable,
}: {
  conversationId: string;
  initialMessages: MessageItem[];
  composerDisabled?: boolean;
  composerDisabledReason?: string;
  senderUnavailable?: string | null;
}) {
  // Keyed by conversationId in the parent, so switching conversations
  // remounts this component with fresh initial state instead of needing an
  // effect to re-sync `messages` from the `initialMessages` prop.
  const [messages, setMessages] = useState<MessageItem[]>(initialMessages);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [senderBlocked, setSenderBlocked] = useState(senderUnavailable);
  const [windowClosed, setWindowClosed] = useState(composerDisabled);
  const [hasMore, setHasMore] = useState(initialMessages.length === 100);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  async function loadOlder() {
    if (loadingOlder || !messages[0]) return;
    setLoadingOlder(true);
    try {
      const first = messages[0];
      const response = await fetch(`/api/conversations/${conversationId}/messages?${new URLSearchParams({ before: first.createdAt, beforeId: first.id })}`, { cache: "no-store" });
      if (response.status === 404 || response.status === 401) { setAccessRevoked(true); setMessages([]); return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (scrollRef.current) restoreScroll.current = { height: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
      setMessages((current) => {
        const byId = new Map(current.map((message) => [message.id, message]));
        for (const message of data.messages as MessageItem[]) if (!byId.has(message.id)) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
      setHasMore(data.hasMore);
    } catch { toast.error("טעינת ההיסטוריה נכשלה. ניתן לנסות שוב"); }
    finally { setLoadingOlder(false); }
  }
  useLayoutEffect(() => {
    if (restoreScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = restoreScroll.current.top + scrollRef.current.scrollHeight - restoreScroll.current.height;
      restoreScroll.current = null;
    }
  }, [messages]);
  const lastMessageId = messages.at(-1)?.id;
  const bottomRef = useRef<HTMLDivElement>(null);

  useRealtimeChannel(conversationChannel(conversationId), (event) => {
    if (event.type === "access_revoked") {
      setAccessRevoked(true); setMessages([]); return;
    }
    if (event.type === "conversation_snapshot") {
      setSenderBlocked(event.senderUnavailable);
      setAccessRevoked(false);
      setWindowClosed(!event.lastInboundAt || Date.now() - new Date(event.lastInboundAt).getTime() > 86400000);
      setMessages((prev) => {
        const byId = new Map(prev.map((message) => [message.id, message]));
        for (const message of event.messages) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
    }
    if (event.type === "message_status") {
      setMessages((prev) => prev.map((message) => message.id === event.messageId ? { ...message, status: event.status } : message));
    }
    if (event.type === "new_message") {
      setMessages((prev) => {
        if (prev.some((m) => m.id === event.message.id)) return prev;
        return [
          ...prev,
          {
            id: event.message.id,
            direction: event.message.direction,
            type: event.message.type,
            body: event.message.body,
            status: event.message.status,
            createdAt: event.message.createdAt,
            sentByUser: null,
          },
        ];
      });
    }
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastMessageId]);

  if (accessRevoked) return <p className="p-4">אין הרשאה להציג שיחה זו. ייתכן שהיא הועברה לנציג אחר.</p>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {hasMore && <Button variant="outline" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? "טוען היסטוריה…" : "טען הודעות קודמות"}</Button>}
        {messages.map((message, index) => {
          const prev = messages[index - 1];
          const showSeparator = !prev || !isSameDay(new Date(prev.createdAt), new Date(message.createdAt));
          return (
            <div key={message.id}>
              {showSeparator && <DateSeparator date={new Date(message.createdAt)} />}
              <div className="mb-1.5">
                <MessageBubble message={message} />
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <MessageComposer senderUnavailable={senderBlocked} onSent={(message) => setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message])} conversationId={conversationId} disabled={windowClosed} disabledReason={composerDisabledReason} />
    </div>
  );
}
