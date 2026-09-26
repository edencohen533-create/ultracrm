import Link from "next/link";
import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { listConversations } from "@/server/services/conversation-service";
import { ConversationListPane } from "@/components/inbox/conversation-list";
import type { ConversationListItem } from "@/types/domain";

const FILTERS: Array<[string, string]> = [["", "הכול"], ["mine", "שלי"], ["unassigned", "לא משויך"], ["open", "פתוח"], ["pending", "ממתין"], ["resolved", "טופל"]];

export default organizationRequest(async function InboxLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  // Server-rendered, unfiltered initial list so /inbox has real content on first paint.
  const conversations = session ? await listConversations(session) : [];
  const initialConversations: ConversationListItem[] = JSON.parse(JSON.stringify(conversations));

  return (
    <div className="flex h-[calc(100vh-var(--topnav-h))] flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 h-10 text-xs shrink-0">
        <span className="text-sm font-semibold me-3">וואטסאפ</span>
        {FILTERS.map(([f, label]) => (
          <Link key={f} href={f ? `/inbox?filter=${f}` : "/inbox"} className="px-2 h-7 inline-flex items-center rounded-md text-muted hover:text-text hover:bg-white/5">{label}</Link>
        ))}
        <form action="/inbox" className="ms-auto"><input name="search" placeholder="חיפוש שיחות…" className="h-7 px-2 rounded-md bg-bg border border-line text-xs w-48" /></form>
      </div>
      <div className="flex min-h-0 flex-1">
        <ConversationListPane initialConversations={initialConversations} />
        <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
});
