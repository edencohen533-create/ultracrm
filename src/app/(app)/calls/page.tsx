import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { ConversationsTabs } from "@/components/inbox/ConversationsTabs";
import { CallsInbox } from "@/components/inbox/CallsInbox";

export const dynamic = "force-dynamic";

/** "שיחות" → phone calls tab (the WhatsApp tab is /inbox). */
export default async function CallsPage() {
  const session = await getValidSession();
  if (!session) redirect("/login");
  const ent = await getEntitlements(session.businessId);
  if (!ent.modules.telephony) redirect("/inbox");
  return (
    <div className="flex h-screen flex-col">
      <ConversationsTabs telephony />
      <div className="min-h-0 flex-1 overflow-y-auto"><Suspense><CallsInbox /></Suspense></div>
    </div>
  );
}
