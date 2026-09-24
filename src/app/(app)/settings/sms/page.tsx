import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { listChannelCredentials } from "@/server/services/channel-credential-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { ChannelConnectionCard } from "@/components/channels/channel-connection-card";

export default organizationRequest(async function SmsSettingsPage() {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [items, templates] = await Promise.all([listChannelCredentials("sms"), listChannelTemplates("sms")]);
  const active = items.find((c) => c.isActive) ?? null;
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">חיבור SMS</h1>
      <p className="mb-6 text-sm text-muted-foreground">ספק SMS לשליחת קמפיינים ורצפים, קליטת תשובות (הסר/STOP) ודיווחי מסירה. ראו docs/MULTICHANNEL_MARKETING.md להגדרת Telnyx.</p>
      <ChannelConnectionCard channel="sms" initial={JSON.parse(JSON.stringify(active))} templates={templates.map((t) => ({ id: t.id, name: t.name, channel: t.channel }))} isOwner={session?.user?.role === "owner"} />
    </div>
  );
});
