import Link from "next/link";
import { serverT } from "@/lib/i18n-server";

const REASON: Record<string, { he: string; en: string }> = {
  module_not_purchased: { he: "המודול אינו כלול בחבילה של העסק. מנהל העסק יכול לבקש שדרוג בהגדרות → חבילה.", en: "This module isn't included in the business's plan. The business admin can request an upgrade in Settings → Plan." },
  module_not_assigned: { he: "המודול לא הוקצה לך. פנה למנהל העסק כדי לקבל הרשאה.", en: "This module hasn't been assigned to you. Contact the business admin to get access." },
  action_denied: { he: "אין לך הרשאה לפעולה הזו. פנה למנהל העסק.", en: "You don't have permission for this action. Contact the business admin." },
  business_suspended: { he: "הגישה של העסק מושעית כרגע. פנה למנהל הפלטפורמה.", en: "The business's access is currently suspended. Contact the platform admin." },
};

/** Shown when a page is opened directly without access (the server APIs refuse the data anyway). */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const t = await serverT();
  const r = REASON[reason ?? ""];
  return (
    <div className="p-10 max-w-lg mx-auto text-center space-y-3" data-testid="no-access">
      <h1 className="text-xl font-bold">{t("אין גישה למסך הזה", "No access to this screen")}</h1>
      <p className="text-muted">{r ? t(r.he, r.en) : t("אין לך הרשאה למסך הזה.", "You don't have permission to view this screen.")}</p>
      <Link href="/" className="underline text-sm">{t("חזרה", "Back")}</Link>
    </div>
  );
}
