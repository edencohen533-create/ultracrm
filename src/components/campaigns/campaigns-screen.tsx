import { listSenderOptions } from "@/server/providers/provider-registry";
import { organizationRequest } from "@/lib/auth-compat";
import { listSendableTemplates } from "@/server/services/template-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { listChannelCredentials } from "@/server/services/channel-credential-service";
import { campaignActor } from "@/lib/campaign-auth";
import { prisma } from "@/lib/db";
import { CampaignDashboard } from "@/components/campaigns/campaign-dashboard";
import { listCampaigns } from "@/server/services/campaign-service";
import { getActiveProviderSummary } from "@/server/services/provider-credential-service";
import { getBusinessSettings } from "@/lib/settings";
import { requireBusinessId } from "@/lib/tenant";

type ChannelKey = "whatsapp" | "sms" | "email";

/** Server loader shared by /audiences and /campaigns/{whatsapp,email,sms}: same data, different slice of the dashboard. */
export const CampaignsScreen = organizationRequest(async function CampaignsScreen({ mode, fixedChannel }: { mode: "audiences" | "campaigns"; fixedChannel?: ChannelKey }) {
  if (!await campaignActor()) return <p className="p-6">הגישה לקמפיינים מיועדת למנהלים בלבד.</p>;
  const [campaigns, lists, contacts, templates, provider, senders, tags, agents, channelTemplates, smsCreds, emailCreds, settings] = await Promise.all([
    listCampaigns(),
    prisma.distributionList.findMany({ orderBy: { createdAt: "desc" }, include: { members: { select: { contactId: true } }, _count: { select: { members: true } } } }),
    prisma.contact.findMany({ orderBy: { fullName: "asc" }, take: 1000, select: { id: true, fullName: true, phoneE164: true, consentStatus: true } }).then((rows) => rows.map((c) => ({ id: c.id, name: c.fullName, phone: c.phoneE164, consentStatus: c.consentStatus }))),
    listSendableTemplates(),
    getActiveProviderSummary(),
    listSenderOptions(),
    prisma.tag.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }).then((rows) => rows.map((u) => ({ id: u.id, name: u.fullName }))),
    listChannelTemplates(),
    listChannelCredentials("sms"),
    listChannelCredentials("email"),
    getBusinessSettings(requireBusinessId()),
  ]);
  const sms = smsCreds.find((c) => c.isActive) ?? null;
  const email = emailCreds.find((c) => c.isActive) ?? null;
  const channels = {
    sms: sms ? { id: sms.id, provider: sms.provider, simulated: sms.simulated, sendingBlocked: sms.sendingBlocked, status: sms.status, senders: (sms.senders as Array<{ value: string; type: string; inbound: boolean }> | null) ?? [], testRecipients: (sms.testRecipients as string[] | null) ?? [], unitPrice: sms.unitPrice, currency: sms.unitPriceCurrency, label: sms.label ?? sms.provider } : null,
    email: email ? { id: email.id, provider: email.provider, simulated: email.simulated, sendingBlocked: email.sendingBlocked, status: email.status, domainStatus: email.domainStatus, sender: `${email.senderName ?? ""} <${email.senderEmail ?? ""}>`, testRecipients: (email.testRecipients as string[] | null) ?? [], unitPrice: email.unitPrice, currency: email.unitPriceCurrency, label: email.label ?? email.provider } : null,
  };
  return <CampaignDashboard mode={mode} fixedChannel={fixedChannel} initialCampaigns={JSON.parse(JSON.stringify(campaigns))} lists={lists} contacts={contacts} templates={templates} channelTemplates={JSON.parse(JSON.stringify(channelTemplates))} channels={channels} timezone={settings.timezone} marketingWindow={settings.marketing.window} audienceOptions={{ tags, agents, campaigns: campaigns.map(({ id, name }) => ({ id, name })) }} mock={provider.provider === "mock"} senders={senders} />;
});
