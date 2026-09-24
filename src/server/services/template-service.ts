import { prisma } from "@/lib/db";

export async function listTemplates() {
  return prisma.template.findMany({ where: { channel: "whatsapp" }, orderBy: { createdAt: "asc" } });
}
/** WhatsApp templates that can be sent right now (Meta-approved on the connected account). */
export async function listSendableTemplates() {
  const provider = await prisma.providerCredential.findFirst({ where: { isActive: true, channel: "whatsapp" }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const config = provider?.config as Record<string, string> | undefined;
  if (provider?.provider === "meta_whatsapp_cloud_api" && !config?.businessAccountId) return [];
  return prisma.template.findMany({ where: {
    status: "APPROVED", channel: "whatsapp",
    ...(provider?.provider === "meta_whatsapp_cloud_api" ? { providerAccountId: config!.businessAccountId, providerTemplateId: { not: null } } : {}),
  }, orderBy: [{ name: "asc" }, { language: "asc" }] });
}
