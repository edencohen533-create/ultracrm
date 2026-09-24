import type { MessageDirection, MessageStatus, MessageType, ConversationStatus } from "@/generated/prisma/client";

export function conversationChannel(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export const INBOX_CHANNEL = "inbox:global";

export interface NewMessageEvent {
  type: "new_message";
  conversationId: string;
  message: {
    id: string;
    direction: MessageDirection;
    type: MessageType;
    body: string | null;
    status: MessageStatus;
    createdAt: string;
  };
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  conversationId: string;
  patch: {
    status?: ConversationStatus;
    assignedAgentId?: string | null;
    unreadCount?: number;
    lastMessageAt?: string;
  };
}

export interface TypingEvent {
  type: "typing";
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface MessageStatusEvent {
  type: "message_status";
  conversationId: string;
  messageId: string;
  status: MessageStatus;
}
export interface ConversationSnapshotEvent {
  type: "conversation_snapshot";
  conversationId: string;
  messages: import("@/types/domain").MessageItem[];
  lastInboundAt: string | null;
  senderUnavailable?: string | null;
}
export type RealtimeEvent = MessageStatusEvent | ConversationSnapshotEvent | { type: "access_revoked" } | { type: "invalidate" } | NewMessageEvent | ConversationUpdatedEvent | TypingEvent;
