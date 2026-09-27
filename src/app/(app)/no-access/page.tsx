import Link from "next/link";

const REASON: Record<string, string> = {
  module_not_purchased: "המודול אינו כלול בחבילה של העסק. מנהל העסק יכול לבקש שדרוג בהגדרות → חבילה.",
  module_not_assigned: "המודול לא הוקצה לך. פנה למנהל העסק כדי לקבל הרשאה.",
  action_denied: "אין לך הרשאה לפעולה הזו. פנה למנהל העסק.",
  business_suspended: "הגישה של העסק מושעית כרגע. פנה למנהל הפלטפורמה.",
};

/** Shown when a page is opened directly without access (the server APIs refuse the data anyway). */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return (
    <div className="p-10 max-w-lg mx-auto text-center space-y-3" data-testid="no-access">
      <h1 className="text-xl font-bold">אין גישה למסך הזה</h1>
      <p className="text-muted">{REASON[reason ?? ""] ?? "אין לך הרשאה למסך הזה."}</p>
      <Link href="/" className="underline text-sm">חזרה</Link>
    </div>
  );
}
