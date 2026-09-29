import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { prisma } from "@/lib/db";
import { getActiveProviderSummary, listProviderSummaries } from "@/server/services/provider-credential-service";
import { connectionOverview } from "@/server/services/embedded-signup-service";
import { WhatsAppProviderForm } from "@/components/settings/whatsapp-provider-form";
import { WhatsAppConnectCard } from "@/components/settings/whatsapp-connect-card";
import { serverT } from "@/lib/i18n-server";

export default organizationRequest(async function WhatsAppSettingsPage() {
  const session = await auth();
  const t = await serverT();

  // Owner, or a manager allowed to connect WhatsApp ("whatsapp.connect") – enforced again on every API route.
  if (!hasRole(session, ROLES_ADMIN_MANAGER) || !session) {
    return <AccessDenied />;
  }
  const { effectiveAccess, can } = await import("@/lib/access/engine");
  const access = await effectiveAccess(session.user.businessId ?? "", session.user.id).catch(() => null);
  if (!access || !can(access, "whatsapp.connect")) return <AccessDenied />;
  const isOwner = session?.user?.role === "owner";

  const [summary, numbers, teams, overview] = await Promise.all([getActiveProviderSummary(), listProviderSummaries(), prisma.team.findMany({ select: { id: true, name: true } }), connectionOverview()]);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/whatsapp`;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold">{t("חיבור וואטסאפ", "WhatsApp connection")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {summary.provider === "mock" ? t("כרגע המערכת במצב דמו. חבר חשבון Meta כדי לשלוח ולקבל הודעות אמיתיות.", "The system is currently in demo mode. Connect a Meta account to send and receive real messages.") : t("חיבור Meta מוגדר. ניתן לבדוק את הגישה ולעדכן את פרטי החיבור כאן.", "Meta connection is configured. You can test access and update the connection details here.")}
      </p>
      <WhatsAppConnectCard initial={JSON.parse(JSON.stringify(overview))} webhookUrl={webhookUrl} canManage />
      {isOwner && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{t("חיבור ידני מתקדם (System User Token) – לבעל העסק בלבד", "Advanced manual connection (System User Token) – business owner only")}</summary>
          <div className="mt-4">
            <WhatsAppProviderForm initialSummary={summary} webhookUrl={webhookUrl} numbers={JSON.parse(JSON.stringify(numbers))} teams={teams} />
          </div>
        </details>
      )}
    </div>
  );
}, "whatsapp");
