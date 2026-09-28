import { EmptyState } from "@/components/shared/empty-state";
import { serverT } from "@/lib/i18n-server";

export default async function InboxPage() {
  const t = await serverT();
  return <EmptyState title={t("בחר שיחה", "Select a conversation")} description={t("בחר שיחה מהרשימה כדי לצפות בה.", "Choose a conversation from the list to view it.")} />;
}
