/**
 * Resolve the SMS / email provider of the current business from its ProviderCredential rows.
 * Config secrets are sealed at rest (AES-256-GCM) and decrypted only here.
 */
import { prisma } from "@/lib/db";
import { openSecret, sealSecret } from "@/lib/crypto";
import type { ProviderCredential } from "@/generated/prisma/client";
import { TelnyxSmsProvider } from "./sms/telnyx-sms";
import { ResendEmailProvider } from "./email/resend-email";
import { MockEmailProvider, MockSmsProvider } from "./mock";
import type { EmailProvider, SmsProvider, SmsSender } from "./types";

export class ChannelUnavailableError extends Error {}

export const SMS_SECRET_KEYS = ["apiKey", "publicKey", "webhookSecret"] as const;
export const EMAIL_SECRET_KEYS = ["apiKey", "webhookSecret"] as const;

export function openConfig(config: unknown): Record<string, string | undefined> {
  const c = (config ?? {}) as Record<string, unknown>;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c)) out[k] = typeof v === "string" ? openSecret(v) : v === null || v === undefined ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v);
  return out;
}

export function sealConfig(config: Record<string, unknown>, secretKeys: readonly string[]) {
  const out: Record<string, unknown> = { ...config };
  for (const k of secretKeys) { const v = config[k]; if (typeof v === "string" && v && !v.startsWith("enc:v1:")) out[k] = sealSecret(v); }
  return out;
}

export function smsProviderFor(c: Pick<ProviderCredential, "provider" | "config" | "senders">): SmsProvider {
  const cfg = openConfig(c.config);
  if (c.provider === "telnyx_sms") return new TelnyxSmsProvider({ apiKey: cfg.apiKey ?? "", messagingProfileId: cfg.messagingProfileId ?? "", publicKey: cfg.publicKey ?? "", senders: (c.senders as SmsSender[] | null) ?? [] });
  if (c.provider === "mock_sms") return new MockSmsProvider(cfg.webhookSecret);
  throw new ChannelUnavailableError(`ספק SMS לא נתמך: ${c.provider}`);
}

export function emailProviderFor(c: Pick<ProviderCredential, "provider" | "config">): EmailProvider {
  const cfg = openConfig(c.config);
  if (c.provider === "resend") return new ResendEmailProvider({ apiKey: cfg.apiKey ?? "", webhookSecret: cfg.webhookSecret });
  if (c.provider === "mock_email") return new MockEmailProvider(cfg.webhookSecret);
  throw new ChannelUnavailableError(`ספק אימייל לא נתמך: ${c.provider}`);
}

/** Active credential of a channel for the current business (default first). */
export async function activeChannelCredential(channel: "sms" | "email", credentialId?: string | null) {
  const c = await prisma.providerCredential.findFirst({ where: { channel, isActive: true, ...(credentialId ? { id: credentialId } : {}) }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!c) throw new ChannelUnavailableError(channel === "sms" ? "אין ספק SMS מחובר. חבר ספק בהגדרות → חיבורים" : "אין ספק אימייל מחובר. חבר ספק בהגדרות → חיבורים");
  if (c.sendingBlocked) throw new ChannelUnavailableError(`השליחה בערוץ חסומה: ${c.lastConnectionError ?? "בדוק את החיבור"}`);
  return c;
}

export function isMockCredential(c: Pick<ProviderCredential, "provider">) {
  return c.provider === "mock_sms" || c.provider === "mock_email";
}
