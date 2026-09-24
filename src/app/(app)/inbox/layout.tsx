import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { listConversations } from "@/server/services/conversation-service";
import { ConversationListPane } from "@/components/inbox/conversation-list";
import type { ConversationListItem } from "@/types/domain";

export default organizationRequest(async function InboxLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  // Server-rendered, unfiltered initial list so /inbox has real content on
  // first paint instead of a client-side fetch-then-skeleton flash. The
  // client component only re-fetches when a filter is applied or a
  // realtime event arrives.
  const conversations = session ? await listConversations(session) : [];
  const initialConversations: ConversationListItem[] = JSON.parse(JSON.stringify(conversations));

  return (
    <div className="flex h-full">
      <ConversationListPane initialConversations={initialConversations} />
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
});
