/**
 * SMS / email provider connections per business. Secrets are sealed before they touch the
 * database and are never returned to the browser (masked). Saving a key is not "connected":
 * every save runs the provider check and the status/`sendingBlocked` reflect its result.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/response";
import { maskSecret } from "@/lib/crypto";
import { normalizePhone } from "@/lib/phone";
import type { SessionUser } from "@/lib/auth";
import { EMAIL_SECRET_KEYS, SMS_SECRET_KEYS, emailProviderFor, openConfig, sealConfig, smsProviderFor } from "@/server/channels/registry";
import type { Prisma, ProviderCredential } from "@/generated/prisma/client";
import type { ConnectionReport, SmsSender } from "@/server/channels/types";

const emailField = z.string().trim().toLowerCase().email().max(200);
export const smsCredentialSchema = z.object({
  provider: z.enum(["telnyx_sms", "mock_sms"]),
  label: z.string().trim().max(100).optional(),
  apiKey: z.string().trim().max(500).optional(),
  messagingProfileId: z.string().trim().max(200).optional(),
  publicKey: z.string().trim().max(500).optional(),
  senders: z.array(z.object({ value: z.string().trim().min(1).max(40), type: z.enum(["number", "alphanumeric"]), inbound: z.boolean().default(false), label: z.string().max(60).optional() })).max(20).optional(),
  testRecipients: z.array(z.string().trim().min(3).max(40)).max(10).optional(),
  unitPrice: z.number().min(0).max(100).nullable().optional(),
  unitPriceCurrency: z.string().trim().length(3).toUpperCase().optional(),
});
export const emailCredentialSchema = z.object({
  provider: z.enum(["resend", "mock_email"]),
  label: z.string().trim().max(100).optional(),
  apiKey: z.string().trim().max(500).optional(),
  webhookSecret: z.string().trim().max(500).optional(),
  senderName: z.string().trim().min(1).max(100),
  senderEmail: emailField,
  replyTo: emailField.nullable().optional(),
  testRecipients: z.array(emailField).max(10).optional(),
  unitPrice: z.number().min(0).max(100).nullable().optional(),
  unitPriceCurrency: z.string().trim().length(3).toUpperCase().optional(),
});

export function webhookUrlFor(c: Pick<ProviderCredential, "id" | "channel" | "provider">) {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/webhooks/${c.channel}/${c.provider.replace(/_(sms|email)$/, "")}/${c.id}`;
}

export function credentialView(c: ProviderCredential) {
  const cfg = openConfig(c.config);
  return {
    id: c.id, channel: c.channel, provider: c.provider, label: c.label, isActive: c.isActive, isDefault: c.isDefault, status: c.status, sendingBlocked: c.sendingBlocked,
    lastCheckedAt: c.lastCheckedAt, lastWebhookAt: c.lastWebhookAt, lastOutboundTestAt: c.lastOutboundTestAt, lastConnectionError: c.lastConnectionError,
    senderName: c.senderName, senderEmail: c.senderEmail, replyTo: c.replyTo, domainName: c.domainName, domainId: c.domainId, domainStatus: c.domainStatus, domainRecords: c.domainRecords, domainCheckedAt: c.domainCheckedAt,
    senders: c.senders, capabilities: c.capabilities, testRecipients: c.testRecipients, unitPrice: c.unitPrice ? Number(c.unitPrice) : null, unitPriceCurrency: c.unitPriceCurrency,
    config: { apiKeyMasked: maskSecret(cfg.apiKey), messagingProfileId: cfg.messagingProfileId ?? null, publicKeyMasked: maskSecret(cfg.publicKey), webhookSecretMasked: maskSecret(cfg.webhookSecret) },
    webhookUrl: webhookUrlFor(c), simulated: c.provider.startsWith("mock"),
  };
}

export async function listChannelCredentials(channel: "sms" | "email") {
  const rows = await prisma.providerCredential.findMany({ where: { channel }, orderBy: [{ isActive: "desc" }, { createdAt: "asc" }] });
  return rows.map(credentialView);
}

async function runCheck(c: ProviderCredential): Promise<ConnectionReport> {
  try { return c.channel === "sms" ? await smsProviderFor(c).check() : await emailProviderFor(c).check(); }
  catch (err) { return { ok: false, checks: [{ label: "בדיקת חיבור", ok: false, detail: (err as Error).message }], error: (err as Error).message, capabilities: { inbound: false, deliveryReports: false, opens: false, clicks: false, bounces: false, complaints: false, suppressionSync: false, cancelQueued: false, alphanumericSender: false, unicode: true, cost: false } }; }
}

function statusFromReport(c: Pick<ProviderCredential, "channel" | "domainStatus" | "provider">, r: ConnectionReport) {
  if (!r.ok) return "error" as const;
  if (c.channel === "email" && !c.provider.startsWith("mock") && c.domainStatus !== "verified") return "connected_not_ready" as const;
  return "connected" as const;
}

export async function saveChannelCredential(user: SessionUser, channel: "sms" | "email", raw: unknown) {
  const input = channel === "sms" ? smsCredentialSchema.parse(raw) : emailCredentialSchema.parse(raw);
  const existing = await prisma.providerCredential.findFirst({ where: { channel, provider: input.provider } });
  const prev = existing ? openConfig(existing.config) : {};
  const secretKeys = channel === "sms" ? SMS_SECRET_KEYS : EMAIL_SECRET_KEYS;
  const config: Record<string, unknown> = { ...prev };
  if ("apiKey" in input && input.apiKey) config.apiKey = input.apiKey;
  if ("publicKey" in input && input.publicKey) config.publicKey = input.publicKey;
  if ("webhookSecret" in input && input.webhookSecret) config.webhookSecret = input.webhookSecret;
  if ("messagingProfileId" in input && input.messagingProfileId !== undefined) config.messagingProfileId = input.messagingProfileId;
  if (input.provider.startsWith("mock") && !config.webhookSecret) config.webhookSecret = `mock-${crypto.randomUUID()}`;
  if (!input.provider.startsWith("mock") && !config.apiKey) throw new ApiError("נדרש מפתח API של הספק", 400, "api_key_required");
  const senders: SmsSender[] | undefined = "senders" in input && input.senders ? input.senders.map((s) => ({ id: s.value, type: s.type, value: s.type === "number" ? (normalizePhone(s.value) ?? s.value) : s.value, inbound: s.type === "number" ? s.inbound : false, label: s.label })) : undefined;
  const testRecipients = input.testRecipients?.map((t) => (channel === "sms" ? normalizePhone(t) ?? t : t.toLowerCase()));
  const data: Prisma.ProviderCredentialUncheckedUpdateInput = {
    label: input.label ?? existing?.label ?? null, config: sealConfig(config, secretKeys) as Prisma.InputJsonValue, connectionMethod: "manual",
    ...(senders ? { senders: senders as unknown as Prisma.InputJsonValue } : {}), ...(testRecipients ? { testRecipients } : {}),
    unitPrice: input.unitPrice ?? null, unitPriceCurrency: input.unitPriceCurrency ?? existing?.unitPriceCurrency ?? null,
    ...(channel === "email" ? { senderName: (input as z.infer<typeof emailCredentialSchema>).senderName, senderEmail: (input as z.infer<typeof emailCredentialSchema>).senderEmail, replyTo: (input as z.infer<typeof emailCredentialSchema>).replyTo ?? null } : {}),
  };
  const row = await prisma.$transaction(async (tx) => {
    // One active connection per channel: activating this one deactivates the others of the channel.
    await tx.providerCredential.updateMany({ where: { channel, isActive: true, ...(existing ? { id: { not: existing.id } } : {}) }, data: { isActive: false, isDefault: false } });
    return existing
      ? tx.providerCredential.update({ where: { id: existing.id }, data: { ...data, isActive: true, isDefault: true } })
      : tx.providerCredential.create({ data: { ...(data as Omit<Prisma.ProviderCredentialUncheckedCreateInput, "businessId" | "provider" | "channel">), businessId: user.businessId, channel, provider: input.provider, isActive: true, isDefault: true } });
  });
  const checked = await checkChannelCredential(user, row.id);
  await audit(user.businessId, user.id, "provider", row.id, "channel.credential_saved", { channel, provider: input.provider, ok: checked.report.ok });
  return checked;
}

export async function checkChannelCredential(user: SessionUser, id: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id, channel: { in: ["sms", "email"] } } });
  if (!c) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  const report = await runCheck(c);
  const merged: SmsSender[] | undefined = c.channel === "sms" ? mergeSenders((c.senders as SmsSender[] | null) ?? [], report.senders ?? []) : undefined;
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: {
    lastCheckedAt: new Date(), lastConnectionError: report.ok ? null : report.error ?? report.checks.filter((x) => !x.ok).map((x) => `${x.label}: ${x.detail ?? ""}`).join("; "),
    sendingBlocked: !report.ok, status: statusFromReport(c, report), capabilities: report.capabilities as unknown as Prisma.InputJsonValue,
    ...(merged ? { senders: merged as unknown as Prisma.InputJsonValue } : {}),
  } });
  await audit(user.businessId, user.id, "provider", c.id, "channel.connection_checked", { channel: c.channel, ok: report.ok, checks: report.checks });
  return { credential: credentialView(updated), report };
}

function mergeSenders(configured: SmsSender[], discovered: SmsSender[]) {
  const out = new Map<string, SmsSender>();
  for (const s of discovered) out.set(s.value, s);
  for (const s of configured) if (!out.has(s.value)) out.set(s.value, s);
  return [...out.values()];
}

export async function disconnectChannelCredential(user: SessionUser, id: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id, channel: { in: ["sms", "email"] } } });
  if (!c) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  const running = await prisma.campaign.count({ where: { providerCredentialId: c.id, status: { in: ["RUNNING", "SCHEDULED"] } } });
  if (running) throw new ApiError("יש קמפיינים פעילים/מתוזמנים על חיבור זה. השהה או בטל אותם לפני ניתוק", 409, "campaigns_active");
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { isActive: false, isDefault: false, status: "disconnected", sendingBlocked: true } });
  await audit(user.businessId, user.id, "provider", c.id, "channel.disconnected", { channel: c.channel, provider: c.provider });
  return credentialView(updated);
}

export async function connectSendingDomain(user: SessionUser, id: string, domain: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id, channel: "email" } });
  if (!c) throw new ApiError("החיבור לא נמצא", 404, "not_found");
  const name = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw new ApiError("שם דומיין לא תקין", 400, "invalid_domain");
  const provider = emailProviderFor(c);
  if (!provider.domains) {
    const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { domainName: name, domainStatus: "unsupported", domainRecords: [] as unknown as Prisma.InputJsonValue, domainCheckedAt: new Date() } });
    return credentialView(updated);
  }
  const info = c.domainId && c.domainName === name ? await provider.domains.get(c.domainId) : await provider.domains.create(name);
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { domainName: info.name, domainId: info.id, domainStatus: info.status, domainRecords: info.records as unknown as Prisma.InputJsonValue, domainCheckedAt: new Date(), status: info.status === "verified" && !c.sendingBlocked ? "connected" : c.sendingBlocked ? "error" : "connected_not_ready" } });
  await audit(user.businessId, user.id, "provider", c.id, "channel.domain_connected", { domain: info.name, status: info.status });
  return credentialView(updated);
}

export async function verifySendingDomain(user: SessionUser, id: string) {
  const c = await prisma.providerCredential.findFirst({ where: { id, channel: "email" } });
  if (!c || !c.domainId) throw new ApiError("לא הוגדר דומיין שולח", 404, "not_found");
  const provider = emailProviderFor(c);
  if (!provider.domains) throw new ApiError("הספק אינו תומך באימות דומיין", 400, "unsupported");
  const info = await provider.domains.verify(c.domainId);
  const updated = await prisma.providerCredential.update({ where: { id: c.id }, data: { domainStatus: info.status, domainRecords: info.records as unknown as Prisma.InputJsonValue, domainCheckedAt: new Date(), status: info.status === "verified" && !c.sendingBlocked ? "connected" : c.sendingBlocked ? "error" : "connected_not_ready" } });
  await audit(user.businessId, user.id, "provider", c.id, "channel.domain_verified", { domain: c.domainName, status: info.status });
  return credentialView(updated);
}
