"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Ltr } from "@/components/shared/ltr";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useRealtimeChannel } from "@/lib/realtime/use-realtime-channel";
import { INBOX_CHANNEL } from "@/lib/realtime/channels";
import type { ConversationListItem } from "@/types/domain";

const STATUS_LABELS: Record<string, string> = {
  OPEN: "פתוח",
  PENDING: "ממתין",
  RESOLVED: "טופל",
  CLOSED: "סגור",
};

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
}

export function ConversationListPane({ initialConversations }: { initialConversations: ConversationListItem[] }) {
  const searchParams = useSearchParams();
  const activeId = useParams<{ conversationId?: string }>().conversationId;
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(initialConversations);

  const filter = searchParams.get("filter");
  const [senderFilter, setSenderFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => { fetch("/api/tags").then((r) => (r.ok ? r.json() : null)).then((d) => { const items = d?.data?.items ?? d?.items ?? d?.data ?? []; if (Array.isArray(items)) setTags(items.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }))); }).catch(() => undefined); }, []);
  const [senders, setSenders] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => { fetch("/api/whatsapp/senders").then((res) => res.ok ? res.json() : null).then((data) => { if (data) setSenders(data.senders); }).catch(() => {}); }, []);
  const search = searchParams.get("search") ?? "";
  const statusParam = filter && ["open", "pending", "resolved", "all", "mine", "unassigned"].includes(filter) ? filter : undefined;

  // Fetches the list from the server and syncs it into state — this is the
  // documented React pattern for an effect that synchronizes with an
  // external system (a network request), not a derived-state anti-pattern,
  // so the set-state-in-effect lint rule's false positive is suppressed below.
  const fetching = useRef(false);
  const fetchConversations = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
    const params = new URLSearchParams();
    if (senderFilter) params.set("providerCredentialId", senderFilter);
    if (tagFilter) params.set("tagId", tagFilter);
    if (channelFilter) params.set("channel", channelFilter);
    if (search) params.set("search", search);
    if (statusParam === "open") params.set("status", "OPEN");
    if (statusParam === "pending") params.set("status", "PENDING");
    if (statusParam === "resolved") params.set("status", "RESOLVED");
    if (statusParam === "mine") params.set("assignedTo", "me");
    if (statusParam === "unassigned") params.set("assignedTo", "unassigned");

    const res = await fetch(`/api/conversations?${params.toString()}`);
    if ([401, 403].includes(res.status)) { setConversations([]); return; }
    if (!res.ok) return;
    const data = await res.json();
    setConversations(data.conversations);
    } finally { fetching.current = false; }
  }, [statusParam, search, senderFilter, tagFilter, channelFilter]);

  // Skip the redundant initial fetch when unfiltered — the server already
  // rendered that exact data into `initialConversations`. Any other filter
  // (or a later change back to unfiltered) still fetches normally.
  const skippedInitialFetch = useRef(false);
  useEffect(() => {
    if (!skippedInitialFetch.current && statusParam === undefined && !search && !senderFilter && !tagFilter && !channelFilter) {
      skippedInitialFetch.current = true;
      return;
    }
    skippedInitialFetch.current = true;
    void fetchConversations().catch(() => {});
  }, [fetchConversations, statusParam, search, senderFilter, tagFilter, channelFilter]);

  useRealtimeChannel(
    INBOX_CHANNEL,
    useCallback(() => {
      void fetchConversations().catch(() => {});
    }, [fetchConversations])
  );

  return (
    <div className={cn("h-full w-full shrink-0 flex-col overflow-hidden border-e md:flex md:w-80", activeId ? "hidden" : "flex")}>
      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {senders.length > 0 && <select aria-label="סינון שיחות לפי מספר" className="rounded border p-1.5 text-xs" value={senderFilter} onChange={(event) => setSenderFilter(event.target.value)}><option value="">כל המספרים הנגישים</option>{senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.label}</option>)}</select>}
        {tags.length > 0 && <select aria-label="סינון שיחות לפי תגית" className="rounded border p-1.5 text-xs" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">כל התגיות</option>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
        <select aria-label="סינון שיחות לפי ערוץ" className="rounded border p-1.5 text-xs" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}><option value="">כל הערוצים</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">אימייל</option></select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations === null && (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}

        {conversations !== null && conversations.length === 0 && (
          <EmptyState title="אין שיחות להצגה" description="נסה לשנות את הסינון או להמתין להודעות חדשות." />
        )}

        {conversations?.map((conversation) => {
          const lastMessage = conversation.messages?.[0];
          return (
            <Link
              key={conversation.id}
              href={`/inbox/${conversation.id}`}
              className={cn(
                "flex gap-3 border-b p-3 hover:bg-muted/50",
                activeId === conversation.id && "bg-muted"
              )}
            >
              <Avatar className="h-10 w-10 shrink-0">
                <AvatarFallback>{initials(conversation.contact.fullName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{conversation.contact.fullName}</span>
                  {conversation.lastMessageAt && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(conversation.lastMessageAt), { locale: he, addSuffix: true })}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  <Ltr>{conversation.contact.phoneE164}</Ltr>
                </div>
                {conversation.providerCredential && <p className="text-xs text-muted-foreground">{conversation.channel && conversation.channel !== "whatsapp" ? <span className="me-1 rounded border px-1 text-[10px] uppercase">{conversation.channel === "sms" ? "SMS" : "אימייל"}</span> : null}דרך: {conversation.providerCredential.label || conversation.providerCredential.displayPhoneNumber || "WhatsApp"}{conversation.providerCredential.isActive === false ? <span className="ms-1 text-amber-700">(מספר מנותק)</span> : null}</p>}
                {lastMessage?.body && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{lastMessage.body}</p>
                )}
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {STATUS_LABELS[conversation.status]}
                  </Badge>
                  {conversation.assignedAgent && (
                    <span className="text-[10px] text-muted-foreground">{conversation.assignedAgent.fullName}</span>
                  )}
                  {conversation.unreadCount > 0 && (
                    <Badge className="ms-auto h-4 min-w-4 justify-center rounded-full px-1 text-[10px]">
                      {conversation.unreadCount}
                    </Badge>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
