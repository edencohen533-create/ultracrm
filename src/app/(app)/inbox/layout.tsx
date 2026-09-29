import Link from "next/link";
import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { listConversations } from "@/server/services/conversation-service";
import { ConversationListPane } from "@/components/inbox/conversation-list";
import type { ConversationListItem } from "@/types/domain";
import { serverT } from "@/lib/i18n-server";

const FILTERS: Array<[string, string, string]> = [["", "הכול", "All"], ["mine", "שלי", "Mine"], ["unassigned", "לא משויך", "Unassigned"], ["open", "פתוח", "Open"], ["pending", "ממתין", "Pending"], ["resolved", "טופל", "Resolved"]];

export default organizationRequest(async function InboxLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const t = await serverT();
  // Server-rendered, unfiltered initial list so /inbox has real content on first paint.
  const conversations = session ? await listConversations(session, { channel: "whatsapp" }) : [];
  const initialConversations: ConversationListItem[] = JSON.parse(JSON.stringify(conversations));

  return (
    <div className="flex h-[calc(100vh-var(--topnav-h))] flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 h-10 text-xs shrink-0 overflow-x-auto whitespace-nowrap">
        <span className="text-sm font-semibold me-3 shrink-0">{t("שיחות וואטסאפ", "WhatsApp chats")}</span>
        {FILTERS.map(([f, he, en]) => (
          <Link key={f} href={f ? `/inbox?filter=${f}` : "/inbox"} className="px-2 h-7 inline-flex items-center rounded-md text-muted hover:text-text hover:bg-white/5">{t(he, en)}</Link>
        ))}
        <form action="/inbox" className="ms-auto shrink-0"><input name="search" placeholder={t("חיפוש שיחות…", "Search conversations…")} className="h-7 px-2 rounded-md bg-bg border border-line text-xs w-48" /></form>
      </div>
      <div className="flex min-h-0 flex-1">
        <ConversationListPane initialConversations={initialConversations} />
        <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}, "whatsapp.view");
