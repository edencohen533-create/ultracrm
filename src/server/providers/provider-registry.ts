import { prisma } from "@/lib/db";
import { MockWhatsAppProvider } from "./mock-whatsapp-provider";
import { MetaWhatsAppProvider } from "./meta-whatsapp-provider";
import { metaConfigOf } from "@/lib/meta/graph";
import type { WhatsAppProvider } from "./whatsapp-provider";
import type { Session } from "@/lib/auth-compat";

const mockProvider = new MockWhatsAppProvider();
export class ProviderUnavailableError extends Error {}

/** undefined selects a default for NEW work; a string/null pins an existing sender. */
export async function resolveSender(credentialId?: string | null, allowInactive = false) {
  if (credentialId === null) {
    if (!allowInactive && await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api" }, select: { id: true } })) throw new ProviderUnavailableError("זו שיחת הדגמה. יש לפתוח שיחה דרך מספר WhatsApp מחובר");
    return null;
  }
  const active = await prisma.providerCredential.findFirst({
    where: credentialId ? { id: credentialId, ...(!allowInactive ? { isActive: true } : {}) } : { isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!active && credentialId) throw new ProviderUnavailableError("המספר השולח נותק או שאינו נגיש. יש לחבר את אותו מספר מחדש");
  if (active?.sendingBlocked && !allowInactive) throw new ProviderUnavailableError("השליחה במספר זה חסומה. יש לבדוק Token והרשאות");
  return active;
}
export async function getActiveProvider(credentialId?: string | null, allowInactive = false): Promise<WhatsAppProvider> {
  const active = await resolveSender(credentialId, allowInactive);
  if (!active || active.provider === "mock") return mockProvider;
  if (active.provider === "meta_whatsapp_cloud_api") return new MetaWhatsAppProvider(metaConfigOf(active.config), active.id);
  throw new ProviderUnavailableError("ספק המספר אינו נתמך");
}
export function getMockProvider(): MockWhatsAppProvider { return mockProvider; }

export async function listSenderOptions(session?: Session | null) {
  const senders = await prisma.providerCredential.findMany({
    where: { isActive: true, provider: "meta_whatsapp_cloud_api", ...(session?.user.role === "agent" ? { OR: [{ teamId: null }, ...(session.user.teamId ? [{ teamId: session.user.teamId }] : [])] } : {}) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, label: true, displayPhoneNumber: true, phoneNumberId: true, teamId: true, isDefault: true, sendingBlocked: true },
  });
  return senders.map((sender) => ({ ...sender, label: sender.label || sender.displayPhoneNumber || `WhatsApp ${sender.phoneNumberId ?? ""}` }));
}
