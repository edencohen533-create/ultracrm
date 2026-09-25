import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { listChannelCredentials } from "@/server/services/channel-credential-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { ChannelConnectionCard } from "@/components/channels/channel-connection-card";

export default organizationRequest(async function EmailSettingsPage() {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [items, templates] = await Promise.all([listChannelCredentials("email"), listChannelTemplates("email")]);
  const active = items.find((c) => c.isActive) ?? null;
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">חיבור אימייל</h1>
      <p className="mb-6 text-sm text-muted-foreground">ספק אימייל לשליחת קמפיינים, אימות דומיין (SPF/DKIM/DMARC), קליטת bounces ותלונות ספאם. ראו docs/MULTICHANNEL_MARKETING.md להגדרת Resend.</p>
      <ChannelConnectionCard channel="email" initial={JSON.parse(JSON.stringify(active))} templates={templates.map((t) => ({ id: t.id, name: t.name, channel: t.channel }))} isOwner={session?.user?.role === "owner"} />
    </div>
  );
});
