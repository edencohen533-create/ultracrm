"use client";

import { useEffect, useEffectEvent } from "react";
import { INBOX_CHANNEL, type RealtimeEvent } from "./channels";

/** Session-authenticated polling: public broadcasts can disclose cross-business activity timing.
 * Each refresh passes through API authorization and PostgreSQL RLS. No public channel subscriptions. */
export function useRealtimeChannel(channelName: string, onEvent: (event: RealtimeEvent) => void) {
  const handleEvent = useEffectEvent((event: RealtimeEvent) => onEvent(event));
  useEffect(() => {
    let running = false, disposed = false, lastRefresh = 0;
    const controller = new AbortController();
    async function refresh() {
      if (disposed || running || document.visibilityState === "hidden" || Date.now() - lastRefresh < 1000) return;
      lastRefresh = Date.now(); running = true;
      try {
        if (channelName === INBOX_CHANNEL) {
          handleEvent({ type: "invalidate" });
        } else if (channelName.startsWith("conversation:")) {
          const conversationId = channelName.slice("conversation:".length);
          const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { cache: "no-store", signal: controller.signal });
          if (disposed) return;
          if ([401, 403, 404].includes(response.status)) { handleEvent({ type: "access_revoked" }); return; }
          if (response.ok) {
            const data = await response.json();
            if (!disposed) handleEvent({ type: "conversation_snapshot", conversationId, messages: data.messages, lastInboundAt: data.lastInboundAt, senderUnavailable: data.senderUnavailable });
          }
        }
      } catch { /* Retry on the next wake-up or polling tick. */ }
      finally { running = false; }
    }
    const timer = setInterval(() => { void refresh(); }, 5000);
    document.addEventListener("visibilitychange", refresh);
    void refresh();
    return () => {
      disposed = true; controller.abort(); clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [channelName]);
}
