import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { listChannelCredentials } from "@/server/services/channel-credential-service";
import { listSenderOptions } from "@/server/providers/provider-registry";
import { getActiveProviderSummary } from "@/server/services/provider-credential-service";

/** Sender profiles per channel for the builder's info step (active connections only, secrets never included). */
export const GET = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const ch = z.enum(["whatsapp", "sms", "email"]).safeParse(new URL(request.url).searchParams.get("channel"));
  if (!ch.success) return Response.json({ error: "ערוץ לא תקין" }, { status: 400 });
  if (ch.data === "whatsapp") {
    const [senders, summary] = await Promise.all([listSenderOptions(), getActiveProviderSummary()]);
    return Response.json({ channel: "whatsapp", mock: summary.provider === "mock", senders: senders.map((s) => ({ id: s.id, label: s.label, phone: s.displayPhoneNumber, isDefault: s.isDefault, sendingBlocked: s.sendingBlocked })) });
  }
  const creds = (await listChannelCredentials(ch.data)).filter((c) => c.isActive);
  return Response.json({ channel: ch.data, profiles: creds.map((c) => ({ id: c.id, label: c.label || c.provider, provider: c.provider, simulated: c.simulated, sendingBlocked: c.sendingBlocked, status: c.status, senderName: c.senderName, senderEmail: c.senderEmail, replyTo: c.replyTo, domainStatus: c.domainStatus, senders: c.senders, testRecipients: c.testRecipients, capabilities: c.capabilities, unitPrice: c.unitPrice, currency: c.unitPriceCurrency })) });
});
