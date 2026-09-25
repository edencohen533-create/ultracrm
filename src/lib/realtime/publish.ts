import { conversationChannel, INBOX_CHANNEL, type RealtimeEvent } from "./channels";

export interface RealtimePublisher {
  publish(channel: string, event: RealtimeEvent): Promise<void>;
}

// Auth.js sessions are not Supabase Realtime JWTs. Until a private authenticated
// transport is configured, updates are fetched by the existing authenticated polling hook.
// A public invalidation would still leak another business's activity timing.
const pollingPublisher: RealtimePublisher = { async publish() {} };

let activePublisher: RealtimePublisher = pollingPublisher;

/** Test-only seam: swap in a fake publisher so tests don't need a live Supabase connection. */
export function setRealtimePublisher(publisher: RealtimePublisher): void {
  activePublisher = publisher;
}

export function resetRealtimePublisher(): void {
  activePublisher = pollingPublisher;
}

export async function publishNewMessage(event: Extract<RealtimeEvent, { type: "new_message" }>): Promise<void> {
  await safelyPublish(conversationChannel(event.conversationId), event);
  await safelyPublish(INBOX_CHANNEL, event);
}

export async function publishConversationUpdated(
  event: Extract<RealtimeEvent, { type: "conversation_updated" }>
): Promise<void> {
  await safelyPublish(conversationChannel(event.conversationId), event);
  await safelyPublish(INBOX_CHANNEL, event);
}

export async function publishTyping(event: Extract<RealtimeEvent, { type: "typing" }>): Promise<void> {
  await safelyPublish(conversationChannel(event.conversationId), event);
}

// The production transport is authenticated polling. Test adapters can inspect events.
async function safelyPublish(channel: string, event: RealtimeEvent) {
  try { await activePublisher.publish(channel, event); }
  catch { console.error("Realtime notification failed; authenticated polling will recover"); }
}
export async function publishMessageStatus(event: Extract<RealtimeEvent, { type: "message_status" }>) {
  await safelyPublish(conversationChannel(event.conversationId), event);
}
