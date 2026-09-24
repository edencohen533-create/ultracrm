// Client-facing shapes (post-JSON-serialization: Date -> string) shared
// between the API routes and the client components that consume them.

export interface ConversationListItem {
  id: string;
  status: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
  unreadCount: number;
  lastMessageAt: string | null;
  contact: { id: string; name: string; phone: string };
  providerCredential?: { id: string; label: string | null; displayPhoneNumber: string | null } | null;
  assignedAgent: { id: string; name: string } | null;
  tags: { tag: { id: string; name: string; color: string } }[];
  messages?: { body: string | null; direction: "INBOUND" | "OUTBOUND" }[];
}

export interface MessageItem {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "LINK" | "TEMPLATE";
  body: string | null;
  status: "ACCEPTED" | "UNKNOWN" | "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  createdAt: string;
  attachments?: { id: string; url: string; mimeType: string; fileName: string | null; sizeBytes?: number | null }[];
  sentByUser: { id: string; name: string } | null;
}
