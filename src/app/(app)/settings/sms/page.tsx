import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { listChannelCredentials } from "@/server/services/channel-credential-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { ChannelConnectionCard } from "@/components/channels/channel-connection-card";
import { serverT } from "@/lib/i18n-server";

export default organizationRequest(async function SmsSettingsPage() {
  const session = await auth();
  const tr = await serverT();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [items, templates] = await Promise.all([listChannelCredentials("sms"), listChannelTemplates("sms")]);
  const active = items.find((c) => c.isActive) ?? null;
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">{tr("חיבור SMS", "SMS Connection")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{tr("ספק SMS לשליחת קמפיינים ורצפים, קליטת תשובות (הסר/STOP) ודיווחי מסירה. ראו docs/MULTICHANNEL_MARKETING.md להגדרת Telnyx.", "SMS provider for sending campaigns and sequences, ingesting replies (opt-out/STOP) and delivery reports. See docs/MULTICHANNEL_MARKETING.md to set up Telnyx.")}</p>
      <ChannelConnectionCard channel="sms" initial={JSON.parse(JSON.stringify(active))} templates={templates.map((t) => ({ id: t.id, name: t.name, channel: t.channel }))} isOwner={session?.user?.role === "owner"} />
    </div>
  );
}, "sms");
