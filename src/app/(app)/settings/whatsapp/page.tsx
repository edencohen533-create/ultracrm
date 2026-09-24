import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { prisma } from "@/lib/db";
import { getActiveProviderSummary, listProviderSummaries } from "@/server/services/provider-credential-service";
import { WhatsAppProviderForm } from "@/components/settings/whatsapp-provider-form";

export default organizationRequest(async function WhatsAppSettingsPage() {
  const session = await auth();

  if (!hasRole(session, ROLES_ADMIN)) {
    return <AccessDenied />;
  }

  const [summary, numbers, teams] = await Promise.all([getActiveProviderSummary(), listProviderSummaries(), prisma.team.findMany({ select: { id: true, name: true } })]);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/whatsapp`;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold">חיבור וואטסאפ</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {summary.provider === "mock" ? "כרגע המערכת במצב דמו. חבר חשבון Meta כדי לשלוח ולקבל הודעות אמיתיות." : "חיבור Meta מוגדר. ניתן לבדוק את הגישה ולעדכן את פרטי החיבור כאן."}
      </p>
      <WhatsAppProviderForm initialSummary={summary} webhookUrl={webhookUrl} numbers={JSON.parse(JSON.stringify(numbers))} teams={teams} />
    </div>
  );
});
